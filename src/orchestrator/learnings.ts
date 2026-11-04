// design-v2 §6.2 wiring: learning proposals for dismissed threads, with `learnings.propose` on.
//
// Inputs are what the run already has: our review threads (with replies and the commit of the
// first comment), myrabbit's previous review bodies, and `.myrabbit/learnings.md` at the BASE sha.
// At most MAX_PROPOSAL_CALLS engine calls; a failed call yields no proposal and never fails the run.
// The result goes to the run document; rendering it in the body is P1's.

import { LEARNINGS_PATH, parseLearnings, type GitReader } from "../config/index.js";
import { runEngine } from "../engines/index.js";
import {
  incrementalDiff,
  isBotLogin,
  isBotActor,
  parseProposalMarkers,
  type DiffFile,
  type GitRunner,
  type Hunk,
  type ReviewSummary,
  type ReviewThread,
} from "../github/index.js";
import {
  anchorUnchanged,
  buildLearningPrompt,
  LEARNING_OUTPUT_SCHEMA,
  parseLearningOutput,
  selectProposals,
  toProposal,
  type LearningThread,
  type ThreadReply,
} from "../learnings/index.js";
import type { PriorThread } from "../merge/index.js";
import type { PromptContext, Templates } from "../prompts/builder.js";
import type { Engine, ProposedLearning } from "../types.js";
import { errorText, type Log } from "./log.js";

/** Fingerprints in proposal markers of reviews authored by the bot (REST login match only). */
export function alreadyProposed(reviews: readonly ReviewSummary[], botLogin: string): Set<string> {
  const out = new Set<string>();
  for (const r of reviews) {
    if (!isBotLogin(r.user, botLogin)) continue;
    for (const fp of parseProposalMarkers(r.body)) out.add(fp);
  }
  return out;
}

/** Section titles of `.myrabbit/learnings.md` at `baseSha`; [] when it is missing or unreadable. */
export async function existingLearningTitles(reader: GitReader, baseSha: string, log: Log): Promise<string[]> {
  try {
    const raw = await reader.showFile(baseSha, LEARNINGS_PATH);
    return raw === null ? [] : parseLearnings(raw).map((l) => l.title);
  } catch (err) {
    log(`learnings: cannot read ${LEARNINGS_PATH}: ${errorText(err)}`);
    return [];
  }
}

export function threadReplies(thread: ReviewThread, botLogin: string): ThreadReply[] {
  return thread.replies.map((c) => ({
    author: c.author?.login ?? null,
    authorIsBot: c.author?.__typename === "Bot" || isBotActor(c.author, botLogin),
    body: c.body,
  }));
}

/**
 * Whether the code at the thread's original anchor is unchanged from the finding's commit to
 * `head`. Unknown is "changed": no commit, a LEFT-side anchor, no original line, or a diff that
 * fails (commit force-pushed away).
 */
export async function threadAnchorUnchanged(
  thread: ReviewThread,
  head: string,
  diffFrom: (commit: string) => Promise<DiffFile[] | null>,
): Promise<boolean> {
  const commit = thread.originalCommit;
  const end = thread.originalLine;
  if (commit === null || end === null || thread.side !== "RIGHT") return false;
  const start = thread.originalStartLine ?? end;
  if (commit === head) return true;
  const files = await diffFrom(commit);
  if (files === null) return false;
  const file = files.find((f) => f.oldPath === thread.path || f.path === thread.path);
  if (file === undefined) return anchorUnchanged(null, start, end);
  const changed = file.status === "deleted" || file.status === "renamed" || file.binary;
  return anchorUnchanged(file.hunks.flatMap(changedRanges), Math.min(start, end), Math.max(start, end), changed);
}

/**
 * The old-side lines a hunk really changes, without its context lines (git diff runs with context):
 * one range per deleted line, and an insertion point (`oldLines: 0`, after `oldStart`) per added line.
 */
export function changedRanges(hunk: Hunk): Pick<Hunk, "oldStart" | "oldLines">[] {
  const out: Pick<Hunk, "oldStart" | "oldLines">[] = [];
  let next = hunk.oldStart;
  for (const l of hunk.lines) {
    if (l.kind === "add") {
      out.push({ oldStart: next - 1, oldLines: 0 });
    } else if (l.oldLine !== null) {
      if (l.kind === "del") out.push({ oldStart: l.oldLine, oldLines: 1 });
      next = l.oldLine + 1;
    }
  }
  return out;
}

export interface ProposeOptions {
  /** Our threads and their priors, index-aligned, with this run's resolve state applied. */
  threads: readonly ReviewThread[];
  priors: readonly PriorThread[];
  reviews: readonly ReviewSummary[];
  botLogin: string;
  trustedAuthors: readonly string[];
  /** Engines whose review succeeded in this run. */
  engines: readonly Engine[];
  git: GitRunner;
  baseSha: string;
  headSha: string;
  existingTitles: readonly string[];
  context: PromptContext;
  templates: Templates;
  learningTemplate: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  log: Log;
}

export async function proposeLearnings(o: ProposeOptions): Promise<ProposedLearning[]> {
  const proposed = alreadyProposed(o.reviews, o.botLogin);
  const diffs = new Map<string, Promise<DiffFile[] | null>>();
  const diffFrom = (commit: string): Promise<DiffFile[] | null> => {
    let d = diffs.get(commit);
    if (d === undefined) {
      d = incrementalDiff(o.git, commit, o.headSha, o.baseSha).then(
        (r) => r.files,
        () => null,
      );
      diffs.set(commit, d);
    }
    return d;
  };

  const threads: LearningThread[] = [];
  for (const [i, prior] of o.priors.entries()) {
    const thread = o.threads[i];
    // Only threads that could qualify cost a diff.
    if (thread === undefined || prior.state !== "dismissed" || thread.replies.length === 0) continue;
    if (proposed.has(prior.marker.fp)) continue;
    threads.push({
      prior,
      replies: threadReplies(thread, o.botLogin),
      anchorUnchanged: await threadAnchorUnchanged(thread, o.headSha, diffFrom),
    });
  }

  const requests = selectProposals(
    threads,
    o.trustedAuthors,
    o.engines.map((e) => e.name),
    { alreadyProposed: proposed },
  );
  const out: ProposedLearning[] = [];
  for (const req of requests) {
    const engine = o.engines.find((e) => e.name === req.engine);
    if (engine === undefined) continue;
    const built = buildLearningPrompt(req, o.context, o.learningTemplate, o.templates);
    const res = await runEngine(
      engine,
      {
        task: "learning",
        systemPrompt: built.systemPrompt,
        prompt: built.prompt,
        outputSchema: LEARNING_OUTPUT_SCHEMA,
        parse: parseLearningOutput,
        cwd: o.cwd,
      },
      { timeoutMs: o.timeoutMs, signal: o.signal },
    );
    if (!res.ok) {
      o.log(`learnings: proposal call failed (${res.engine}: ${res.error.kind}); skipped`);
      continue;
    }
    const p = toProposal(req, res.output, o.existingTitles);
    if (p !== null) out.push(p);
  }
  o.log(`learnings: ${requests.length} proposal call(s), ${out.length} proposal(s)`);
  return out;
}

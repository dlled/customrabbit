// §6.2 proposal selection (design-v2). No database and no new permission: the inputs are the
// review threads the resolve step already fetches.
//
// A thread qualifies when all of these hold:
//   - a human resolved it (state `dismissed`, v1 Q9);
//   - the code at its anchor did not change between the finding's head and this run's head;
//   - a reply by a login in `trusted_authors` (not a bot) is in the thread.
// Whether the reply actually disagrees, and with what generalisable rule, is decided by one call to
// the engine that wrote the finding (prompt.ts); that call can answer "no proposal". At most
// MAX_PROPOSAL_CALLS calls per run.

import type { Hunk } from "../github/diff.js";
import type { PriorThread } from "../merge/types.js";
import { severityRank } from "../merge/severity.js";
import type { EngineName } from "../types.js";

/** §6.2: proposal calls per run. */
export const MAX_PROPOSAL_CALLS = 3;
/** Trusted replies given to the engine per thread (the latest ones). */
export const MAX_REPLIES = 3;
/** Characters kept of each reply. */
export const MAX_REPLY_CHARS = 2_000;

/** A comment after the first one in a review thread. */
export interface ThreadReply {
  /** Login, or null for a deleted user. */
  author: string | null;
  /** GitHub `__typename` is Bot, or the login ends in `[bot]`. */
  authorIsBot: boolean;
  body: string;
}

export interface LearningThread {
  /** The prior thread, with this run's resolve state applied. */
  prior: PriorThread;
  /** Replies in thread order, without the first (myrabbit's) comment. */
  replies: readonly ThreadReply[];
  /** From {@link anchorUnchanged} over the finding's head..this run's head diff of the file. */
  anchorUnchanged: boolean;
}

export interface ProposalRequest {
  prior: PriorThread;
  /** Trusted replies, oldest first, at most MAX_REPLIES, each cut to MAX_REPLY_CHARS. */
  replies: ThreadReply[];
  /** The engine that wrote the finding (or, if it did not run this time, another that did). */
  engine: EngineName;
}

/** GitHub logins are case-insensitive. */
function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isTrusted(r: ThreadReply, trustedAuthors: readonly string[]): boolean {
  if (r.authorIsBot || r.author === null || /\[bot\]$/i.test(r.author)) return false;
  const author = r.author;
  return r.body.trim() !== "" && trustedAuthors.some((t) => sameLogin(t, author));
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return `${out}…`;
}

export interface SelectOptions {
  /** Default {@link MAX_PROPOSAL_CALLS}. */
  budget?: number;
  /**
   * Fingerprints already proposed in an earlier run, read back from the
   * `<!-- myrabbit:proposal v=1 fp=<fp> -->` markers of myrabbit's previous review bodies. A
   * dismissed thread stays dismissed, so without this it would cost a call on every run.
   */
  alreadyProposed?: ReadonlySet<string>;
}

/**
 * The proposal calls for this run: qualifying threads, blocking and more severe first, at most
 * `budget`. `available` lists the engines usable in this run; a thread whose engines are all
 * unavailable falls back to the first available one, and with none nothing is selected.
 */
export interface SelectOptions {
  /** Default {@link MAX_PROPOSAL_CALLS}. */
  budget?: number;
  /**
   * Fingerprints already proposed in an earlier run, read back from the
   * `<!-- myrabbit:proposal v=1 fp=<fp> -->` markers of myrabbit's previous review bodies. A
   * dismissed thread stays dismissed, so without this it would cost a call on every run.
   */
  alreadyProposed?: ReadonlySet<string>;
}

export function selectProposals(
  threads: readonly LearningThread[],
  trustedAuthors: readonly string[],
  available: readonly EngineName[],
  options: SelectOptions = {},
): ProposalRequest[] {
  const fallback = available[0];
  if (fallback === undefined) return [];
  const budget = options.budget ?? MAX_PROPOSAL_CALLS;
  const proposed = options.alreadyProposed;
  const picked = threads
    .map((t, index) => ({ t, index }))
    .filter(
      ({ t }) => t.prior.state === "dismissed" && t.anchorUnchanged && proposed?.has(t.prior.marker.fp) !== true,
    )
    .map(({ t, index }) => {
      const replies = t.replies
        .filter((r) => isTrusted(r, trustedAuthors))
        .slice(-MAX_REPLIES)
        .map((r) => ({ ...r, body: cut(r.body.trim(), MAX_REPLY_CHARS) }));
      const engine = t.prior.sources.find((e) => available.includes(e)) ?? fallback;
      return { request: { prior: t.prior, replies, engine }, index };
    })
    .filter(({ request }) => request.replies.length > 0);
  picked.sort(
    (a, b) =>
      Number(b.request.prior.marker.blk) - Number(a.request.prior.marker.blk) ||
      severityRank(a.request.prior.marker.sev) - severityRank(b.request.prior.marker.sev) ||
      a.index - b.index,
  );
  return picked.slice(0, Math.max(0, Math.floor(budget))).map((p) => p.request);
}

/**
 * True when no hunk of the finding-head..head diff of the thread's file touches the finding's
 * original lines `start..end` (old side of that diff). `hunks` is null when the file is not in that
 * diff (unchanged). A deleted or renamed file is never unchanged; pass `changed: true` for it.
 */
export function anchorUnchanged(
  hunks: readonly Pick<Hunk, "oldStart" | "oldLines">[] | null,
  start: number,
  end: number = start,
  changed = false,
): boolean {
  if (changed) return false;
  if (hunks === null) return true;
  return !hunks.some((h) => {
    // A pure insertion (oldLines 0) sits after old line oldStart: it touches oldStart..oldStart+1.
    const from = h.oldStart;
    const to = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart + h.oldLines - 1;
    return from <= end && to >= start;
  });
}

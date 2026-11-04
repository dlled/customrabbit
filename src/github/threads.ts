// Review threads via GraphQL (design §8.4).

import { CATEGORIES, ENGINE_NAMES, type Category, type EngineName, type FindingMarker, type Side } from "../types.js";
import type { GitHub, RepoRef } from "./client.js";
import { assertSha } from "./git.js";
import { parseFindingMarker } from "./markers.js";
import { isBotActor } from "./reviews.js";

export interface Actor {
  login: string;
  __typename?: string;
}

export interface ThreadComment {
  /** GraphQL node id. */
  id: string;
  /** REST id, for PATCH /pulls/comments/{id}. */
  databaseId: number;
  body: string;
  author: Actor | null;
  /** The commit the comment was written on (null when GitHub no longer has it). */
  originalCommit?: { oid: string } | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  /** Current line (null when outdated past the diff). */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  side: Side;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  firstComment: ThreadComment | null;
  /** Finding marker of the first comment, when that comment is ours. */
  marker: FindingMarker | null;
  /** First comment is by the bot and carries an `f` marker. */
  ours: boolean;
  /** Resolved by someone other than the bot (Q9: counts as a dismissal). */
  humanResolved: boolean;
  /** Our comment already carries the "✅ Addressed in" note. */
  addressed: boolean;
  /** Comments after the first, oldest first (at most MAX_THREAD_REPLIES; design-v2 §6.2). */
  replies: ThreadComment[];
  /** Commit of the first comment, lowercase 40-hex, or null when unknown. */
  originalCommit: string | null;
}

/** Replies fetched per thread after the first comment (design-v2 §6.2 reads the latest trusted ones). */
export const MAX_THREAD_REPLIES = 20;

const THREADS_QUERY = /* GraphQL */ `
  query myrabbitThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            line
            startLine
            originalLine
            originalStartLine
            diffSide
            isResolved
            isOutdated
            resolvedBy { login }
            comments(first: ${MAX_THREAD_REPLIES + 1}) {
              nodes { id databaseId body author { __typename login } originalCommit { oid } }
            }
          }
        }
      }
    }
  }
`;

interface RawThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: Side;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: { login: string } | null;
  comments: { nodes: (ThreadComment | null)[] | null };
}

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (RawThread | null)[] | null;
      };
    } | null;
  } | null;
}

export const ADDRESSED_PREFIX = "✅ Addressed in ";

export function classifyThread(raw: RawThread, botLogin: string): ReviewThread {
  const first = raw.comments.nodes?.[0] ?? null;
  const byBot = isBotActor(first?.author, botLogin);
  const marker = byBot && first ? parseFindingMarker(first.body) : null;
  const ours = marker !== null;
  const resolver = raw.resolvedBy?.login ?? null;
  // resolvedBy is a User: an App resolving the thread shows up as null. A non-null resolver that is
  // not the bot is a human resolve.
  const humanResolved = raw.isResolved && resolver !== null && !isBotActor({ login: resolver }, botLogin);
  return {
    id: raw.id,
    path: raw.path,
    line: raw.line,
    startLine: raw.startLine,
    originalLine: raw.originalLine,
    originalStartLine: raw.originalStartLine,
    side: raw.diffSide,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    resolvedBy: resolver,
    firstComment: first,
    marker,
    ours,
    humanResolved,
    addressed: ours && first !== null && first.body.includes(ADDRESSED_PREFIX),
    replies: (raw.comments.nodes ?? []).slice(1).flatMap((c) => (c === null ? [] : [c])),
    originalCommit: commitOid(first?.originalCommit?.oid),
  };
}

function commitOid(oid: string | null | undefined): string | null {
  const s = oid?.toLowerCase() ?? "";
  return /^[0-9a-f]{40}$/.test(s) ? s : null;
}

/** All review threads of the PR (paginated, 100 per page, at most `maxPages`). */
export async function listReviewThreads(
  gh: GitHub,
  repo: RepoRef,
  pullNumber: number,
  botLogin: string,
  maxPages = 50,
): Promise<ReviewThread[]> {
  const out: ReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res: ThreadsResponse = await gh.graphql<ThreadsResponse>(THREADS_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
      number: pullNumber,
      after,
    });
    const conn = res.repository?.pullRequest?.reviewThreads;
    if (!conn) throw new Error(`pull request #${pullNumber} not found`);
    for (const n of conn.nodes ?? []) if (n) out.push(classifyThread(n, botLogin));
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`more than ${maxPages * 100} review threads`);
}

const RESOLVE_MUTATION = /* GraphQL */ `
  mutation myrabbitResolve($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
  }
`;

export async function resolveThread(gh: GitHub, threadId: string): Promise<void> {
  await gh.graphql(RESOLVE_MUTATION, { threadId });
}

export async function editReviewComment(gh: GitHub, repo: RepoRef, commentId: number, body: string): Promise<void> {
  await gh.rest.pulls.updateReviewComment({ ...repo, comment_id: commentId, body });
}

/** Insert the addressed note before the trailing finding marker, so the marker stays last. */
export function appendAddressedNote(body: string, shortSha: string): string {
  if (body.includes(ADDRESSED_PREFIX)) return body;
  const note = `${ADDRESSED_PREFIX}${shortSha}`;
  const m = /\n?<!-- myrabbit:f [^<>]*-->\s*$/.exec(body);
  if (!m) return `${body}\n\n${note}`;
  return `${body.slice(0, m.index)}\n\n${note}${body.slice(m.index)}`;
}

export interface MarkAddressedResult {
  edited: boolean;
  resolved: boolean;
  /** Why resolveReviewThread failed (S1 checks whether App tokens may resolve), when it did. */
  resolveError: string | null;
}

/**
 * §8.4: edit our comment to append "✅ Addressed in <short-sha>", then resolve the thread. If the
 * App may not resolve threads, the edit alone marks it addressed in our own state.
 */
export async function markAddressed(
  gh: GitHub,
  repo: RepoRef,
  thread: ReviewThread,
  headSha: string,
): Promise<MarkAddressedResult> {
  if (!thread.ours || !thread.firstComment) throw new Error("markAddressed: not a myrabbit thread");
  assertSha(headSha, "head");
  const shortSha = headSha.slice(0, 7);
  let edited = false;
  if (!thread.addressed) {
    await editReviewComment(gh, repo, thread.firstComment.databaseId, appendAddressedNote(thread.firstComment.body, shortSha));
    edited = true;
  }
  if (thread.isResolved) return { edited, resolved: true, resolveError: null };
  try {
    await resolveThread(gh, thread.id);
    return { edited, resolved: true, resolveError: null };
  } catch (e) {
    const status = typeof e === "object" && e !== null && "status" in e ? String(e.status) : "";
    const name = e instanceof Error ? e.name : "error";
    return { edited, resolved: false, resolveError: `${name}${status ? ` ${status}` : ""}` };
  }
}

// ---------------------------------------------------------------------------
// Mapping to the merge step's PriorThread (src/merge/types.ts). Field names match it exactly;
// src/github does not import src/merge, so the type is declared here.
// ---------------------------------------------------------------------------

export type PriorThreadState = "open" | "addressed" | "dismissed";

export interface PriorThreadData {
  marker: FindingMarker;
  state: PriorThreadState;
  path: string;
  /** First line of the range: current, or original when the thread is outdated. */
  line: number;
  /** Last line for multi-line threads, else null. */
  end_line: number | null;
  side: Side;
  category: Category;
  summary: string;
  body: string;
  /** From the `<sub>found by …</sub>` footer; empty when unknown. */
  sources: EngineName[];
  confidence: number | null;
}

/** Category used when a comment header cannot be parsed; the thread still counts (its marker decides). */
export const FALLBACK_CATEGORY: Category = "correctness";

const HEADER = /^\*\*\[([a-z]+) · ([a-z]+)\]\*\* (.*)$/;
const FOOTER = /<sub>found by ([a-z+]+) · confidence ([0-9.]+)<\/sub>/;
const BODY_END = ["\n\n**Fails when:**", "\n\n```suggestion", "\n\n<sub>", `\n\n${ADDRESSED_PREFIX}`, "\n<!-- myrabbit:f "];

/**
 * Parse an inline comment in the §8.6 layout:
 * `**[sev · category]** title`, body, `**Fails when:**`, optional suggestion, `<sub>found by a+b ·
 * confidence 0.82</sub>`, marker.
 */
export function parseFindingComment(text: string): Pick<PriorThreadData, "category" | "summary" | "body" | "sources" | "confidence"> {
  const nl = text.indexOf("\n");
  const firstLine = (nl < 0 ? text : text.slice(0, nl)).trim();
  const header = HEADER.exec(firstLine);
  const cat = header?.[2];
  const category = cat !== undefined && (CATEGORIES as readonly string[]).includes(cat) ? (cat as Category) : FALLBACK_CATEGORY;
  const summary = (header?.[3] ?? firstLine).trim().slice(0, 120);
  let rest = header ? (nl < 0 ? "" : text.slice(nl)) : text;
  let end = rest.length;
  for (const stop of BODY_END) {
    const i = rest.indexOf(stop);
    if (i >= 0 && i < end) end = i;
  }
  rest = rest.slice(0, end).trim();
  const footer = FOOTER.exec(text);
  const sources = (footer?.[1]?.split("+") ?? []).filter((s): s is EngineName =>
    (ENGINE_NAMES as readonly string[]).includes(s),
  );
  const conf = footer?.[2] !== undefined ? Number(footer[2]) : NaN;
  return {
    category,
    summary,
    body: rest,
    sources: [...new Set(sources)],
    confidence: Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : null,
  };
}

/**
 * One of our threads as the merge step's PriorThread, or null for threads that are not ours.
 * state: human-resolved → dismissed (Q9); resolved by us or carrying the addressed note →
 * addressed; else open. W6 updates `state` after this run's resolve step (§6.4).
 */
export function toPriorThread(thread: ReviewThread): PriorThreadData | null {
  if (!thread.ours || !thread.marker || !thread.firstComment) return null;
  const state: PriorThreadState = thread.humanResolved
    ? "dismissed"
    : thread.isResolved || thread.addressed
      ? "addressed"
      : "open";
  const outdated = thread.line === null;
  const end = outdated ? thread.originalLine : thread.line;
  const start = outdated ? thread.originalStartLine : thread.startLine;
  if (end === null) return null;
  const multi = start !== null && start !== end;
  return {
    marker: thread.marker,
    state,
    path: thread.path,
    line: multi ? start : end,
    end_line: multi ? end : null,
    side: thread.side,
    ...parseFindingComment(thread.firstComment.body),
  };
}

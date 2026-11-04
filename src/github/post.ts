// Posting the review (design §8.5, §2.2).
//
// 1. GET the PR: post nothing if it is closed or its head moved past the reviewed SHA.
// 2. One POST /pulls/{n}/reviews with commit_id, event, body and inline comments.
// 3. On 422 (usually a bad anchor): retry once with `comments: []` and every comment moved into the
//    body. A second failure is thrown (the orchestrator exits 1).
// Limits: body <= 60,000 chars (<details> sections shrink first), comment <= 4,000 chars,
// <= 30 inline comments. The state marker always stays the last line of the body.

import type { Side, Verdict } from "../types.js";
import type { GitHub, RepoRef } from "./client.js";
import { redact } from "../env.js";
import { assertSha } from "./git.js";
import { fetchPullRequest } from "./pr.js";

export const MAX_BODY_CHARS = 60_000;
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_INLINE_COMMENTS = 30;

export interface InlineComment {
  path: string;
  body: string;
  /** Last line of the range (GitHub `line`). */
  line: number;
  side: Side;
  /** First line of a multi-line range. */
  start_line?: number;
  start_side?: Side;
}

export interface PostReviewInput {
  pullNumber: number;
  /** The head SHA that was reviewed; also the review's commit_id. */
  commitId: string;
  event: Verdict;
  /** Rendered body, ending with the state marker. */
  body: string;
  comments: readonly InlineComment[];
  /**
   * Builds the body for the body-only retry (and for comments over the inline cap). Default:
   * appendCommentsToBody.
   */
  bodyWithComments?: (body: string, comments: readonly InlineComment[]) => string;
}

export type PostReviewResult =
  | {
      status: "posted";
      reviewId: number;
      htmlUrl: string;
      /** True when the 422 retry posted without inline comments. */
      bodyOnly: boolean;
      /** Comments that went into the body instead of inline (over the cap, or the 422 retry). */
      movedToBody: InlineComment[];
      /** Anchors of the comments that were rejected by the 422, for the job log. */
      rejectedAnchors: string[];
    }
  | { status: "head_moved"; currentHead: string }
  | { status: "closed" };

export class ReviewPostError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ReviewPostError";
    this.status = status;
  }
}

const STATE_MARKER_TAIL = /\n*<!-- myrabbit:state [^<>]*-->\s*$/;
const FINDING_MARKER_TAIL = /\n*<!-- myrabbit:f [^<>]*-->\s*$/;
const TRUNCATED = "\n\n… (truncated)";

function splitTail(text: string, tail: RegExp): { head: string; tail: string } {
  const m = tail.exec(text);
  return m ? { head: text.slice(0, m.index), tail: m[0] } : { head: text, tail: "" };
}

/** Close an open code fence left by a cut, so the rest of the comment does not render as code. */
function closeFences(text: string): string {
  const fences = text.match(/^\s*```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

function hardCut(text: string, max: number): string {
  if (text.length <= max) return text;
  // Leave room for the marker and a closing fence.
  let cut = text.slice(0, Math.max(0, max - TRUNCATED.length - 4));
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return closeFences(cut) + TRUNCATED;
}

/**
 * Fit the review body into `max` chars: shrink `<details>` sections (largest first) to a stub,
 * then cut the rest. The trailing state marker is always kept.
 */
export function truncateBody(body: string, max = MAX_BODY_CHARS): string {
  if (body.length <= max) return body;
  const { head, tail } = splitTail(body, STATE_MARKER_TAIL);
  const budget = max - tail.length;
  if (budget <= 0) throw new ReviewPostError("state marker alone exceeds the body limit", null);
  let text = head;
  const detailsRe = /<details>([\s\S]*?)<\/details>/g;
  const sections = [...text.matchAll(detailsRe)]
    .map((m) => ({ full: m[0], inner: m[1] ?? "" }))
    .sort((a, b) => b.full.length - a.full.length);
  for (const s of sections) {
    if (text.length <= budget) break;
    const summary = /^\s*<summary>[\s\S]*?<\/summary>/.exec(s.inner)?.[0] ?? "<summary>Details</summary>";
    const stub = `<details>${summary}\n\n… (truncated: review body limit)\n\n</details>`;
    if (stub.length < s.full.length) text = text.replace(s.full, stub);
  }
  return hardCut(text, budget) + tail;
}

/**
 * Fit an inline comment into `max` chars. Suggestion blocks go first: a cut suggestion would be a
 * wrong replacement if committed. The trailing finding marker is always kept.
 */
export function truncateComment(body: string, max = MAX_COMMENT_CHARS): string {
  if (body.length <= max) return body;
  const { head, tail } = splitTail(body, FINDING_MARKER_TAIL);
  const budget = max - tail.length;
  let text = head.replace(/\n*```suggestion\n[\s\S]*?\n```/g, "\n\n_(suggestion omitted: comment too long)_");
  if (text.length > budget) {
    text = hardCut(text, budget);
  }
  return text + tail;
}

/** Default body-only rendering of comments that could not be posted inline. */
export function appendCommentsToBody(body: string, comments: readonly InlineComment[]): string {
  if (comments.length === 0) return body;
  const { head, tail } = splitTail(body, STATE_MARKER_TAIL);
  const items = comments.map((c) => {
    const range = c.start_line !== undefined && c.start_line !== c.line ? `${c.start_line}-${c.line}` : `${c.line}`;
    const text = splitTail(c.body, FINDING_MARKER_TAIL).head.trim();
    return `#### \`${c.path}:${range}\` (${c.side})\n\n${text}`;
  });
  const section =
    `\n\n<details><summary>Findings not posted inline (${comments.length})</summary>\n\n` +
    `${items.join("\n\n---\n\n")}\n\n</details>`;
  return head + section + tail;
}

function anchorOf(c: InlineComment): string {
  const range = c.start_line !== undefined ? `${c.start_line}-${c.line}` : `${c.line}`;
  return `${c.path}:${range}:${c.side}`;
}

/** GitHub's error message (e.g. why an APPROVE was refused), redacted and shortened. */
function messageOf(e: unknown): string {
  const data = typeof e === "object" && e !== null ? (e as { response?: { data?: unknown } }).response?.data : undefined;
  const msg =
    typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : "";
  const errors =
    typeof data === "object" && data !== null && Array.isArray((data as { errors?: unknown }).errors)
      ? (data as { errors: unknown[] }).errors.filter((x): x is string => typeof x === "string")
      : [];
  const text = [msg, ...errors].filter((x) => x !== "").join("; ");
  return text === "" ? "" : `: ${redact(text).slice(0, 500)}`;
}

function statusOf(e: unknown): number | null {
  return typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number"
    ? (e as { status: number }).status
    : null;
}

export async function postReview(gh: GitHub, repo: RepoRef, input: PostReviewInput): Promise<PostReviewResult> {
  assertSha(input.commitId, "commit_id");
  const bodyWith = input.bodyWithComments ?? appendCommentsToBody;

  const pr = await fetchPullRequest(gh, repo, input.pullNumber);
  if (pr.state !== "open" || pr.merged) return { status: "closed" };
  if (pr.head.sha.toLowerCase() !== input.commitId) return { status: "head_moved", currentHead: pr.head.sha };

  const all = input.comments.map((c) => ({ ...c, body: truncateComment(c.body) }));
  const inline = all.slice(0, MAX_INLINE_COMMENTS);
  const overflow = all.slice(MAX_INLINE_COMMENTS);

  const send = async (body: string, comments: readonly InlineComment[]) =>
    gh.rest.pulls.createReview({
      ...repo,
      pull_number: input.pullNumber,
      commit_id: input.commitId,
      event: input.event,
      body: truncateBody(body),
      comments: comments.map((c) => ({
        path: c.path,
        body: c.body,
        line: c.line,
        side: c.side,
        ...(c.start_line !== undefined && c.start_line !== c.line
          ? { start_line: c.start_line, start_side: c.start_side ?? c.side }
          : {}),
      })),
    });

  try {
    const { data } = await send(bodyWith(input.body, overflow), inline);
    return { status: "posted", reviewId: data.id, htmlUrl: data.html_url, bodyOnly: false, movedToBody: overflow, rejectedAnchors: [] };
  } catch (e) {
    if (statusOf(e) !== 422 || inline.length === 0) {
      const s = statusOf(e);
      throw new ReviewPostError(`POST review failed${s !== null ? ` (HTTP ${String(s)})` : ""}${messageOf(e)}`, s);
    }
  }

  try {
    const { data } = await send(bodyWith(input.body, all), []);
    return {
      status: "posted",
      reviewId: data.id,
      htmlUrl: data.html_url,
      bodyOnly: true,
      movedToBody: all,
      rejectedAnchors: inline.map(anchorOf),
    };
  } catch (e) {
    const s = statusOf(e);
    throw new ReviewPostError(
      `POST review failed after body-only retry${s !== null ? ` (HTTP ${String(s)})` : ""}${messageOf(e)}`,
      s,
    );
  }
}

// Reviews listing, "last review" lookup (§8.3) and mode selection (§2.1).

import type { ReviewState, RunMode } from "../types.js";
import type { GitHub, RepoRef } from "./client.js";
import { isAncestor, type GitRunner } from "./git.js";
import { parseStateMarker } from "./markers.js";

export interface ReviewSummary {
  id: number;
  /** REST login, e.g. `myrabbit[bot]`; null for deleted users. */
  user: string | null;
  state: string;
  body: string;
  /** null for pending reviews. */
  commitId: string | null;
  submittedAt: string | null;
}

export async function listReviews(gh: GitHub, repo: RepoRef, pullNumber: number): Promise<ReviewSummary[]> {
  const reviews = await gh.paginate(gh.rest.pulls.listReviews, { ...repo, pull_number: pullNumber, per_page: 100 });
  return reviews.map((r) => ({
    id: r.id,
    user: r.user?.login ?? null,
    state: r.state,
    body: r.body,
    commitId: r.commit_id,
    submittedAt: r.submitted_at ?? null,
  }));
}

/** REST login check: exact match, case-insensitive (`myrabbit[bot]`). */
export function isBotLogin(login: string | null | undefined, botLogin: string): boolean {
  return !!login && login.toLowerCase() === botLogin.toLowerCase();
}

/**
 * GraphQL actor check. GraphQL reports an App as `__typename: "Bot"` with the login minus `[bot]`;
 * only a Bot actor may match without the suffix, so a user who registers the bare slug never does.
 */
export function isBotActor(
  actor: { login: string; __typename?: string } | null | undefined,
  botLogin: string,
): boolean {
  if (!actor) return false;
  if (isBotLogin(actor.login, botLogin)) return true;
  return actor.__typename === "Bot" && actor.login.toLowerCase() === botLogin.toLowerCase().replace(/\[bot\]$/, "");
}

export interface LastReview {
  reviewId: number;
  state: ReviewState;
  submittedAt: string | null;
}

/**
 * The newest review by the bot whose state marker's `head` equals the review's `commit_id`.
 * Pending reviews are ignored.
 */
export function findLastReview(reviews: readonly ReviewSummary[], botLogin: string): LastReview | null {
  let best: LastReview | null = null;
  for (const r of reviews) {
    if (r.state === "PENDING" || !isBotLogin(r.user, botLogin) || r.commitId === null) continue;
    const state = parseStateMarker(r.body);
    if (!state || state.head !== r.commitId.toLowerCase()) continue;
    if (!best || r.id > best.reviewId) best = { reviewId: r.id, state, submittedAt: r.submittedAt };
  }
  return best;
}

export type Trigger = "pull_request" | "workflow_dispatch";

export type ModeReason =
  | "dispatch"
  | "no_previous_review"
  | "already_reviewed"
  | "incremental"
  | "not_ancestor"
  | "config_changed"
  | "too_many_files"
  /** design-v2 §5.4: the override label was added or removed; set by the orchestrator, not selectMode. */
  | "label_override";

export interface ModeSelection {
  mode: RunMode;
  reason: ModeReason;
  /** The previous review, when there is one. */
  last: LastReview | null;
  /** Diff base for the review target: PR base (full; merge-base diff) or last reviewed head (incremental). */
  from: string | null;
  head: string;
}

export interface ModeInput {
  trigger: Trigger;
  headSha: string;
  baseSha: string;
  /** sha1-12 of the effective config (§8.3). */
  configHash: string;
  last: LastReview | null;
  git: GitRunner;
}

/** §2.1 mode table. The max_files fallback needs the filtered diff: see applyIncrementalLimit. */
export async function selectMode(input: ModeInput): Promise<ModeSelection> {
  const { trigger, headSha, baseSha, configHash, last, git } = input;
  const full = (reason: ModeReason): ModeSelection => ({ mode: "full", reason, last, from: baseSha, head: headSha });
  if (trigger === "workflow_dispatch") return full("dispatch");
  if (!last) return full("no_previous_review");
  if (last.state.head === headSha.toLowerCase()) {
    return { mode: "skip", reason: "already_reviewed", last, from: null, head: headSha };
  }
  if (!(await isAncestor(git, last.state.head, headSha))) return full("not_ancestor");
  if (last.state.config !== configHash) return full("config_changed");
  return { mode: "incremental", reason: "incremental", last, from: last.state.head, head: headSha };
}

/**
 * §2.1 last row: an incremental diff with more than `maxFiles` in-scope files falls back to full.
 * `incrementalFileCount` is the count after path_filters.
 */
export function applyIncrementalLimit(
  selection: ModeSelection,
  incrementalFileCount: number,
  maxFiles: number,
  baseSha: string,
): ModeSelection {
  if (selection.mode !== "incremental" || incrementalFileCount <= maxFiles) return selection;
  return { ...selection, mode: "full", reason: "too_many_files", from: baseSha };
}

// design-v2 §4.6–§4.7 wiring: related issue/PR candidates and suggested reviewers, under a time
// budget so a slow GitHub API or a huge history can never hold up the review.
//
// The reviewer computation and the candidate search each get the budget from when they start, and
// an AbortController each, which fires at that deadline or when the run signal aborts and is passed
// to src/related as `deps.signal`. That really stops the work (requests,
// rate-limit waits, git processes) and src/related still resolves with what it had: the candidates
// found so far, and the CODEOWNERS pick for reviewers. The results are awaited, not abandoned;
// `withBudget` stays only as a backstop a short grace after the deadline.

import { findCandidates, suggestReviewers, type CandidatesResult, type RelatedDeps, type RelatedInput } from "../related/index.js";
import type { RelatedCandidate } from "../prompts/builder.js";
import type { EngineRelated, RelatedItem, SuggestedReviewer } from "../types.js";

/** Wall-clock budget of the candidate search, and separately of the reviewer computation. */
export const RELATED_BUDGET_MS = 30_000;

export interface RelatedFeatures {
  /** `walkthrough.related`. */
  related: boolean;
  /** `walkthrough.suggested_reviewers`. */
  reviewers: boolean;
}

export interface RelatedStep {
  /** Resolves when candidates are done; `symbols` arrive after the context pack. */
  candidates: (symbols: readonly string[]) => Promise<CandidatesResult | null>;
  reviewers: Promise<SuggestedReviewer[] | null>;
}

const UNAVAILABLE: CandidatesResult = { candidates: [], unavailable: true };

/**
 * Resolves `work`, or `fallback` once `deadline` (from `now`) passes or `signal` aborts.
 * Never rejects.
 */
export async function withBudget<T>(
  work: Promise<T>,
  fallback: T,
  opts: { deadline: number; now: () => number; signal?: AbortSignal },
): Promise<T> {
  if (opts.signal?.aborted === true) return fallback;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, Math.max(0, opts.deadline - opts.now()));
    // A run that fails before awaiting this must not be kept alive by the budget.
    timer.unref();
    onAbort = () => {
      resolve(fallback);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work.catch(() => fallback), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * After the deadline abort, how long src/related may take to settle before the backstop gives up
 * on it (it should settle at once: every await there is cut by the signal).
 */
export const ABORT_GRACE_MS = 2_000;

/**
 * Starts the reviewer computation at once (it needs no symbols), and returns a function that starts
 * the candidate search once the context pack's symbols are known. Each gets the whole budget from the
 * moment it starts, so a slow context pack cannot starve the search; at its deadline, or when the run
 * signal aborts, its own signal aborts. A feature that is off resolves to null with no request made.
 */
export function startRelated(
  features: RelatedFeatures,
  input: Omit<RelatedInput, "symbols">,
  deps: Omit<RelatedDeps, "signal">,
  opts: { budgetMs?: number; now?: () => number; signal?: AbortSignal; graceMs?: number },
): RelatedStep {
  const budget = {
    budgetMs: opts.budgetMs ?? RELATED_BUDGET_MS,
    graceMs: opts.graceMs ?? ABORT_GRACE_MS,
    now: opts.now ?? Date.now,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const reviewers = features.reviewers
    ? runBudgeted((signal) => suggestReviewers({ ...input, symbols: [] }, { ...deps, signal }), [] as SuggestedReviewer[], budget)
    : Promise.resolve(null);
  const candidates = (symbols: readonly string[]): Promise<CandidatesResult | null> =>
    features.related ? runBudgeted((signal) => findCandidates({ ...input, symbols }, { ...deps, signal }), UNAVAILABLE, budget) : Promise.resolve(null);
  return { candidates, reviewers };
}

/**
 * Runs `work` with a signal that aborts `budgetMs` from now or when the run `signal` aborts, and
 * awaits what it settles with. `withBudget` is the backstop for work that ignores the signal: it
 * gives up `graceMs` after the abort. Timers are unref'd, and they and the run-signal listener are
 * dropped once the work settles.
 */
async function runBudgeted<T>(
  work: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  opts: { budgetMs: number; graceMs: number; now: () => number; signal?: AbortSignal },
): Promise<T> {
  const deadline = opts.now() + opts.budgetMs;
  const stop = new AbortController();
  const giveUp = new AbortController();
  let graceTimer: NodeJS.Timeout | undefined;
  stop.signal.addEventListener(
    "abort",
    () => {
      graceTimer = setTimeout(() => {
        giveUp.abort();
      }, opts.graceMs);
      graceTimer.unref();
    },
    { once: true },
  );
  const deadlineTimer = setTimeout(() => {
    stop.abort();
  }, opts.budgetMs);
  deadlineTimer.unref();
  const onRunAbort = () => {
    stop.abort();
  };
  if (opts.signal?.aborted === true) stop.abort();
  else opts.signal?.addEventListener("abort", onRunAbort, { once: true });
  try {
    // The deadline here only matters with an injected clock that the timers do not follow.
    return await withBudget(work(stop.signal), fallback, { deadline: deadline + opts.graceMs, now: opts.now, signal: giveUp.signal });
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(graceTimer);
    opts.signal?.removeEventListener("abort", onRunAbort);
  }
}

/** §4.6 body list: the union of the engines' picks (already filtered to candidate numbers), first reason wins. */
export function relatedUnion(
  picks: readonly (readonly EngineRelated[] | undefined)[],
  candidates: readonly RelatedCandidate[],
): RelatedItem[] {
  const kinds = new Map(candidates.map((c) => [c.number, c.kind]));
  const out: RelatedItem[] = [];
  const seen = new Set<number>();
  for (const list of picks) {
    for (const r of list ?? []) {
      const kind = kinds.get(r.number);
      if (kind === undefined || seen.has(r.number)) continue;
      seen.add(r.number);
      out.push({ number: r.number, kind, reason: r.reason });
    }
  }
  return out;
}

// Resolve step (design §2 step 8, §6.4): in incremental mode, ask one engine whether open myrabbit
// threads on changed code are fixed. At most RESOLVE_BUDGET per run, blocking threads first. A
// failed or timed-out call leaves the thread open (it keeps blocking): never a silent APPROVE.

import type { DiffFile, ReviewThread } from "../github/index.js";
import { severityRank, type PriorThread } from "../merge/index.js";

export const RESOLVE_BUDGET = 10;

export interface ResolveCandidate {
  /** Index into the prior-thread list. */
  index: number;
  thread: ReviewThread;
  prior: PriorThread;
  /** The last..head patch of the thread's file. */
  patch: string;
}

function overlaps(file: DiffFile, start: number, end: number): boolean {
  return file.hunks.some((h) => {
    // A pure deletion hunk (newLines 0) sits between newStart and newStart + 1.
    const from = h.newStart;
    const to = h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines - 1;
    return from <= end && to >= start;
  });
}

/**
 * Open threads whose anchored lines changed in last..head: the file is in the incremental diff and
 * the thread is outdated (GitHub moved it out of the diff) or a hunk touches its range. LEFT-side
 * threads only need their file to have changed.
 */
export function resolveCandidates(
  threads: readonly ReviewThread[],
  priors: readonly PriorThread[],
  incremental: readonly DiffFile[],
  budget = RESOLVE_BUDGET,
): ResolveCandidate[] {
  const byPath = new Map(incremental.filter((f) => !f.binary).map((f) => [f.path, f]));
  const out: ResolveCandidate[] = [];
  priors.forEach((prior, index) => {
    const thread = threads[index];
    if (thread === undefined || prior.state !== "open") return;
    const file = byPath.get(prior.path);
    if (file === undefined) return;
    const changed =
      thread.isOutdated || prior.side === "LEFT" || overlaps(file, prior.line, prior.end_line ?? prior.line);
    if (changed) out.push({ index, thread, prior, patch: file.patch });
  });
  out.sort(
    (a, b) =>
      Number(b.prior.marker.blk) - Number(a.prior.marker.blk) ||
      severityRank(a.prior.marker.sev) - severityRank(b.prior.marker.sev) ||
      a.index - b.index,
  );
  return out.slice(0, Math.max(0, budget));
}

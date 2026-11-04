// Which changed files are reviewed (design §2 step 4, §7.5, D2).
//
// Every changed file of the review target ends up in exactly one list: reviewed, filtered by
// path_filters (with the pattern), binary, or over a limit. Over-limit files make coverage
// incomplete (a synthetic blocking finding); filtered and binary files do not.

import type { PathFilter } from "../config/index.js";
import type { DiffFile } from "../github/index.js";
import type { CoverageGap } from "../merge/index.js";
import type { FileCoverage } from "../render/index.js";
import type { LimitsConfig } from "../types.js";

export interface ReviewScope {
  /** Text files sent to the engines, in diff order. */
  selected: DiffFile[];
  /** In-scope text files before limits (for the §2.1 incremental max_files fallback). */
  inScopeCount: number;
  files: FileCoverage;
  coverage: CoverageGap | null;
  /** Unified diff of the selected files. */
  diffText: string;
}

/**
 * Applies path_filters, then limits.max_files and limits.max_diff_bytes in diff order. A file that
 * does not fit is left out (coverage incomplete); later smaller files may still fit the byte budget.
 */
export function reviewScope(files: readonly DiffFile[], filter: PathFilter, limits: Pick<LimitsConfig, "max_files" | "max_diff_bytes">): ReviewScope {
  const partition = filter.partition(files.map((f) => f.path));
  const filteredPaths = new Set(partition.filtered.map((f) => f.path));
  const binary: string[] = [];
  const inScope: DiffFile[] = [];
  for (const f of files) {
    if (filteredPaths.has(f.path)) continue;
    if (f.binary) binary.push(f.path);
    else inScope.push(f);
  }

  const selected: DiffFile[] = [];
  const notReviewed: string[] = [];
  let bytes = 0;
  let overFiles = false;
  let overBytes = false;
  for (const f of inScope) {
    if (selected.length >= limits.max_files) {
      overFiles = true;
      notReviewed.push(f.path);
    } else if (bytes + f.bytes > limits.max_diff_bytes) {
      overBytes = true;
      notReviewed.push(f.path);
    } else {
      selected.push(f);
      bytes += f.bytes;
    }
  }

  const limitText = [
    ...(overFiles ? [`max_files ${limits.max_files}`] : []),
    ...(overBytes ? [`max_diff_bytes ${limits.max_diff_bytes}`] : []),
  ].join(", ");
  return {
    selected,
    inScopeCount: inScope.length,
    files: {
      reviewed: selected.map((f) => f.path),
      filtered: partition.filtered,
      notReviewed,
      binary,
    },
    coverage: notReviewed.length > 0 ? { notReviewed: notReviewed.length, limit: limitText } : null,
    diffText: selected.map((f) => f.patch).join(""),
  };
}

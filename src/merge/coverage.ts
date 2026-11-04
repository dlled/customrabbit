// §7.5 coverage: a synthetic blocking finding when in-scope files were not reviewed.

import type { EngineName, MergedFinding } from "../types.js";
import { fingerprint } from "./fingerprint.js";
import type { CoverageGap } from "./types.js";

export const COVERAGE_TITLE = "Review incomplete";

export function isCoverageIncomplete(gap: CoverageGap | null): gap is CoverageGap {
  return gap !== null && gap.notReviewed > 0;
}

/**
 * The §7.5 finding. It has no location: in memory path is "" and line 0, and the run document
 * omits path/line/end_line/side (`toRunDocumentJSON`). `blocking` is set directly, not derived from
 * the §7.2 expression, so the verdict is REQUEST_CHANGES whatever the threshold.
 */
export function coverageFinding(gap: CoverageGap, sources: readonly EngineName[]): MergedFinding {
  const n = gap.notReviewed;
  const files = n === 1 ? "file" : "files";
  return {
    path: "",
    line: 0,
    end_line: null,
    side: "RIGHT",
    severity: "critical",
    category: "reliability",
    summary: `${COVERAGE_TITLE}: ${String(n)} ${files} not reviewed (limit ${gap.limit})`,
    body: `${COVERAGE_TITLE}: ${String(n)} ${files} not reviewed (limit ${gap.limit}). Split the PR or raise \`limits\` on the base branch.`,
    failure_scenario: `Defects in the ${String(n)} unreviewed ${files} would merge without review.`,
    rule: null,
    suggestion: null,
    blocking: true,
    sources: [...sources],
    confidence: 1,
    fingerprint: fingerprint("", "reliability", COVERAGE_TITLE),
    status: "new",
    outside_diff: true,
    verification: "not_needed",
    synthetic: true,
  };
}

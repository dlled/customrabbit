// §7.4 verdict (deterministic). No model chooses it.
//
//   blocking_set = { f ∈ new_findings : f.blocking }
//                ∪ { t ∈ prior myrabbit threads : t.marker.blk == 1 ∧ t.marker.sev ≥ threshold
//                                                 ∧ open ∧ ¬addressed_in_this_run ∧ ¬human_resolved }
//                ∪ { coverage_finding }  if coverage is incomplete (§7.5)
//                ∪ synthetic_blockers     (design-v2: failed error-mode check §5.3, secret hit and
//                                          secret scan not run §7.5)
//   verdict = blocking_set ≠ ∅ ? REQUEST_CHANGES : APPROVE

import type {
  Category,
  EngineName,
  MergedFinding,
  Severity,
  SyntheticBlockerKind,
  Threshold,
  Verdict,
} from "../types.js";
import { coverageFinding, isCoverageIncomplete } from "./coverage.js";
import { fingerprint } from "./fingerprint.js";
import { meetsThreshold } from "./severity.js";
import { assertSources, type CoverageGap, type PriorThread } from "./types.js";

/**
 * A prior thread still blocks only if it was blocking when posted (`blk=1`), its posted severity
 * meets the current base threshold, and it is still open. `addressed` covers threads resolved by
 * myrabbit in this or an earlier run; `dismissed` covers human resolves (Q9).
 */
export function priorThreadBlocks(t: PriorThread, threshold: Threshold): boolean {
  return t.marker.blk && meetsThreshold(t.marker.sev, threshold) && t.state === "open";
}

/**
 * A blocking item that a feature adds without any model vote (design-v2 §10). P5 supplies
 * failed error-mode checks (§5.3), P6 the secret hit and "secret scan did not run" (§7.5). It
 * always blocks, whatever the threshold.
 */
export interface SyntheticBlocker {
  kind: SyntheticBlockerKind;
  /** One line, e.g. "Pre-merge check failed: title — …". Also the fingerprint's title. */
  title: string;
  severity: Severity;
  /** Markdown for the body; defaults to the title. */
  body?: string;
}

const KIND_CATEGORY: Record<SyntheticBlockerKind, Category> = {
  check: "maintainability",
  secret: "security",
  coverage: "reliability",
};

/**
 * The synthetic finding for one blocker: no location (path "", line 0, dropped from the run
 * document like the §7.5 coverage finding), `blocking` set directly, `synthetic: true`.
 */
export function syntheticFinding(b: SyntheticBlocker, sources: readonly EngineName[]): MergedFinding {
  const category = KIND_CATEGORY[b.kind];
  return {
    path: "",
    line: 0,
    end_line: null,
    side: "RIGHT",
    severity: b.severity,
    category,
    summary: b.title,
    body: b.body ?? b.title,
    failure_scenario: "",
    rule: null,
    suggestion: null,
    blocking: true,
    sources: [...sources],
    confidence: 1,
    fingerprint: fingerprint("", category, b.title),
    status: "new",
    outside_diff: true,
    verification: "not_needed",
    synthetic: true,
  };
}

export interface VerdictInput {
  /** New findings of this run (MergeResult.findings). */
  findings: readonly MergedFinding[];
  priorThreads: readonly PriorThread[];
  threshold: Threshold;
  coverage: CoverageGap | null;
  /** Engines that contributed (MergeResult.sources); must be non-empty. Also the synthetic finding's sources. */
  sources: readonly EngineName[];
  /** design-v2 synthetic blocking items. Default: none. */
  syntheticBlockers?: readonly SyntheticBlocker[];
}

export interface VerdictResult {
  verdict: Verdict;
  /** New findings with blocking = true. */
  blockingFindings: MergedFinding[];
  /** Prior threads that still block. */
  blockingThreads: PriorThread[];
  /** The §7.5 synthetic finding, when coverage is incomplete. */
  coverage: MergedFinding | null;
  /** One synthetic finding per synthetic blocker, in input order (empty without blockers). */
  synthetic: MergedFinding[];
  /**
   * The same findings (identical objects, same order) with the kind of blocker that produced
   * them, for consumers that rank by kind (src/merge/risk.ts). The kind is kept beside the
   * finding, not on it, because the run document serialises every finding key and the E4
   * schema allows no extra ones.
   */
  syntheticItems: SyntheticItem[];
}

export interface SyntheticItem {
  kind: SyntheticBlockerKind;
  finding: MergedFinding;
}

/** Throws {@link NoEngineOutputError} when `sources` is empty (§2.2: never APPROVE without a review). */
export function computeVerdict(input: VerdictInput): VerdictResult {
  assertSources(input.sources);
  const blockingFindings = input.findings.filter((f) => f.blocking);
  const blockingThreads = input.priorThreads.filter((t) => priorThreadBlocks(t, input.threshold));
  const coverage = isCoverageIncomplete(input.coverage)
    ? coverageFinding(input.coverage, input.sources)
    : null;
  const syntheticItems = (input.syntheticBlockers ?? []).map((b) => ({ kind: b.kind, finding: syntheticFinding(b, input.sources) }));
  const synthetic = syntheticItems.map((i) => i.finding);
  const blocked =
    blockingFindings.length > 0 || blockingThreads.length > 0 || coverage !== null || synthetic.length > 0;
  return {
    verdict: blocked ? "REQUEST_CHANGES" : "APPROVE",
    blockingFindings,
    blockingThreads,
    coverage,
    synthetic,
    syntheticItems,
  };
}

// Merge risk (design-v2 §4.2). Owned by P1.
//
// Computed from the final finding set and coverage, never set by a model. Rows are checked top to
// bottom; the first one that holds wins:
//
//   critical  any critical item in the blocking set: a new finding, a prior blocking thread, or
//             the §7.5 secret item
//   high      any major item in the blocking set (new or prior), or a failed error-mode check
//   moderate  any other item in the blocking set: a minor/trivial blocker under a lower threshold,
//             a coverage item (v1 §7.5, "secret scan did not run"), or a blocker unverified
//             because of budget or error
//   low       blocking set empty, and non-blocking findings are open or a warning-mode check failed
//   minimal   blocking set empty and nothing open
//
// Coverage items are moderate whatever their severity field (the v1 coverage finding is written as
// `critical` so that it blocks under every threshold; that is not a statement about the code).
// An unverified blocker keeps its severity row: a critical single-model finding the verifier never
// reached is still shown as critical risk, so the risk can only err upwards.
//
// It agrees with the verdict by construction: blocking set ≠ ∅ ⇔ risk ≥ moderate ⇔
// REQUEST_CHANGES. `mergeRisk` re-checks that and throws on a mismatch (a bug; fail closed, like
// the renderer's verdict check). It goes into the run document (`risk`) and the body, never into
// the state marker.

import { RISKS, type Risk, type RunCheck, type Severity, type SyntheticBlockerKind } from "../types.js";
import type { VerdictResult } from "./verdict.js";

export interface RiskInput {
  /** The blocking set: new blocking findings, blocking prior threads, coverage and synthetic items. */
  verdict: VerdictResult;
  /** Open findings and threads that do not block. */
  openNonBlocking: number;
  /** Combined checks (warning-mode failures raise risk to low). */
  checks: readonly RunCheck[];
}

export class RiskError extends Error {
  override readonly name = "RiskError";
}

/** 0 = critical … 4 = minimal. */
export function riskRank(r: Risk): number {
  return RISKS.indexOf(r);
}

/** True when `r` is at least as severe as `min`. */
export function riskAtLeast(r: Risk, min: Risk): boolean {
  return riskRank(r) <= riskRank(min);
}

/** The verdict a risk implies: ≥ moderate ⇔ REQUEST_CHANGES. */
export function riskBlocks(r: Risk): boolean {
  return riskAtLeast(r, "moderate");
}

function severityRisk(s: Severity): Risk {
  return s === "critical" ? "critical" : s === "major" ? "high" : "moderate";
}

const KIND_RISK: Record<SyntheticBlockerKind, Risk> = {
  secret: "critical",
  check: "high",
  coverage: "moderate",
};

function maxRisk(risks: readonly Risk[]): Risk | null {
  let best: Risk | null = null;
  for (const r of risks) if (best === null || riskRank(r) < riskRank(best)) best = r;
  return best;
}

export function mergeRisk(input: RiskInput): Risk {
  const v = input.verdict;
  const failedError = input.checks.filter((c) => c.mode === "error" && c.status === "fail");
  if (v.syntheticItems.length !== v.synthetic.length || v.syntheticItems.some((i, n) => i.finding !== v.synthetic[n])) {
    // Both lists come from computeVerdict; a hand-built result that splits them is a bug.
    throw new RiskError("verdict synthetic findings and synthetic items disagree");
  }
  const checkBlockers = v.syntheticItems.filter((i) => i.kind === "check").length;
  if (failedError.length > checkBlockers) {
    // §5.3: every failed error-mode check is a synthetic blocker. One that is missing would show
    // an "approved" PR with a failed blocking check.
    throw new RiskError(
      `${failedError.length} failed error-mode check(s) but ${checkBlockers} check blocker(s) in the verdict`,
    );
  }
  const blockingRisk = maxRisk([
    ...v.blockingFindings.map((f) => severityRisk(f.severity)),
    ...v.blockingThreads.map((t) => severityRisk(t.marker.sev)),
    ...(v.coverage ? (["moderate"] as const) : []),
    ...v.syntheticItems.map((i) => KIND_RISK[i.kind]),
  ]);
  const risk: Risk =
    blockingRisk ??
    (input.openNonBlocking > 0 || input.checks.some((c) => c.mode === "warning" && c.status === "fail")
      ? "low"
      : "minimal");
  if (riskBlocks(risk) !== (v.verdict === "REQUEST_CHANGES")) {
    throw new RiskError(`risk ${risk} contradicts verdict ${v.verdict}`);
  }
  return risk;
}

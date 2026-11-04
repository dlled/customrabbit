import { SEVERITIES, type Severity, type Threshold } from "../types.js";

/** 0 = critical (most severe) … 3 = trivial. */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** True when `s` is at least as severe as `threshold`. */
export function meetsThreshold(s: Severity, threshold: Threshold): boolean {
  return severityRank(s) <= severityRank(threshold);
}

export function lowerSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

export function higherSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

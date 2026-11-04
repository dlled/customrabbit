// §7.2 step 7: the blocking expression, exactly as specified.
//
//   confirmed = sources.length == 2 || verified == true || unverified_due_to_budget_or_error
//   blocking  = severity ≥ threshold && confirmed && (!outside_diff || severity == critical)

import type { MergedFinding, Threshold } from "../types.js";
import { meetsThreshold } from "./severity.js";

type BlockingInput = Pick<MergedFinding, "severity" | "sources" | "verification" | "outside_diff">;

export function isConfirmed(f: BlockingInput): boolean {
  return (
    new Set(f.sources).size >= 2 ||
    f.verification === "verified" ||
    f.verification === "unverified_budget" ||
    f.verification === "unverified_error"
  );
}

export function isBlocking(f: BlockingInput, threshold: Threshold): boolean {
  return (
    meetsThreshold(f.severity, threshold) &&
    isConfirmed(f) &&
    (!f.outside_diff || f.severity === "critical")
  );
}

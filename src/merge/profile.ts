// §7.2 step 8 + §7.3: ordering and placement. The profile controls visibility only; it never
// changes blocking.

import type { MergedFinding, Profile, Severity } from "../types.js";
import { severityRank } from "./severity.js";
import type { Placement } from "./types.js";

const INLINE: Record<Profile, readonly Severity[]> = {
  quiet: ["critical", "major"],
  chill: ["critical", "major", "minor"],
  assertive: ["critical", "major", "minor", "trivial"],
};

/** Sort by blocking, then severity, then confidence (stable for ties). */
export function orderFindings(findings: readonly MergedFinding[]): MergedFinding[] {
  return [...findings].sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      b.confidence - a.confidence,
  );
}

/** Whether the profile shows this finding inline. Outside-diff and synthetic findings never are. */
export function isInlineEligible(f: MergedFinding, profile: Profile): boolean {
  return !f.outside_diff && !f.synthetic && INLINE[profile].includes(f.severity);
}

/**
 * Splits ordered findings into inline comments (the first `maxInline` eligible ones) and the body.
 * In the quiet profile, non-blocking minor/trivial findings are shown as a count only; a blocking
 * finding is always listed.
 */
export function placeFindings(
  findings: readonly MergedFinding[],
  profile: Profile,
  maxInline: number,
): Placement {
  const placement: Placement = { inline: [], body: [], countOnly: [] };
  for (const f of orderFindings(findings)) {
    if (isInlineEligible(f, profile) && placement.inline.length < maxInline) {
      placement.inline.push(f);
    } else if (profile === "quiet" && !f.blocking && !INLINE.quiet.includes(f.severity)) {
      placement.countOnly.push(f);
    } else {
      placement.body.push(f);
    }
  }
  return placement;
}

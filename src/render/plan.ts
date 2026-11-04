// Where each finding goes (design §7.2 step 8, §7.3): inline, body (with details), or count only.

import { redact } from "../env.js";
import { SEVERITIES, type Profile, type Severity } from "../types.js";
import { FINGERPRINT_PATTERN } from "./markers.js";
import type { RenderFinding } from "./types.js";

/** GitHub accepts more, but R3 §7 caps one review at 30 inline comments (§8.5). */
export const MAX_INLINE_COMMENTS_HARD = 30;

const INLINE_BY_PROFILE: Record<Profile, readonly Severity[]> = {
  quiet: ["critical", "major"],
  chill: ["critical", "major", "minor"],
  assertive: SEVERITIES,
};

/** Severities a profile shows only as a count in the body (§7.3). */
const COUNT_ONLY_BY_PROFILE: Record<Profile, readonly Severity[]> = {
  quiet: ["minor", "trivial"],
  chill: [],
  assertive: [],
};

const FINGERPRINT_RE = new RegExp(`^${FINGERPRINT_PATTERN}$`);

export interface Placement {
  inline: RenderFinding[];
  /** Blocking findings that could not go inline (outside diff, synthetic, over the cap…). */
  bodyBlocking: RenderFinding[];
  /** Non-blocking findings listed in the body. */
  bodyNonBlocking: RenderFinding[];
  /** Non-blocking findings the profile shows as a count only. */
  countOnly: Partial<Record<Severity, number>>;
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** Blocking first, then severity, then confidence; ties broken by location for stable output. */
export function compareFindings(a: RenderFinding, b: RenderFinding): number {
  return (
    Number(b.blocking) - Number(a.blocking) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    b.confidence - a.confidence ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

/**
 * Whether a finding can be posted as an inline comment at all. The comment's `path` must be sent
 * verbatim to anchor, so a path that redact() would change goes to the body instead.
 */
export function inlineAnchorable(f: RenderFinding): boolean {
  return (
    !f.outside_diff &&
    !f.synthetic &&
    f.path !== "" &&
    Number.isInteger(f.line) &&
    f.line >= 1 &&
    FINGERPRINT_RE.test(f.fingerprint) &&
    redact(f.path) === f.path
  );
}

export function placeFindings(
  findings: readonly RenderFinding[],
  profile: Profile,
  maxInline: number,
  allowInline: boolean,
): Placement {
  const cap = Math.max(0, Math.min(Math.floor(maxInline), MAX_INLINE_COMMENTS_HARD));
  const placement: Placement = { inline: [], bodyBlocking: [], bodyNonBlocking: [], countOnly: {} };
  const sorted = findings.filter((f) => f.status === "new").sort(compareFindings);
  for (const f of sorted) {
    // A blocking finding is always visible, whatever the profile (the profile never changes
    // blocking, §7.3). Unconfirmed single-model findings stay in the body (§8.6).
    const wantsInline =
      f.blocking || (f.verification !== "rejected" && INLINE_BY_PROFILE[profile].includes(f.severity));
    if (allowInline && wantsInline && inlineAnchorable(f) && placement.inline.length < cap) {
      placement.inline.push(f);
    } else if (f.blocking) {
      placement.bodyBlocking.push(f);
    } else if (COUNT_ONLY_BY_PROFILE[profile].includes(f.severity)) {
      placement.countOnly[f.severity] = (placement.countOnly[f.severity] ?? 0) + 1;
    } else {
      placement.bodyNonBlocking.push(f);
    }
  }
  return placement;
}

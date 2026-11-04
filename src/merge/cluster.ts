// §7.2 steps 3-4: cluster findings across engines and damp severity on disagreement.

import { ENGINE_NAMES, type EngineName, type Severity } from "../types.js";
import { jaccard, titleTokens } from "./fingerprint.js";
import { higherSeverity, lowerSeverity } from "./severity.js";
import type { ValidatedFinding } from "./validate.js";

/** A validated finding after anchoring and fingerprinting. */
export interface Candidate extends ValidatedFinding {
  fingerprint: string;
  outside_diff: boolean;
  /** Position in the combined input; the tie-breaker that keeps merging deterministic. */
  index: number;
}

/** Lines of slack for the proximity rule (§7.2 step 3). */
export const LINE_SLACK = 3;
export const JACCARD_MIN = 0.5;

export function sameIssue(a: Candidate, b: Candidate): boolean {
  if (a.fingerprint === b.fingerprint) return true;
  if (a.path !== b.path || a.category !== b.category || a.side !== b.side) return false;
  const aEnd = a.end_line ?? a.line;
  const bEnd = b.end_line ?? b.line;
  const near = a.line <= bEnd + LINE_SLACK && b.line <= aEnd + LINE_SLACK;
  return near && jaccard(titleTokens(a.title), titleTokens(b.title)) >= JACCARD_MIN;
}

/** Union-find over all pairs; clusters come out in order of their first member. */
export function cluster(cands: readonly Candidate[]): Candidate[][] {
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    parent[i] = r;
    return r;
  };
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i];
      const b = cands[j];
      if (a && b && sameIssue(a, b)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  }
  const groups = new Map<number, Candidate[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(c);
    else groups.set(r, [c]);
  });
  return [...groups.values()];
}

/** Highest confidence first; ties go to the earlier input. */
function byConfidence(a: Candidate, b: Candidate): number {
  return b.confidence - a.confidence || a.index - b.index;
}

/** Evidence refs other than the finding's own anchor (`path:line` or `path:line-line`). */
export function evidenceBeyondAnchor(f: Candidate): number {
  const end = f.end_line ?? f.line;
  return f.evidence.filter((ref) => {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
    if (!m) return true;
    const [, path, from, to] = m;
    const lo = Number(from);
    const hi = to === undefined ? lo : Number(to);
    return !(path === f.path && lo >= f.line && hi <= end);
  }).length;
}

/**
 * §7.2 step 4: on disagreement take the lower severity, unless a member at the higher severity has
 * at least 2 evidence refs and no member at the lower severity has evidence beyond its anchor.
 */
export function dampSeverity(members: readonly Candidate[]): Severity {
  const [first, ...rest] = members;
  if (!first) throw new Error("dampSeverity: empty cluster");
  let hi = first.severity;
  let lo = first.severity;
  for (const m of rest) {
    hi = higherSeverity(hi, m.severity);
    lo = lowerSeverity(lo, m.severity);
  }
  if (hi === lo) return hi;
  const highBacked = members.some((m) => m.severity === hi && m.evidence.length >= 2);
  const lowBare = members
    .filter((m) => m.severity === lo)
    .every((m) => evidenceBeyondAnchor(m) === 0);
  return highBacked && lowBare ? hi : lo;
}

/** A cluster reduced to one finding, before verification and history dedupe. */
export interface ClusteredFinding {
  /** Member that gives the location: the most confident anchored member, else the most confident. */
  location: Candidate;
  /** Member that gives the text: the most confident member. */
  lead: Candidate;
  members: Candidate[];
  severity: Severity;
  sources: EngineName[];
  suggestion: string | null;
  confidence: number;
  /** Every member's fingerprint, for history dedupe. */
  fingerprints: Set<string>;
  /** Union of member evidence, in order, deduplicated. */
  evidence: string[];
}

export function reduceCluster(members: Candidate[]): ClusteredFinding {
  const sorted = [...members].sort(byConfidence);
  const lead = sorted[0];
  if (!lead) throw new Error("reduceCluster: empty cluster");
  const location = sorted.find((m) => !m.outside_diff) ?? lead;
  const present = new Set(members.map((m) => m.engine));
  const sources = ENGINE_NAMES.filter((e) => present.has(e));

  // A suggestion survives only if every member that has one agrees. It replaces line..end_line, so
  // it must also come from a member at the chosen location.
  const withSuggestion = members.filter((m) => m.suggestion !== null);
  const distinct = new Set(withSuggestion.map((m) => m.suggestion));
  let suggestion: string | null = null;
  if (distinct.size === 1) {
    const ok = withSuggestion.some(
      (m) =>
        m.path === location.path &&
        m.side === location.side &&
        m.line === location.line &&
        m.end_line === location.end_line,
    );
    if (ok) suggestion = withSuggestion[0]?.suggestion ?? null;
  }

  const evidence = [...new Set(sorted.flatMap((m) => m.evidence))];
  return {
    location,
    lead,
    members: sorted,
    severity: dampSeverity(members),
    sources,
    suggestion,
    confidence: lead.confidence,
    fingerprints: new Set(members.map((m) => m.fingerprint)),
    evidence,
  };
}

// §7.2 step 1: validate each engine output with zod, drop findings without failure_scenario or
// evidence or on a path outside the diff, truncate over-long strings. Every drop is counted.

import { z } from "zod";
import { CATEGORIES, SEVERITIES, SIDES, type EngineFinding, type EngineName } from "../types.js";
import type { DropCounts } from "./types.js";

export const LIMITS = {
  title: 120,
  body: 1500,
  failure_scenario: 1500,
  evidence_item: 300,
  evidence_items: 20,
  rule: 1000,
  /** §6.1 rule 7: a suggestion is a complete replacement of at most 15 lines. */
  suggestion_lines: 15,
} as const;

const outputShape = z.object({
  summary: z.string(),
  changes: z.array(z.unknown()),
  findings: z.array(z.unknown()),
});

const findingSchema = z.object({
  path: z.string().min(1),
  line: z.int().min(1),
  end_line: z.int().min(1).nullable(),
  side: z.enum(SIDES),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().trim().min(1),
  body: z.string(),
  failure_scenario: z.string(),
  evidence: z.array(z.string()),
  rule: z.string().nullable(),
  suggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export function emptyDrops(): DropCounts {
  return {
    invalid_output: 0,
    invalid_finding: 0,
    missing_failure_scenario: 0,
    missing_evidence: 0,
    path_not_in_diff: 0,
    truncated: 0,
    duplicate_open: 0,
    duplicate_dismissed: 0,
  };
}

export interface ValidatedFinding extends EngineFinding {
  engine: EngineName;
}

export interface ValidateResult {
  /** False when the whole output was unusable; the engine then contributed nothing. */
  ok: boolean;
  findings: ValidatedFinding[];
}

function cut(s: string, max: number): [string, boolean] {
  return s.length <= max ? [s, false] : [`${s.slice(0, max - 1)}…`, true];
}

/** Normalise `./a/b` and `/a/b` to the repo-relative `a/b`. */
function normalizePath(p: string): string {
  return p.replace(/^(\.\/|\/)+/, "");
}

export function validateEngineOutput(
  engine: EngineName,
  raw: unknown,
  diffPaths: ReadonlySet<string>,
  drops: DropCounts,
): ValidateResult {
  const shape = outputShape.safeParse(raw);
  if (!shape.success) {
    drops.invalid_output++;
    return { ok: false, findings: [] };
  }
  const findings: ValidatedFinding[] = [];
  for (const item of shape.data.findings) {
    const f = validateFinding(engine, item, diffPaths, drops);
    if (f) findings.push(f);
  }
  return { ok: true, findings };
}

function validateFinding(
  engine: EngineName,
  item: unknown,
  diffPaths: ReadonlySet<string>,
  drops: DropCounts,
): ValidatedFinding | null {
  // The evidence rule is checked first so its drops are counted separately from schema errors.
  const rec = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  const fs = rec.failure_scenario;
  if (typeof fs !== "string" || fs.trim() === "") {
    drops.missing_failure_scenario++;
    return null;
  }
  const ev = rec.evidence;
  if (!Array.isArray(ev) || !ev.some((e) => typeof e === "string" && e.trim() !== "")) {
    drops.missing_evidence++;
    return null;
  }
  const parsed = findingSchema.safeParse(item);
  if (!parsed.success) {
    drops.invalid_finding++;
    return null;
  }
  const f = parsed.data;
  if (f.end_line !== null && f.end_line < f.line) {
    drops.invalid_finding++;
    return null;
  }
  const path = normalizePath(f.path);
  if (!diffPaths.has(path)) {
    drops.path_not_in_diff++;
    return null;
  }

  let truncated = false;
  const field = (s: string, max: number): string => {
    const [v, t] = cut(s, max);
    truncated ||= t;
    return v;
  };
  const evidence = f.evidence
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .slice(0, LIMITS.evidence_items)
    .map((e) => field(e, LIMITS.evidence_item));
  if (f.evidence.length > LIMITS.evidence_items) truncated = true;

  // A suggestion is never truncated (that would make it wrong): it is dropped instead. Suggestions
  // exist only for RIGHT-side ranges (§5.1).
  let suggestion = f.suggestion;
  if (suggestion !== null) {
    const lines = suggestion.replace(/\n$/, "").split("\n").length;
    if (f.side !== "RIGHT" || lines > LIMITS.suggestion_lines) suggestion = null;
  }

  const out: ValidatedFinding = {
    engine,
    path,
    line: f.line,
    end_line: f.end_line === f.line ? null : f.end_line,
    side: f.side,
    severity: f.severity,
    category: f.category,
    title: field(f.title.trim(), LIMITS.title),
    body: field(f.body, LIMITS.body),
    failure_scenario: field(f.failure_scenario.trim(), LIMITS.failure_scenario),
    evidence,
    rule: f.rule === null ? null : field(f.rule, LIMITS.rule),
    suggestion,
    confidence: f.confidence,
  };
  if (truncated) drops.truncated++;
  return out;
}

// §5.2 run document: { schema_version, run, verdict, findings }, plus the design-v2 §8 fields when
// non-empty (exact shapes: eval/schema/findings.schema.json, E4). Written to the job summary and
// $RUNNER_TEMP/myrabbit-run.json for offline replay by the evaluator. Built only from merge data,
// never from env.

import type {
  EngineName,
  FindingStatus,
  MergedFinding,
  RunDocument,
  RunExtras,
  Threshold,
  Verdict,
} from "../types.js";
import { ENGINE_NAMES, MAX_PROPOSED_LEARNINGS, MAX_RUN_RELATED, MAX_RUN_TOOL_HITS } from "../types.js";
import { assertSources, MERGE_VERSION, type PriorThread } from "./types.js";
import { meetsThreshold } from "./severity.js";

/**
 * A prior thread as a run-document finding with status open / addressed / superseded / dismissed.
 * `blocking` is the §7.4 thread rule against the current threshold; the evaluator's verdict rule
 * ignores addressed/superseded/dismissed findings, so history never blocks. Superseded threads are blk=0, so
 * they are never blocking. `verification` reflects only what the
 * marker carries: `agreed` for two sources, `verified` for other `blk=1` threads, else `not_needed`.
 * An unknown confidence becomes 0; unknown sources fall back to the run's sources.
 */
export function priorThreadFinding(
  t: PriorThread,
  threshold: Threshold,
  runSources: readonly EngineName[],
): MergedFinding {
  const present = new Set(t.sources.length > 0 ? t.sources : runSources);
  const sources = ENGINE_NAMES.filter((e) => present.has(e));
  return {
    path: t.path,
    line: t.line,
    end_line: t.end_line,
    side: t.side,
    severity: t.marker.sev,
    category: t.category,
    summary: t.summary,
    body: t.body,
    failure_scenario: "",
    rule: null,
    suggestion: null,
    blocking: t.marker.blk && meetsThreshold(t.marker.sev, threshold),
    sources,
    confidence: t.confidence ?? 0,
    fingerprint: t.marker.fp,
    status: t.state,
    outside_diff: false,
    verification: sources.length >= 2 ? "agreed" : t.marker.blk ? "verified" : "not_needed",
    synthetic: false,
  };
}

export interface RunDocumentInput {
  promptVersion: string;
  sources: readonly EngineName[];
  verdict: Verdict;
  /** New findings of this run. */
  findings: readonly MergedFinding[];
  /** The §7.5 synthetic finding, if any. */
  coverage: MergedFinding | null;
  priorThreads: readonly PriorThread[];
  threshold: Threshold;
  /** design-v2 synthetic blocking findings (VerdictResult.synthetic). Default: none. */
  synthetic?: readonly MergedFinding[];
  /** design-v2 §8 fields; each is kept only when non-empty, within the E4 caps. */
  extras?: RunExtras;
}

/** Throws {@link NoEngineOutputError} when `sources` is empty: such a run posts nothing (§2.2). */
export function buildRunDocument(input: RunDocumentInput): RunDocument {
  assertSources(input.sources);
  const doc: RunDocument = {
    schema_version: "1",
    run: {
      prompt_version: input.promptVersion,
      merge_version: MERGE_VERSION,
      sources: [...input.sources],
    },
    verdict: input.verdict,
    findings: [
      ...(input.coverage ? [input.coverage] : []),
      ...(input.synthetic ?? []),
      ...input.findings,
      ...input.priorThreads.map((t) => priorThreadFinding(t, input.threshold, input.sources)),
    ],
    ...normalizeExtras(input.extras ?? {}),
  };
  const expected = evalVerdict(doc.findings);
  if (expected !== doc.verdict) {
    throw new Error(`run document verdict ${doc.verdict} contradicts its findings (${expected})`);
  }
  return doc;
}

/** History statuses: they never count toward the verdict (eval/scripts/score.ts `isLive`). */
export const HISTORY_STATUSES: readonly FindingStatus[] = ["addressed", "superseded", "dismissed"];

/** The evaluator's rule: REQUEST_CHANGES iff a blocking finding is not history. */
export function evalVerdict(findings: readonly MergedFinding[]): Verdict {
  const live = findings.some((f) => f.blocking && !HISTORY_STATUSES.includes(f.status));
  return live ? "REQUEST_CHANGES" : "APPROVE";
}

/**
 * design-v2 §8 fields as the E4 schema allows them: empty values are left out (so a v1-default
 * run document is unchanged), checks in mode off are never listed, and the list caps hold
 * (hits ≤ 50, related ≤ 20, proposed_learnings ≤ 3; labels are unique).
 */
export function normalizeExtras(extras: RunExtras): RunExtras {
  const out: RunExtras = {};
  if (extras.context) out.context = { ...extras.context };
  if (extras.tools && (extras.tools.runs.length > 0 || extras.tools.hits.length > 0)) {
    out.tools = {
      runs: extras.tools.runs.map((r) => ({ ...r })),
      hits: extras.tools.hits.slice(0, MAX_RUN_TOOL_HITS).map((h) => ({ ...h })),
    };
  }
  // The type already excludes "off"; the check guards values built from config at run time.
  const checks = (extras.checks ?? []).filter((c) => (c.mode as string) !== "off");
  if (checks.length > 0) out.checks = checks.map((c) => ({ ...c }));
  if (extras.effort) out.effort = { ...extras.effort };
  if (extras.risk) out.risk = extras.risk;
  const labels = [...new Set(extras.labels ?? [])];
  if (labels.length > 0) out.labels = labels;
  const related = (extras.related ?? []).slice(0, MAX_RUN_RELATED);
  if (related.length > 0) out.related = related.map((r) => ({ ...r }));
  const reviewers = extras.reviewers ?? [];
  if (reviewers.length > 0) out.reviewers = reviewers.map((r) => ({ ...r }));
  const learnings = (extras.proposed_learnings ?? []).slice(0, MAX_PROPOSED_LEARNINGS);
  if (learnings.length > 0) out.proposed_learnings = learnings.map((l) => ({ ...l, paths: [...l.paths] }));
  return out;
}

/** The E4 field order of the design-v2 run-document fields. */
const EXTRA_KEYS = [
  "context",
  "tools",
  "checks",
  "effort",
  "risk",
  "labels",
  "related",
  "reviewers",
  "proposed_learnings",
] as const satisfies readonly (keyof RunExtras)[];

/**
 * JSON form for writing, matching the strict eval schema: `failure_scenario` is renderer-only and
 * always dropped; `rule` is written only when non-blank (E4: `string | null`, non-empty when set);
 * synthetic findings have no location, so path/line/end_line/side go too. The design-v2 fields
 * follow `findings`, each only when non-empty.
 */
export function toRunDocumentJSON(doc: RunDocument): Record<string, unknown> {
  const extras = normalizeExtras(doc);
  const json: Record<string, unknown> = {
    schema_version: doc.schema_version,
    run: { ...doc.run, sources: [...doc.run.sources] },
    verdict: doc.verdict,
    findings: doc.findings.map((f) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { failure_scenario, rule, ...kept } = f;
      const withRule = rule !== null && rule.trim() !== "" ? { ...kept, rule } : kept;
      if (!f.synthetic) return { ...withRule, sources: [...f.sources] };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { path, line, end_line, side, ...rest } = withRule;
      return { ...rest, sources: [...f.sources] };
    }),
  };
  for (const key of EXTRA_KEYS) if (extras[key] !== undefined) json[key] = extras[key];
  return json;
}

export function serializeRunDocument(doc: RunDocument): string {
  return `${JSON.stringify(toRunDocumentJSON(doc), null, 2)}\n`;
}

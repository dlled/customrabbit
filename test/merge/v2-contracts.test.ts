// design-v2 P0 merge contracts: generic externalSupport (§7.4.3), engine v2 fields with label and
// candidate filtering (§4.5, §4.6), generic syntheticBlockers (§5.3, §7.5) with a verdict truth
// table, and the run-document fields mirrored from the E4 schema.

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import { mergeReview } from "../../src/merge/merge.js";
import { buildRunDocument, evalVerdict, normalizeExtras, toRunDocumentJSON } from "../../src/merge/run-document.js";
import type { CoverageGap, ExternalSupport, PriorThread } from "../../src/merge/types.js";
import { computeVerdict, syntheticFinding, type SyntheticBlocker } from "../../src/merge/verdict.js";
import {
  MAX_PROPOSED_LEARNINGS,
  MAX_RUN_RELATED,
  MAX_RUN_TOOL_HITS,
  RISKS,
  SYNTHETIC_BLOCKER_KINDS,
  TOOL_NAMES,
  TOOL_RUN_STATUSES,
  type MergedFinding,
  type RunExtras,
  type ToolHit,
} from "../../src/types.js";
import { engineFinding, merged, options, output, prior } from "./helpers.js";

const schema = JSON.parse(
  readFileSync(new URL("../../eval/schema/findings.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(schema);

function expectValid(doc: unknown): void {
  const ok = validate(doc);
  expect(ok ? [] : validate.errors).toEqual([]);
}

const SA_RULE = "shellcheck:SC2086";

describe("externalSupport (§7.4.3)", () => {
  async function run(finding: Parameters<typeof engineFinding>[0], support?: ExternalSupport[]) {
    const verify = vi.fn(() => Promise.resolve({ confirmed: false, reason: "no", evidence: [] }));
    const r = await mergeReview(
      [{ engine: "claude", output: output([engineFinding(finding)]) }],
      options({ verify, ...(support ? { externalSupport: support } : {}) }),
    );
    return { f: r.findings[0], calls: verify.mock.calls.length, verifyCalls: r.verifyCalls };
  }

  it("counts a matching single-source finding as verified, with no verify call", async () => {
    const r = await run({ rule: SA_RULE, line: 5, end_line: 7 }, [{ path: "src/util.ts", line: 6, rule: SA_RULE }]);
    expect(r.f).toMatchObject({ verification: "verified", blocking: true });
    expect([r.calls, r.verifyCalls]).toEqual([0, 0]);
  });

  it.each([
    ["no support", { rule: SA_RULE }, undefined],
    ["another rule", { rule: SA_RULE }, [{ path: "src/util.ts", line: 5, rule: "shellcheck:SC2046" }]],
    ["another path", { rule: SA_RULE }, [{ path: "src/auth.ts", line: 5, rule: SA_RULE }]],
    ["a line outside the range", { rule: SA_RULE, line: 5, end_line: 6 }, [{ path: "src/util.ts", line: 7, rule: SA_RULE }]],
    ["no rule on the finding", { rule: null }, [{ path: "src/util.ts", line: 5, rule: SA_RULE }]],
  ] as const)("still verifies with %s", async (_name, finding, support) => {
    const r = await run(finding, support ? [...support] : undefined);
    expect(r.calls).toBe(1);
    expect(r.f).toMatchObject({ verification: "rejected", blocking: false });
  });

  it("does not touch findings that need no verification", async () => {
    const support = [{ path: "src/util.ts", line: 5, rule: SA_RULE }];
    const minor = await run({ rule: SA_RULE, severity: "minor" }, support);
    expect(minor.f).toMatchObject({ verification: "not_needed", blocking: false });
    const both = await mergeReview(
      [
        { engine: "claude", output: output([engineFinding({ rule: SA_RULE })]) },
        { engine: "codex", output: output([engineFinding({ rule: SA_RULE })]) },
      ],
      options({ externalSupport: support }),
    );
    expect(both.findings[0]?.verification).toBe("agreed");
  });
});

describe("engine v2 fields in the merge (§8)", () => {
  const v2 = {
    effort: { score: 4, minutes: 45 },
    checks: [{ name: "title", status: "fail", explanation: "Not imperative." }, { name: "", status: "pass", explanation: "" }],
    labels: ["bug", "bug", "invented"],
    related: [{ number: 7, reason: "same crash" }, { number: 7, reason: "dup" }, { number: 99, reason: "not a candidate" }],
  };

  it("keeps valid values, labels from the config list and candidate numbers only", async () => {
    const r = await mergeReview(
      [{ engine: "codex", output: { ...(output([]) as object), ...v2 } }],
      options({ labelNames: new Set(["bug", "docs"]), candidateNumbers: new Set([7, 8]) }),
    );
    expect(r.engineSummaries[0]).toEqual({
      engine: "codex",
      summary: "A change.",
      changes: [],
      effort: { score: 4, minutes: 45 },
      checks: [{ name: "title", status: "fail", explanation: "Not imperative." }],
      labels: ["bug"],
      related: [{ number: 7, reason: "same crash" }],
    });
  });

  it("keeps no labels or related items when the run gave no list, and drops invalid values", async () => {
    const r = await mergeReview(
      [{ engine: "claude", output: { ...(output([]) as object), ...v2, effort: { score: 0, minutes: 1 } } }],
      options(),
    );
    expect(Object.keys(r.engineSummaries[0] ?? {})).toEqual(["engine", "summary", "changes", "checks"]);
  });

  it("leaves a v1 engine summary unchanged", async () => {
    const r = await mergeReview([{ engine: "claude", output: output([]) }], options());
    expect(r.engineSummaries).toEqual([{ engine: "claude", summary: "A change.", changes: [] }]);
  });
});

describe("syntheticBlockers (§5.3, §7.5) verdict truth table", () => {
  const BLOCKERS: Record<(typeof SYNTHETIC_BLOCKER_KINDS)[number], SyntheticBlocker> = {
    check: { kind: "check", severity: "major", title: "Pre-merge check failed: title — not imperative" },
    secret: { kind: "secret", severity: "critical", title: "Possible secret committed (`aws-key`) at `a.env:3`" },
    coverage: { kind: "coverage", severity: "major", title: "Secret scan did not run (timeout)" },
  };
  const subsets = (1 << SYNTHETIC_BLOCKER_KINDS.length);
  const rows: [boolean, boolean, boolean, number][] = [];
  for (const finding of [false, true])
    for (const thread of [false, true])
      for (const coverage of [false, true]) for (let mask = 0; mask < subsets; mask++) rows.push([finding, thread, coverage, mask]);

  it.each(rows)("finding=%s thread=%s coverage=%s synthetic-mask=%d", (finding, thread, coverage, mask) => {
    const findings: MergedFinding[] = [merged({ blocking: finding })];
    const threads: PriorThread[] = [prior({ state: thread ? "open" : "addressed" })];
    const gap: CoverageGap | null = coverage ? { notReviewed: 2, limit: "max_files 1" } : null;
    const blockers = SYNTHETIC_BLOCKER_KINDS.filter((_, i) => (mask & (1 << i)) !== 0).map((k) => BLOCKERS[k]);
    const expected = finding || thread || coverage || blockers.length > 0 ? "REQUEST_CHANGES" : "APPROVE";

    const v = computeVerdict({
      findings,
      priorThreads: threads,
      threshold: "major",
      coverage: gap,
      sources: ["claude"],
      syntheticBlockers: blockers,
    });
    expect(v.verdict).toBe(expected);
    expect(v.synthetic.map((s) => s.summary)).toEqual(blockers.map((b) => b.title));
    expect(v.synthetic.every((s) => s.synthetic && s.blocking && s.status === "new")).toBe(true);

    const doc = buildRunDocument({
      promptVersion: "p1",
      sources: ["claude"],
      verdict: v.verdict,
      findings,
      coverage: v.coverage,
      synthetic: v.synthetic,
      priorThreads: threads,
      threshold: "major",
    });
    expect(evalVerdict(doc.findings)).toBe(expected);
    expectValid(toRunDocumentJSON(doc));
  });

  it("blocks whatever the threshold, keeps the given severity and has no location in the JSON", () => {
    const v = computeVerdict({
      findings: [],
      priorThreads: [],
      threshold: "critical",
      coverage: null,
      sources: ["claude", "codex"],
      syntheticBlockers: [BLOCKERS.check],
    });
    expect(v.verdict).toBe("REQUEST_CHANGES");
    expect(v.synthetic[0]).toMatchObject({ severity: "major", category: "maintainability", sources: ["claude", "codex"] });
    const json = toRunDocumentJSON(
      buildRunDocument({
        promptVersion: "p1", sources: ["claude"], verdict: v.verdict, findings: [], coverage: null,
        synthetic: v.synthetic, priorThreads: [], threshold: "critical",
      }),
    ) as { findings: Record<string, unknown>[] };
    for (const k of ["path", "line", "end_line", "side"]) expect(json.findings[0]).not.toHaveProperty(k);
    expect(syntheticFinding(BLOCKERS.secret, ["codex"]).category).toBe("security");
  });

  it("without blockers, matches the v1 verdict result plus empty synthetic lists", () => {
    const v = computeVerdict({ findings: [], priorThreads: [], threshold: "major", coverage: null, sources: ["claude"] });
    expect(v).toEqual({
      verdict: "APPROVE",
      blockingFindings: [],
      blockingThreads: [],
      coverage: null,
      synthetic: [],
      syntheticItems: [],
    });
  });
});

describe("run-document fields (E4)", () => {
  const hit = (i: number): ToolHit => ({ tool: "shellcheck", rule: "SC2086", path: "a.sh", line: i + 1, message: "quote" });
  const full: RunExtras = {
    context: { symbols: 14, usages: 41, resolver: "tree-sitter+ts", dropped: 2 },
    tools: {
      runs: TOOL_RUN_STATUSES.map((status, i) => ({ tool: TOOL_NAMES[i] ?? "ruff", status, files: i })),
      hits: Array.from({ length: MAX_RUN_TOOL_HITS + 10 }, (_, i) => ({ ...hit(i), confirmed: i === 0 })),
    },
    checks: [
      { name: "title", mode: "warning", status: "pass", explanation: "ok" },
      { name: "description", mode: "off" as never, status: "fail", explanation: "never listed" },
      { name: "No TODOs", mode: "error", status: "inconclusive", explanation: "" },
    ],
    effort: { score: 5, minutes: 90 },
    risk: "moderate",
    labels: ["bug", "bug", "breaking"],
    related: Array.from({ length: MAX_RUN_RELATED + 5 }, (_, i) => ({ number: i + 1, kind: i % 2 ? "pr" : "issue", reason: "r" })),
    reviewers: [{ login: "dlled", reason: "codeowners" }, { login: "someone", reason: "recent_changes" }],
    proposed_learnings: Array.from({ length: MAX_PROPOSED_LEARNINGS + 2 }, (_, i) => ({
      title: `T${i}`, rule: "One rule.", paths: i ? ["src/**"] : [], fingerprint: "0123456789ab", source: "claude",
    })),
  };

  function doc(extras?: RunExtras) {
    return buildRunDocument({
      promptVersion: "p1",
      sources: ["claude"],
      verdict: "APPROVE",
      findings: [merged()],
      coverage: null,
      priorThreads: [],
      threshold: "major",
      ...(extras ? { extras } : {}),
    });
  }

  it("leaves every v2 field out with defaults, so the v1 document is unchanged", () => {
    for (const d of [doc(), doc({}), doc({ checks: [], labels: [], related: [], reviewers: [], proposed_learnings: [], tools: { runs: [], hits: [] } })]) {
      const json = toRunDocumentJSON(d);
      expect(Object.keys(json)).toEqual(["schema_version", "run", "verdict", "findings"]);
      expect(Object.keys(d)).toEqual(["schema_version", "run", "verdict", "findings"]);
      expectValid(json);
    }
  });

  it("writes every field in E4 order, within the caps, and validates", () => {
    const d = doc(full);
    const json = toRunDocumentJSON(d) as Record<string, unknown> & { tools: { hits: unknown[] }; checks: { name: string }[] };
    expect(Object.keys(json)).toEqual([
      "schema_version", "run", "verdict", "findings",
      "context", "tools", "checks", "effort", "risk", "labels", "related", "reviewers", "proposed_learnings",
    ]);
    expect(json.tools.hits).toHaveLength(MAX_RUN_TOOL_HITS);
    expect(json.checks.map((c) => c.name)).toEqual(["title", "No TODOs"]);
    expect(json.labels).toEqual(["bug", "breaking"]);
    expect(json.related).toHaveLength(MAX_RUN_RELATED);
    expect(json.proposed_learnings).toHaveLength(MAX_PROPOSED_LEARNINGS);
    expectValid(json);
    // In memory and in JSON the same normalisation applies.
    expect(normalizeExtras(d)).toEqual(normalizeExtras(full));
  });

  it("accepts every risk value, and the E4 schema rejects one we would never write", () => {
    for (const risk of RISKS) expectValid(toRunDocumentJSON(doc({ risk })));
    const bad = { ...toRunDocumentJSON(doc()), risk: "Low" };
    expect(validate(bad)).toBe(false);
  });

  it("copies the extras, so later changes to the input never leak into the document", () => {
    const extras: RunExtras = { labels: ["bug"], effort: { score: 1, minutes: 1 } };
    const d = doc(extras);
    extras.labels?.push("late");
    if (extras.effort) extras.effort.score = 5;
    expect(d.labels).toEqual(["bug"]);
    expect(d.effort).toEqual({ score: 1, minutes: 1 });
  });
});

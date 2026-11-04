// Validates myrabbit run documents (§5.2) against the evaluator's schema, so src/types.ts and
// eval/schema/findings.schema.json cannot drift apart.

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { mergeReview } from "../../src/merge/merge.js";
import {
  buildRunDocument,
  evalVerdict,
  serializeRunDocument,
  toRunDocumentJSON,
} from "../../src/merge/run-document.js";
import { MERGE_VERSION, NoEngineOutputError, type PriorThread } from "../../src/merge/types.js";
import { computeVerdict } from "../../src/merge/verdict.js";
import { coverageFinding } from "../../src/merge/coverage.js";
import {
  FINDING_STATUSES,
  VERIFICATIONS,
  type EngineName,
  type MergedFinding,
  type RunDocument,
} from "../../src/types.js";
import { fingerprint } from "../../src/merge/fingerprint.js";
import { engineFinding, fixture, merged, options, output, prior } from "./helpers.js";

const schema = JSON.parse(
  readFileSync(new URL("../../eval/schema/findings.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
// strictRequired is off: the schema's `if/then` puts `required` in a branch without `properties`,
// which is valid JSON Schema but trips that one strict-mode check.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(schema);

function expectValid(doc: unknown): void {
  const ok = validate(doc);
  expect(ok ? [] : validate.errors).toEqual([]);
}

/** The scorer's rule (eval/scripts/score.ts isLive): history never blocks. */
function scorerVerdict(doc: { findings: { blocking: boolean; status?: string }[] }): string {
  const live = doc.findings.some(
    (f) => f.blocking && !["addressed", "superseded", "dismissed"].includes(f.status ?? "new"),
  );
  return live ? "REQUEST_CHANGES" : "APPROVE";
}

async function fixtureRun(threads: PriorThread[], notReviewed = 0): Promise<RunDocument> {
  const merge = await mergeReview(
    [
      { engine: "claude", output: fixture("claude-output.json") },
      { engine: "codex", output: fixture("codex-output.json") },
    ],
    options({ priorThreads: threads }),
  );
  const coverage = notReviewed > 0 ? { notReviewed, limit: "max_files 150" } : null;
  const v = computeVerdict({
    findings: merge.findings,
    priorThreads: threads,
    threshold: "major",
    coverage,
    sources: merge.sources,
  });
  return buildRunDocument({
    promptVersion: "p-test",
    sources: merge.sources,
    verdict: v.verdict,
    findings: merge.findings,
    coverage: v.coverage,
    priorThreads: threads,
    threshold: "major",
  });
}

const HISTORY: PriorThread[] = [
  prior({ marker: { v: 1, fp: "111111111111", sev: "major", blk: true }, state: "open" }),
  prior({ marker: { v: 1, fp: "222222222222", sev: "critical", blk: true }, state: "addressed", end_line: 22 }),
  prior({ marker: { v: 1, fp: "333333333333", sev: "major", blk: true }, state: "dismissed", sources: [] }),
  prior({ marker: { v: 1, fp: "444444444444", sev: "minor", blk: false }, state: "open", confidence: null }),
];

describe("run document vs eval/schema/findings.schema.json", () => {
  it("accepts the fixture run with history and a coverage finding", async () => {
    const doc = await fixtureRun(HISTORY, 2);
    const json = toRunDocumentJSON(doc);
    expectValid(json);
    expectValid(JSON.parse(serializeRunDocument(doc)));
    expect(doc.verdict).toBe("REQUEST_CHANGES");
    expect(scorerVerdict(json as never)).toBe(doc.verdict);
    expect(doc.run).toEqual({ prompt_version: "p-test", merge_version: MERGE_VERSION, sources: ["claude", "codex"] });
    expect(doc.findings.map((f) => f.status)).toEqual([
      "new", "new", "new", "new", "new", "new", "open", "addressed", "dismissed", "open",
    ]);
  });

  it("omits the synthetic finding's location in the JSON form; placeholders would fail", async () => {
    const doc = await fixtureRun([], 3);
    const json = toRunDocumentJSON(doc) as { findings: Record<string, unknown>[] };
    const synthetic = json.findings.find((f) => f.synthetic === true);
    expect(synthetic).toBeDefined();
    for (const k of ["path", "line", "end_line", "side"]) expect(synthetic).not.toHaveProperty(k);
    expect(synthetic).toMatchObject({ blocking: true, severity: "critical", sources: ["claude", "codex"] });
    expectValid(json);

    // The in-memory placeholders (path "", line 0) are not schema-valid on their own.
    expect(validate(JSON.parse(JSON.stringify(doc)))).toBe(false);
  });

  it("accepts an APPROVE run whose blockers are all history", () => {
    const threads = [prior({ state: "addressed" }), prior({ state: "dismissed" })];
    const doc = buildRunDocument({
      promptVersion: "p1",
      sources: ["codex"],
      verdict: "APPROVE",
      findings: [merged({ severity: "minor", sources: ["codex"] })],
      coverage: null,
      priorThreads: threads,
      threshold: "major",
    });
    const json = toRunDocumentJSON(doc);
    expectValid(json);
    expect(scorerVerdict(json as never)).toBe("APPROVE");
    // History keeps its blocking flag for audit; the scorer and the verdict ignore it.
    expect(doc.findings.filter((f) => f.status !== "new").every((f) => f.blocking)).toBe(true);
  });

  it("accepts every status, verification, side and nullable value myrabbit emits", () => {
    const findings: MergedFinding[] = [
      ...FINDING_STATUSES.map((status) => merged({ status })),
      ...VERIFICATIONS.map((verification) => merged({ verification })),
      merged({ side: "LEFT", end_line: 9, suggestion: null, outside_diff: true }),
      merged({ suggestion: "x", end_line: null, confidence: 0 }),
      merged({ confidence: 1, sources: ["claude", "codex"] }),
      coverageFinding({ notReviewed: 1, limit: "max_files 1" }, ["claude"]),
    ];
    const doc: RunDocument = {
      schema_version: "1",
      run: { prompt_version: "p1", merge_version: MERGE_VERSION, sources: ["claude"] },
      verdict: "REQUEST_CHANGES",
      findings,
    };
    expectValid(toRunDocumentJSON(doc));
  });

  it("accepts a superseded prior thread, which is history for the scorer", async () => {
    const fp = fingerprint("src/util.ts", "correctness", "Off-by-one in page end index");
    const thread = prior({ marker: { v: 1, fp, sev: "major", blk: false }, path: "src/util.ts", line: 5 });
    const f = engineFinding();
    const merge = await mergeReview(
      [
        { engine: "claude", output: output([f]) },
        { engine: "codex", output: output([f]) },
      ],
      options({ priorThreads: [thread] }),
    );
    const v = computeVerdict({
      findings: merge.findings,
      priorThreads: merge.priorThreads,
      threshold: "major",
      coverage: null,
      sources: merge.sources,
    });
    const doc = buildRunDocument({
      promptVersion: "p1",
      sources: merge.sources,
      verdict: v.verdict,
      findings: merge.findings,
      coverage: null,
      priorThreads: merge.priorThreads,
      threshold: "major",
    });
    const json = toRunDocumentJSON(doc);
    expectValid(json);
    expect(doc.findings.map((x) => x.status)).toEqual(["new", "superseded"]);
    expect(doc.verdict).toBe("REQUEST_CHANGES");
    expect(scorerVerdict(json as never)).toBe(doc.verdict);
  });

  it("agrees with the scorer that every history status is ignored, even if blocking", () => {
    for (const status of FINDING_STATUSES) {
      const findings = [merged({ blocking: true, status })];
      expect(evalVerdict(findings)).toBe(scorerVerdict({ findings }));
    }
  });

  it("drops the renderer-only failure_scenario and writes rule only when non-blank (E4)", async () => {
    const doc = await fixtureRun(HISTORY, 1);
    expect(doc.findings.some((f) => f.rule !== null)).toBe(true);
    const json = toRunDocumentJSON(doc) as { findings: Record<string, unknown>[] };
    for (const [i, f] of json.findings.entries()) {
      expect(f).not.toHaveProperty("failure_scenario");
      const rule = doc.findings[i]?.rule ?? null;
      if (rule === null || rule.trim() === "") expect(f).not.toHaveProperty("rule");
      else expect(f.rule).toBe(rule);
    }
    expect(json.findings.filter((f) => "rule" in f)).toHaveLength(1);
    expectValid(json);
    // A blank rule would fail E4's minLength, so it is left out.
    const blank = toRunDocumentJSON({ ...doc, findings: [merged({ rule: "  " })] }) as { findings: Record<string, unknown>[] };
    expect(blank.findings[0]).not.toHaveProperty("rule");
    expectValid(blank);
    // Without the projection, the in-memory findings fail the schema.
    const raw = JSON.parse(JSON.stringify(doc)) as { findings: Record<string, unknown>[] };
    raw.findings = raw.findings.filter((f) => f.synthetic !== true);
    expect(validate(raw)).toBe(false);
  });

  it("is strict: unknown keys or empty sources fail", () => {
    const base = toRunDocumentJSON({
      schema_version: "1",
      run: { prompt_version: "p1", merge_version: "m1", sources: ["claude"] },
      verdict: "APPROVE",
      findings: [merged()],
    }) as { findings: Record<string, unknown>[] };
    expectValid(base);
    const extra = structuredClone(base);
    (extra.findings[0] as Record<string, unknown>).secret = "x";
    expect(validate(extra)).toBe(false);
    const noSources = structuredClone(base);
    (noSources.findings[0] as Record<string, unknown>).sources = [] as EngineName[];
    expect(validate(noSources)).toBe(false);
  });
});

describe("run document consistency", () => {
  it("refuses a run with no contributing engine (§2.2)", () => {
    expect(() =>
      buildRunDocument({
        promptVersion: "p1",
        sources: [],
        verdict: "APPROVE",
        findings: [],
        coverage: null,
        priorThreads: [],
        threshold: "major",
      }),
    ).toThrow(NoEngineOutputError);
  });

  it("lists a superseded prior thread with status superseded, never blocking", () => {
    const doc = buildRunDocument({
      promptVersion: "p1",
      sources: ["claude", "codex"],
      verdict: "REQUEST_CHANGES",
      findings: [merged({ blocking: true, sources: ["claude", "codex"], verification: "agreed" })],
      coverage: null,
      priorThreads: [
        prior({ marker: { v: 1, fp: "0123456789ab", sev: "major", blk: false }, state: "superseded" }),
      ],
      threshold: "major",
    });
    expect(doc.findings[1]).toMatchObject({ status: "superseded", blocking: false });
  });

  it("refuses a verdict that contradicts the findings", () => {
    const input = {
      promptVersion: "p1",
      sources: ["claude"] as EngineName[],
      findings: [merged({ blocking: true })],
      coverage: null,
      priorThreads: [],
      threshold: "major" as const,
    };
    expect(() => buildRunDocument({ ...input, verdict: "APPROVE" })).toThrow(/contradicts/);
    expect(buildRunDocument({ ...input, verdict: "REQUEST_CHANGES" }).verdict).toBe("REQUEST_CHANGES");
  });

  it("agrees with computeVerdict on every row of the prior-thread rule", () => {
    const rows: PriorThread[] = [];
    for (const sev of ["critical", "major", "minor", "trivial"] as const)
      for (const blk of [true, false])
        for (const state of ["open", "addressed", "dismissed"] as const)
          rows.push(prior({ marker: { v: 1, fp: "abcabcabcabc", sev, blk }, state }));
    for (const threshold of ["critical", "major", "minor"] as const) {
      for (const t of rows) {
        const v = computeVerdict({ findings: [], priorThreads: [t], threshold, coverage: null, sources: ["claude"] });
        const doc = buildRunDocument({
          promptVersion: "p1",
          sources: ["claude"],
          verdict: v.verdict,
          findings: [],
          coverage: null,
          priorThreads: [t],
          threshold,
        });
        expect(evalVerdict(doc.findings)).toBe(v.verdict);
        expectValid(toRunDocumentJSON(doc));
      }
    }
  });
});

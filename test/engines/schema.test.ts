import { describe, expect, it } from "vitest";
import {
  OutputValidationError,
  parseEngineOutput,
  parseResolveOutput,
  parseVerifyOutput,
  RESOLVE_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  VERIFY_OUTPUT_SCHEMA,
} from "../../src/engines/schema.js";
import { CATEGORIES, SEVERITIES } from "../../src/types.js";
import { reviewOutputFixture } from "./helpers.js";

// Keywords allowed by OpenAI strict structured outputs that are also draft-07.
const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum"]);

/** Fails unless `schema` is in the strict OpenAI form, which is a subset of draft-07. */
function assertStrict(schema: Record<string, unknown>, path = "$"): void {
  for (const key of Object.keys(schema)) {
    expect(ALLOWED_KEYWORDS.has(key), `${path}: keyword ${key}`).toBe(true);
  }
  const type = schema.type;
  const types = Array.isArray(type) ? type : [type];
  for (const t of types) {
    expect(["object", "array", "string", "integer", "number", "boolean", "null"], `${path}: type`).toContain(t);
  }
  if (types.includes("object")) {
    expect(schema.additionalProperties, `${path}: additionalProperties`).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.required, `${path}: required lists every property`).toEqual(Object.keys(props));
    for (const [k, v] of Object.entries(props)) assertStrict(v, `${path}.${k}`);
  }
  if (types.includes("array")) assertStrict(schema.items as Record<string, unknown>, `${path}[]`);
  if (schema.enum !== undefined) expect(Array.isArray(schema.enum)).toBe(true);
}

describe("JSON schemas", () => {
  it.each([
    ["review", REVIEW_OUTPUT_SCHEMA],
    ["verify", VERIFY_OUTPUT_SCHEMA],
    ["resolve", RESOLVE_OUTPUT_SCHEMA],
  ])("%s schema is strict-OpenAI form and draft-07", (_name, schema) => {
    assertStrict(schema);
    expect(schema.$schema).toBeUndefined();
  });

  it("review schema has no verdict and uses the shared enums", () => {
    const props = REVIEW_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["summary", "changes", "findings"]);
    const finding = (props.findings as { items: { properties: Record<string, { enum?: unknown[]; type: unknown }> } }).items;
    expect(finding.properties.severity?.enum).toEqual([...SEVERITIES]);
    expect(finding.properties.category?.enum).toEqual([...CATEGORIES]);
    expect(finding.properties.side?.enum).toEqual(["RIGHT", "LEFT"]);
    expect(finding.properties.end_line?.type).toEqual(["integer", "null"]);
    expect(finding.properties.rule?.type).toEqual(["string", "null"]);
    expect(finding.properties.suggestion?.type).toEqual(["string", "null"]);
    expect(Object.keys(finding.properties)).toEqual([
      "path", "line", "end_line", "side", "severity", "category", "title", "body",
      "failure_scenario", "evidence", "rule", "suggestion", "confidence",
    ]);
  });

  it("is plain JSON (serialisable for --output-schema)", () => {
    expect(JSON.parse(JSON.stringify(REVIEW_OUTPUT_SCHEMA))).toEqual(REVIEW_OUTPUT_SCHEMA);
  });
});

describe("zod parsers", () => {
  it("accepts the fixture", () => {
    const out = parseEngineOutput(reviewOutputFixture());
    expect(out.findings[0]?.severity).toBe("major");
  });

  it("rejects a verdict field (strict objects)", () => {
    expect(() => parseEngineOutput({ ...reviewOutputFixture(), verdict: "approve" })).toThrow(OutputValidationError);
  });

  it("rejects missing nullable fields, wrong enums and non-integer lines", () => {
    const base = reviewOutputFixture();
    const f = base.findings[0];
    if (f === undefined) throw new Error("fixture");
    const noRule: Partial<typeof f> = { ...f };
    delete noRule.rule;
    expect(() => parseEngineOutput({ ...base, findings: [noRule] })).toThrow(/findings\.0\.rule/);
    expect(() => parseEngineOutput({ ...base, findings: [{ ...f, severity: "nit" }] })).toThrow(/severity/);
    expect(() => parseEngineOutput({ ...base, findings: [{ ...f, line: 1.5 }] })).toThrow(/line/);
    expect(() => parseEngineOutput("not an object")).toThrow(/\(root\)/);
  });

  it("does not echo values in the error", () => {
    const base = reviewOutputFixture();
    try {
      parseEngineOutput({ ...base, summary: 12345678 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("12345678");
    }
  });

  it("parses verify and resolve outputs", () => {
    expect(parseVerifyOutput({ confirmed: true, reason: "r", evidence: ["a.ts:1"] }).confirmed).toBe(true);
    expect(parseResolveOutput({ fixed: false, reason: "r", evidence: [] }).fixed).toBe(false);
    expect(() => parseVerifyOutput({ confirmed: "yes", reason: "r", evidence: [] })).toThrow(OutputValidationError);
    expect(() => parseResolveOutput({ fixed: true, reason: "r" })).toThrow(/evidence/);
  });
});

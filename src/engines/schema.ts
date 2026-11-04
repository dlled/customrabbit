// Output schemas for the engines (design.md §5.1).
//
// Each JSON schema is written in the strict OpenAI form (every property listed in `required`,
// `additionalProperties: false` on every object, optional values as `type: [T, "null"]`), which is
// also valid JSON Schema draft-07. Codex sends it with `strict: true`; Claude needs draft-07.
// Keywords outside the strict-mode subset (minLength, maximum, pattern, …) are deliberately left
// out: content rules (lengths, non-empty evidence, anchors) are enforced by the merger (§7.2), so a
// single over-long title never discards a whole engine output.
//
// The zod parsers mirror the JSON schemas structurally and are what the adapters call on the
// model output (`EngineInput.parse`).

import { z } from "zod";
import {
  CATEGORIES,
  CHECK_STATUSES,
  SEVERITIES,
  SIDES,
  type EngineOutput,
  type ResolveOutput,
  type VerifyOutput,
} from "../types.js";

export type JsonSchema = Record<string, unknown>;

const str = { type: "string" } as const;
const strArray = { type: "array", items: str } as const;
const nullableStr = { type: ["string", "null"] } as const;

function object(properties: Record<string, unknown>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const FINDING_SCHEMA = object({
  path: str,
  line: { type: "integer" },
  end_line: { type: ["integer", "null"] },
  side: { type: "string", enum: [...SIDES] },
  severity: { type: "string", enum: [...SEVERITIES] },
  category: { type: "string", enum: [...CATEGORIES] },
  title: str,
  body: str,
  failure_scenario: str,
  evidence: strArray,
  rule: nullableStr,
  suggestion: nullableStr,
  confidence: { type: "number" },
});

/** §5.1 review output. No verdict field: models do not vote. */
export const REVIEW_OUTPUT_SCHEMA: JsonSchema = object({
  summary: str,
  changes: { type: "array", items: object({ area: str, files: strArray, summary: str }) },
  findings: { type: "array", items: FINDING_SCHEMA },
});

/** design-v2 §8: which v2 fields a review asks for. Each is on only while its feature is. */
export interface ReviewSchemaFeatures {
  /** §4.1 `walkthrough.effort`. */
  effort?: boolean;
  /** §5.1: some model-judged pre-merge check is not off. */
  checks?: boolean;
  /** §4.5: `labels` is non-empty. */
  labels?: boolean;
  /** §4.6: related candidates are in the prompt. */
  related?: boolean;
}

const V2_FIELDS = {
  effort: object({ score: { type: "integer" }, minutes: { type: "integer" } }),
  checks: {
    type: "array",
    items: object({ name: str, status: { type: "string", enum: [...CHECK_STATUSES] }, explanation: str }),
  },
  labels: strArray,
  related: { type: "array", items: object({ number: { type: "integer" }, reason: str }) },
} as const;

/**
 * §5.1 review output with the v2 fields that are on (design-v2 §8), still strict: each added
 * field is required. With no feature on this is exactly {@link REVIEW_OUTPUT_SCHEMA}.
 */
export function reviewOutputSchema(features: ReviewSchemaFeatures = {}): JsonSchema {
  const keys = (Object.keys(V2_FIELDS) as (keyof typeof V2_FIELDS)[]).filter((k) => features[k] === true);
  if (keys.length === 0) return REVIEW_OUTPUT_SCHEMA;
  const base = REVIEW_OUTPUT_SCHEMA.properties as Record<string, unknown>;
  return object({ ...base, ...Object.fromEntries(keys.map((k) => [k, V2_FIELDS[k]])) });
}

/** §6.3 verify output. */
export const VERIFY_OUTPUT_SCHEMA: JsonSchema = object({
  confirmed: { type: "boolean" },
  reason: str,
  evidence: strArray,
});

/** §6.4 resolve output. */
export const RESOLVE_OUTPUT_SCHEMA: JsonSchema = object({
  fixed: { type: "boolean" },
  reason: str,
  evidence: strArray,
});

// ---------------------------------------------------------------------------
// zod mirrors
// ---------------------------------------------------------------------------

const findingZ = z.strictObject({
  path: z.string(),
  line: z.number().int(),
  end_line: z.number().int().nullable(),
  side: z.enum(SIDES),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string(),
  body: z.string(),
  failure_scenario: z.string(),
  evidence: z.array(z.string()),
  rule: z.string().nullable(),
  suggestion: z.string().nullable(),
  confidence: z.number(),
});

// design-v2 §8 fields, lenient: a missing or invalid value is "not provided" (undefined), and an
// invalid list item is dropped, so they never cost the engine its whole output.

const effortZ = z.strictObject({ score: z.int().min(1).max(5), minutes: z.int().min(0) });
const checkZ = z.strictObject({ name: z.string().trim().min(1), status: z.enum(CHECK_STATUSES), explanation: z.string() });
const relatedZ = z.strictObject({ number: z.int().min(1), reason: z.string().trim().min(1) });

/** A list whose invalid items are dropped; anything but an array is "not provided". */
function lenientList<T>(item: z.ZodType<T>): z.ZodType<T[] | undefined> {
  return z
    .unknown()
    .optional()
    .transform((v) =>
      Array.isArray(v)
        ? v.flatMap((x) => {
            const r = item.safeParse(x);
            return r.success ? [r.data] : [];
          })
        : undefined,
    );
}

const v2FieldsZ = {
  effort: z
    .unknown()
    .optional()
    .transform((v) => {
      const r = effortZ.safeParse(v);
      return r.success ? r.data : undefined;
    }),
  checks: lenientList(checkZ),
  labels: lenientList(z.string().trim().min(1)),
  related: lenientList(relatedZ),
};

export const engineOutputZ = z
  .strictObject({
    summary: z.string(),
    changes: z.array(z.strictObject({ area: z.string(), files: z.array(z.string()), summary: z.string() })),
    findings: z.array(findingZ),
    ...v2FieldsZ,
  })
  .transform((o): EngineOutput => {
    const { effort, checks, labels, related, ...v1 } = o;
    return {
      ...v1,
      ...(effort === undefined ? {} : { effort }),
      ...(checks === undefined ? {} : { checks }),
      ...(labels === undefined ? {} : { labels }),
      ...(related === undefined ? {} : { related }),
    };
  });

export type ReviewExtras = Pick<EngineOutput, "effort" | "checks" | "labels" | "related">;

/**
 * The v2 fields of a raw engine output, leniently (for the merger, design-v2 §8). Keys that are
 * missing or invalid are left out; never throws.
 */
export function parseReviewExtras(raw: unknown): ReviewExtras {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: ReviewExtras = {};
  const effort = v2FieldsZ.effort.parse(rec.effort);
  if (effort !== undefined) out.effort = effort;
  const checks = v2FieldsZ.checks.parse(rec.checks);
  if (checks !== undefined) out.checks = checks;
  const labels = v2FieldsZ.labels.parse(rec.labels);
  if (labels !== undefined) out.labels = labels;
  const related = v2FieldsZ.related.parse(rec.related);
  if (related !== undefined) out.related = related;
  return out;
}

export const verifyOutputZ = z.strictObject({
  confirmed: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

export const resolveOutputZ = z.strictObject({
  fixed: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

/** Short, model-facing description of a zod failure (paths and messages, never values). */
export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputValidationError";
  }
}

function parser<T>(schema: z.ZodType<T>): (raw: unknown) => T {
  return (raw) => {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
    throw new OutputValidationError(`output does not match the schema: ${issues.join("; ")}`);
  };
}

export const parseEngineOutput: (raw: unknown) => EngineOutput = parser(engineOutputZ);
export const parseVerifyOutput: (raw: unknown) => VerifyOutput = parser(verifyOutputZ);
export const parseResolveOutput: (raw: unknown) => ResolveOutput = parser(resolveOutputZ);

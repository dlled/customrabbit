// Zod schema for `.myrabbit.yaml` v1 (design.md §4).
//
// Every key is optional; a missing key takes the default below. Objects are strict, so an unknown
// key is a validation error, and any validation error makes the loader ignore the whole file (§4).
// `schema/myrabbit.schema.json` is generated from this schema (`z.toJSONSchema`, io: "input");
// test/config/json-schema.test.ts fails when the two drift.

import { z } from "zod";
import {
  BUILTIN_CHECKS,
  CHECK_MODES,
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  PROFILES,
  RULE_PACK_NAMES,
  THRESHOLDS,
  TOOL_NAMES,
  type Config,
  type RulePackName,
  type ToolName,
} from "../types.js";

export const MAX_TONE_CHARS = 250;
export const MAX_PATH_INSTRUCTION_CHARS = 20_000;
/** Job timeout is 30 minutes (§10); leave room for prepare, verify, resolve and posting. */
export const MAX_ENGINE_TIMEOUT_MINUTES = 25;
/** GitHub accepts at most 30 inline comments per review in practice (§8.5). */
export const MAX_INLINE_COMMENTS = 30;

const nonEmpty = z.string().regex(/\S/, { message: "must not be blank" });

/** A glob, optionally negated with a leading "!" (but not "!" alone). */
const filterPattern = z
  .string()
  .min(1)
  .regex(/^(?!!?\s*$)/, { message: 'must not be empty or "!" alone' });

/** A repo-relative file path: no leading "/", no "..", no backslashes. */
const repoPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\\)(?!(?:.*\/)?\.\.(?:\/|$))(?!\s*$)/, {
    message: 'must be a repo-relative path without "..", "\\" or a leading "/"',
  });

const styleGuideSchema = z.strictObject({
  auto: z.boolean().default(true),
  files: z.array(repoPath).default([]),
});

const pathInstructionSchema = z.strictObject({
  path: nonEmpty,
  instructions: nonEmpty.max(MAX_PATH_INSTRUCTION_CHARS),
});

const autoReviewSchema = z.strictObject({
  enabled: z.boolean().default(true),
  drafts: z.boolean().default(false),
  ignore_title_keywords: z.array(nonEmpty).default(["WIP", "[skip review]"]),
  labels: z.array(filterPattern).default(["!no-myrabbit"]),
});

const claudeSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: nonEmpty.default("claude-opus-5-5"),
  effort: z.enum(CLAUDE_EFFORTS).default("high"),
  max_turns: z.int().min(1).max(200).default(40),
  max_budget_usd: z.number().positive().max(100).default(3),
});

const codexSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** null = Codex CLI recommended model. */
  model: nonEmpty.nullable().default(null),
  effort: z.enum(CODEX_EFFORTS).default("high"),
});

const enginesSchema = z
  .strictObject({
    claude: claudeSchema.prefault({}),
    codex: codexSchema.prefault({}),
    timeout_minutes: z.int().min(1).max(MAX_ENGINE_TIMEOUT_MINUTES).default(12),
  })
  .refine((e) => e.claude.enabled || e.codex.enabled, {
    message: "at least one engine must be enabled",
  })
  // The same rule for editors; zod refinements do not appear in the generated JSON Schema.
  .meta({
    not: {
      type: "object",
      properties: {
        claude: { type: "object", properties: { enabled: { const: false } }, required: ["enabled"] },
        codex: { type: "object", properties: { enabled: { const: false } }, required: ["enabled"] },
      },
      required: ["claude", "codex"],
    },
  });

const limitsSchema = z.strictObject({
  max_files: z.int().min(1).default(150),
  max_diff_bytes: z.int().min(1).default(400_000),
  max_inline_comments: z.int().min(0).max(MAX_INLINE_COMMENTS).default(15),
});

// ---------------------------------------------------------------------------
// design-v2 §2. P0 ships every feature off/false; each feature flips its own default in a later
// one-line change, once its eval delta lands. Until then a v2 build reviews exactly like v1.
// ---------------------------------------------------------------------------

export const MAX_CONTEXT_CHARS = 200_000;
export const MAX_CUSTOM_CHECKS = 5;
export const MAX_CHECK_NAME_CHARS = 50;
export const MAX_CHECK_INSTRUCTION_CHARS = 10_000;
export const MAX_LABELS = 30;
export const MAX_LABEL_CHARS = 50;
export const MAX_LABEL_INSTRUCTION_CHARS = 1_000;

const contextSchema = z.strictObject({
  enabled: z.boolean().default(false),
  max_chars: z.int().min(1).max(MAX_CONTEXT_CHARS).default(60_000),
  max_usages_per_symbol: z.int().min(1).max(50).default(8),
  typescript: z.boolean().default(false),
});

const rulePacksSchema = z.strictObject(
  Object.fromEntries(RULE_PACK_NAMES.map((name) => [name, z.boolean().default(false)])) as Record<
    RulePackName,
    z.ZodDefault<z.ZodBoolean>
  >,
);

const learningsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  propose: z.boolean().default(false),
});

const walkthroughSchema = z.strictObject({
  effort: z.boolean().default(false),
  merge_risk: z.boolean().default(false),
  ai_agent_prompts: z.boolean().default(false),
  related: z.boolean().default(false),
  suggested_reviewers: z.boolean().default(false),
});

/** A label name: one line, no surrounding blanks. */
const labelName = z
  .string()
  .min(1)
  .max(MAX_LABEL_CHARS)
  .regex(/^\S(?:[^\r\n]*\S)?$/, { message: "must be one line without leading or trailing blanks" });

const labelSchema = z.strictObject({
  label: labelName,
  instructions: z.string().max(MAX_LABEL_INSTRUCTION_CHARS).default(""),
});

const checkMode = z.enum(CHECK_MODES).default("off");

const modelCheckSchema = z.strictObject({
  mode: checkMode,
  requirements: z.string().max(MAX_CHECK_INSTRUCTION_CHARS).default(""),
});

const customCheckSchema = z.strictObject({
  name: labelName.max(MAX_CHECK_NAME_CHARS).refine((n) => !(BUILTIN_CHECKS as readonly string[]).includes(n), {
    message: "must not be a built-in check name",
  }),
  mode: checkMode,
  instructions: nonEmpty.max(MAX_CHECK_INSTRUCTION_CHARS),
});

const preMergeChecksSchema = z.strictObject({
  title: modelCheckSchema.prefault({}),
  description: modelCheckSchema.prefault({}),
  docstrings: z
    .strictObject({ mode: checkMode, threshold: z.number().min(0).max(100).default(80) })
    .prefault({}),
  linked_issues: z.strictObject({ mode: checkMode }).prefault({}),
  custom: z
    .array(customCheckSchema)
    .max(MAX_CUSTOM_CHECKS)
    .default([])
    .refine((list) => new Set(list.map((c) => c.name)).size === list.length, {
      message: "custom check names must be unique",
    }),
});

const toolSwitch = z.strictObject({ enabled: z.boolean().default(false) }).prefault({});

const toolsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  ...(Object.fromEntries(TOOL_NAMES.map((name) => [name, toolSwitch])) as Record<ToolName, typeof toolSwitch>),
});

export const configSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    profile: z.enum(PROFILES).default("chill"),
    request_changes_threshold: z.enum(THRESHOLDS).default("major"),
    language: nonEmpty.max(35).default("en-US"),
    tone_instructions: z.string().max(MAX_TONE_CHARS).default(""),
    style_guide: styleGuideSchema.prefault({}),
    path_filters: z.array(filterPattern).default([]),
    path_instructions: z.array(pathInstructionSchema).default([]),
    auto_review: autoReviewSchema.prefault({}),
    engines: enginesSchema.prefault({}),
    limits: limitsSchema.prefault({}),
    context: contextSchema.prefault({}),
    rule_packs: rulePacksSchema.prefault({}),
    learnings: learningsSchema.prefault({}),
    walkthrough: walkthroughSchema.prefault({}),
    labels: z
      .array(labelSchema)
      .max(MAX_LABELS)
      .default([])
      .refine((list) => new Set(list.map((l) => l.label)).size === list.length, {
        message: "label names must be unique",
      }),
    pre_merge_checks: preMergeChecksSchema.prefault({}),
    tools: toolsSchema.prefault({}),
  })
  .meta({
    title: "myrabbit configuration (.myrabbit.yaml v1)",
    description:
      "Read from the PR's base SHA. Any validation error makes myrabbit ignore the whole file and use the defaults.",
  });

export type ConfigInput = z.input<typeof configSchema>;

// Compile-time check: the parsed output is exactly the shared `Config` type.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ConfigSchemaMatchesConfig = Assert<Exact<z.output<typeof configSchema>, Config>>;

/** Effective defaults: what a missing, empty or invalid file yields. */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

export const JSON_SCHEMA_ID =
  "https://raw.githubusercontent.com/dlled/customrabbit/main/schema/myrabbit.schema.json";

/** The JSON Schema for editors, generated from `configSchema`. */
export function buildJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(configSchema, { target: "draft-07", io: "input" }) as Record<
    string,
    unknown
  >;
  const { $schema, ...rest } = generated;
  return { $schema, $id: JSON_SCHEMA_ID, ...rest };
}

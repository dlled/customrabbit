// §6.2 proposal prompt, output schema and result (design-v2).
//
// The finding and the replies are PR/thread content, so they go inside `<untrusted-{nonce}>`,
// escaped exactly like the review prompt (src/prompts/builder.ts). The system prompt is the
// trusted review system prompt. The result is redacted and validated before it can reach the body;
// myrabbit never writes it to the repository (Contents is read-only).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { parseGlobs } from "../config/learnings.js";
import { redact } from "../env.js";
import {
  buildSystemPrompt,
  defaultTemplatesDir,
  escapeUntrusted,
  oneLine,
  type PromptContext,
  type Templates,
} from "../prompts/builder.js";
import type { ProposedLearning } from "../types.js";
import type { ProposalRequest } from "./select.js";

export const LEARNING_TEMPLATE = "learning.md";
export const MAX_PROPOSAL_TITLE_CHARS = 80;
export const MAX_PROPOSAL_RULE_CHARS = 300;
export const MAX_PROPOSAL_PATHS = 5;

/** Reads src/prompts/learning.md (the bundle passes the embedded text instead). */
export function loadLearningTemplate(dir: string = defaultTemplatesDir()): string {
  const path = join(dir, LEARNING_TEMPLATE);
  if (!existsSync(path)) throw new Error("learning prompt template not found");
  return readFileSync(path, "utf8");
}

export interface LearningPrompt {
  systemPrompt: string;
  prompt: string;
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`learning template variable not provided: ${key}`);
    return v;
  });
}

/** One pass over the trusted template, so a value can never expand a placeholder. */
export function buildLearningPrompt(
  request: ProposalRequest,
  context: PromptContext,
  template: string = loadLearningTemplate(),
  templates?: Templates,
): LearningPrompt {
  const p = request.prior;
  const range = p.end_line !== null && p.end_line !== p.line ? `${p.line}-${p.end_line}` : `${p.line}`;
  const finding = [
    `path: ${oneLine(p.path)}`,
    `lines: ${range} (${p.side})`,
    `severity: ${p.marker.sev}`,
    `category: ${p.category}`,
    `title: ${oneLine(p.summary)}`,
    `body:\n${escapeUntrusted(p.body)}`,
  ].join("\n");
  const replies = request.replies
    .map((r) => `[${oneLine(r.author ?? "unknown")}]\n${escapeUntrusted(r.body)}`)
    .join("\n\n");
  return {
    systemPrompt: buildSystemPrompt(context, templates),
    prompt: render(template, { nonce: context.nonce, finding, replies }),
  };
}

/** Strict output schema (OpenAI form, draft-07 compatible), like src/engines/schema.ts. */
export const LEARNING_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["propose", "title", "rule", "paths"],
  properties: {
    propose: { type: "boolean" },
    title: { type: "string" },
    rule: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
  },
};

export interface LearningOutput {
  propose: boolean;
  title: string;
  rule: string;
  paths: string[];
}

const learningOutputZ = z.strictObject({
  propose: z.boolean(),
  title: z.string(),
  rule: z.string(),
  paths: z.array(z.string()),
});

/** For `EngineInput.parse`: throws on output that does not match the schema. */
export function parseLearningOutput(raw: unknown): LearningOutput {
  const r = learningOutputZ.safeParse(raw);
  if (r.success) return r.data;
  throw new Error(`learning output does not match the schema: ${r.error.issues.length} issue(s)`);
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** Title comparison for duplicates: case- and whitespace-insensitive. */
export function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The proposal to show, or null when the engine declined, gave nothing usable, or proposed a
 * title that `.myrabbit/learnings.md` already has (`existingTitles`, the titles of the parsed
 * learnings; compared with {@link titleKey}). Title and rule are one line, length-capped and
 * redacted; paths keep only valid repo-relative globs.
 */
export function toProposal(
  request: ProposalRequest,
  output: LearningOutput,
  existingTitles: Iterable<string> = [],
): ProposedLearning | null {
  if (!output.propose) return null;
  const rule = clip(redact(output.rule), MAX_PROPOSAL_RULE_CHARS);
  if (rule === "") return null;
  const title = clip(redact(output.title).replace(/^#+\s*/, ""), MAX_PROPOSAL_TITLE_CHARS);
  // Existing titles may be longer than a proposal's (120 vs 80 chars): clip them the same way.
  const existing = new Set([...existingTitles].map((t) => titleKey(clip(t, MAX_PROPOSAL_TITLE_CHARS))));
  if (title !== "" && existing.has(titleKey(title))) return null;
  const paths = [...new Set(output.paths.flatMap((p) => parseGlobs(redact(p))))]
    .filter((p) => !/\s/.test(p))
    .slice(0, MAX_PROPOSAL_PATHS);
  return {
    ...(title === "" ? {} : { title }),
    rule,
    paths,
    fingerprint: request.prior.marker.fp,
    source: request.engine,
  };
}

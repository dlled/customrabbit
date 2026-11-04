// Prompt builder (design.md §6).
//
// The templates in this directory (system, review, verify, resolve) are the versioned prompt
// text; `promptVersion()` is a short hash of them, recorded in the run document and the state
// marker. Both engines get the same content; only the transport differs (adapters).
//
// Untrusted values (anything from the PR or from model output: file paths, titles, descriptions,
// commit subjects, the diff, finding text) go inside `<untrusted-{nonce}>`, where the nonce is 16
// random hex chars per run. Every interpolated value is also escaped so that `<untrusted-` and
// `</untrusted-` cannot appear in it, so the nonce is not the only guard. Values are substituted in
// one pass, so a value that contains `{{nonce}}` or any other placeholder is never expanded.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Category, RelatedKind, ReviewMode, RulePackName, Severity, Side, ToolName } from "../types.js";
import { rulePacks, type RulePack } from "./packs/index.js";

export const TEMPLATE_NAMES = ["system", "review", "verify", "resolve"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export type Templates = Record<TemplateName, string>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Directory holding the *.md templates: this directory when running from src/ (tests, tsx), or
 * ../src/prompts when running from the dist/ bundle (the action ships the whole repo).
 */
export function defaultTemplatesDir(): string {
  for (const dir of [HERE, join(HERE, "..", "src", "prompts")]) {
    if (existsSync(join(dir, "system.md"))) return dir;
  }
  throw new Error("prompt templates not found");
}

let cached: Templates | null = null;

/** Reads the templates (cached when `dir` is omitted). */
export function loadTemplates(dir?: string): Templates {
  if (dir === undefined && cached !== null) return cached;
  const base = dir ?? defaultTemplatesDir();
  const t = Object.fromEntries(
    TEMPLATE_NAMES.map((name) => [name, readFileSync(join(base, `${name}.md`), "utf8")]),
  ) as Templates;
  if (dir === undefined) cached = t;
  return t;
}

/**
 * `prompt_version`: first 12 hex chars of sha256 over every template (name and content) and every
 * rule pack (name, globs and text; design-v2 §8), so changing a pack changes the `prompt=` marker.
 */
export function promptVersion(
  templates: Templates = loadTemplates(),
  packs: readonly Pick<RulePack, "name" | "globs" | "text">[] = rulePacks(),
): string {
  const h = createHash("sha256");
  for (const name of TEMPLATE_NAMES) {
    h.update(name);
    h.update("\0");
    h.update(templates[name]);
    h.update("\0");
  }
  for (const p of packs) {
    h.update(`pack:${p.name}`);
    h.update("\0");
    h.update(p.globs.join("\n"));
    h.update("\0");
    h.update(p.text);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Escaping and rendering
// ---------------------------------------------------------------------------

const NONCE = /^[0-9a-f]{16}$/;
const UNTRUSTED_TAG = /<(\s*\/?\s*)(untrusted-)/gi;
const ZWSP = "\u200B";

/** 16 random hex chars, new per run (§6.1). */
export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/** Breaks every `<untrusted-` / `</untrusted-` (any case, any spacing) with a zero-width space. */
export function escapeUntrusted(value: string): string {
  return value.replace(UNTRUSTED_TAG, `<${ZWSP}$1$2`);
}

// Control characters and Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const LINE_BREAKING = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]+", "g");

/** Escaped, and collapsed to one line, for values that must not start new lines (paths, titles). */
export function oneLine(value: string): string {
  return escapeUntrusted(value).replace(LINE_BREAKING, " ").trim();
}

const SECTION = /\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

/**
 * Conditional sections of the (trusted) template: `{{#name}}…{{/name}}` is kept when
 * `flags[name]` is true and removed, with its content, otherwise (design-v2 §10: a slot's trusted
 * text renders only when the slot is present). Sections may nest when their names differ. Runs on
 * the template before any value is substituted, so a value can never open or close a section.
 */
function sections(template: string, flags: Record<string, boolean>): string {
  let out = template;
  for (;;) {
    const next = out.replace(SECTION, (_match, key: string, body: string) => {
      const on = flags[key];
      if (on === undefined) throw new Error(`prompt template section not provided: ${key}`);
      return on ? body : "";
    });
    if (next === out) return out;
    out = next;
  }
}

function render(template: string, vars: Record<string, string>, flags: Record<string, boolean> = {}): string {
  return sections(template, flags).replace(/\{\{([a-z_]+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt template variable not provided: ${key}`);
    return value;
  });
}

function checkNonce(nonce: string): void {
  if (!NONCE.test(nonce)) throw new Error("nonce must be 16 lowercase hex chars");
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Trusted run context, from the GitHub context and the base-SHA config. */
export interface PromptContext {
  /** owner/name */
  repo: string;
  /** Config `language`. */
  language: string;
  /** Config `tone_instructions` (base SHA, trusted). */
  toneInstructions: string;
  /** Per-run nonce from newNonce(). */
  nonce: string;
}

/** A style guide from the base SHA (§4.1). */
export interface StyleGuideEntry {
  /** Short id referenced from the file list, e.g. "G1". */
  id: string;
  /** Repo path of the guide file, e.g. "src/AGENTS.md". */
  source: string;
  /** Scope glob, e.g. "src/**" or "**". */
  scope: string;
  text: string;
  /** design-v2 §6.1: the section title when this entry is a learning from `.myrabbit/learnings.md`. */
  learning?: string;
}

// design-v2 §10 optional slots. A slot is present when it is set and non-empty; its block and its
// trusted instruction text render only then, so a v1 input renders exactly the v1 prompt.

/** §4.4 rule pack (trusted, myrabbit's own text). */
export interface RulePackEntry {
  name: RulePackName;
  text: string;
}

/** §5.1 a model-judged pre-merge check, from the base config (trusted). */
export interface PromptCheck {
  name: string;
  instructions: string;
}

/** §4.5 a label the engines may suggest, from the base config (trusted). */
export interface PromptLabel {
  label: string;
  instructions: string;
}

/** §7.4 normalised static-analysis hit (untrusted: the message comes from PR content). */
export interface StaticAnalysisHit {
  tool: ToolName;
  rule: string;
  path: string;
  line: number;
  message: string;
}

/** §4.6 related issue/PR candidate (untrusted). */
export interface RelatedCandidate {
  number: number;
  kind: RelatedKind;
  title: string;
  body: string;
}

/** §5.5 issue the PR says it closes (untrusted). */
export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

/** §4.6: only this much of each candidate body goes into the prompt. */
export const CANDIDATE_BODY_CHARS = 500;

/** A `path_instructions` entry from the base config. */
export interface PathInstructionEntry {
  /** Short id referenced from the file list, e.g. "P1". */
  id: string;
  /** minimatch glob. */
  path: string;
  instructions: string;
}

export interface ReviewedFile {
  path: string;
  /** Ids of the StyleGuideEntry / PathInstructionEntry items that apply to this file. */
  ruleIds: string[];
}

export interface ReportedFinding {
  fingerprint: string;
  path: string;
  line: number;
  severity: Severity;
  title: string;
}

export interface PrMeta {
  title: string;
  description: string;
  commitSubjects: string[];
}

export interface ReviewPromptInput {
  context: PromptContext;
  mode: ReviewMode;
  baseSha: string;
  headSha: string;
  /** Last reviewed SHA; required in incremental mode. */
  lastSha: string | null;
  styleGuides: StyleGuideEntry[];
  pathInstructions: PathInstructionEntry[];
  files: ReviewedFile[];
  alreadyReported: ReportedFinding[];
  pr: PrMeta;
  /** Unified diff of the review target, filtered, with hunk headers. */
  diff: string;
  // design-v2 slots, all optional.
  /** §3.3 context pack text, placed in `<related-code>` inside the untrusted block. */
  relatedCode?: string;
  /** §7.4 hits, in `<static-analysis>` inside the untrusted block. */
  staticAnalysis?: StaticAnalysisHit[];
  /** §4.6 candidates, in `<candidates>` inside the untrusted block; enables `related`. */
  candidates?: RelatedCandidate[];
  /** §5.5 linked issues, in `<linked-issues>` inside the untrusted block. */
  linkedIssues?: LinkedIssue[];
  /** §5.1 checks, in the trusted `<pre-merge-checks>` section; enables `checks`. */
  checks?: PromptCheck[];
  /** §4.4 rule packs, appended to the trusted `<style-guide>` section. */
  rulePacks?: RulePackEntry[];
  /** §4.5 labels, in the trusted `<labels>` section; enables `labels`. */
  labels?: PromptLabel[];
  /** §4.1 ask for `effort`. */
  effort?: boolean;
}

/** Which v2 output fields a review prompt asks for (src/engines/schema.ts `reviewOutputSchema`). */
export interface ReviewOutputFeatures {
  effort: boolean;
  checks: boolean;
  labels: boolean;
  related: boolean;
}

/** The output fields the prompt asks for; pass to `reviewOutputSchema` so the two always agree. */
export function reviewOutputFeatures(input: ReviewPromptInput): ReviewOutputFeatures {
  return {
    effort: input.effort === true,
    checks: present(input.checks),
    labels: present(input.labels),
    related: present(input.candidates),
  };
}

/** Trusted system-prompt rules, each rendered only when its review slot is present. */
export interface SystemSlots {
  relatedCode?: boolean;
  staticAnalysis?: boolean;
  learnings?: boolean;
}

function present(v: readonly unknown[] | string | undefined): boolean {
  if (v === undefined) return false;
  return typeof v === "string" ? v.trim() !== "" : v.length > 0;
}

/** The finding text given to a verifier (§6.3). */
export interface VerifyFinding {
  path: string;
  line: number;
  end_line: number | null;
  side: Side;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  failure_scenario: string;
  evidence: string[];
}

export interface VerifyPromptInput {
  context: PromptContext;
  headSha: string;
  finding: VerifyFinding;
}

/** An open myrabbit thread whose anchored lines changed (§6.4). */
export interface ResolveFinding {
  path: string;
  line: number;
  end_line: number | null;
  side: Side;
  severity: Severity;
  title: string;
  body: string;
}

export interface ResolvePromptInput {
  context: PromptContext;
  lastSha: string;
  headSha: string;
  finding: ResolveFinding;
  /** last...head diff of the finding's file, if available. */
  diff: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  prompt: string;
  nonce: string;
  promptVersion: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  context: PromptContext,
  templates: Templates = loadTemplates(),
  slots: SystemSlots = {},
): string {
  checkNonce(context.nonce);
  return render(
    templates.system,
    {
      repo: oneLine(context.repo),
      nonce: context.nonce,
      language: oneLine(context.language),
      tone: escapeUntrusted(context.toneInstructions.trim()),
    },
    {
      related_code: slots.relatedCode === true,
      static_analysis: slots.staticAnalysis === true,
      learnings: slots.learnings === true,
    },
  );
}

function bullets(lines: string[]): string {
  return lines.length === 0 ? "(none)" : lines.join("\n");
}

function styleGuideSection(guides: StyleGuideEntry[], instructions: PathInstructionEntry[]): string {
  const parts: string[] = [];
  for (const g of guides) {
    const what =
      g.learning === undefined
        ? `style guide ${oneLine(g.source)}`
        : `learning "${oneLine(g.learning)}" from ${oneLine(g.source)}`;
    parts.push(`[${oneLine(g.id)}] ${what}, scope ${oneLine(g.scope)}\n${escapeUntrusted(g.text.trim())}`);
  }
  for (const p of instructions) {
    parts.push(`[${oneLine(p.id)}] path instructions, scope ${oneLine(p.path)}\n${escapeUntrusted(p.instructions.trim())}`);
  }
  return parts.length === 0 ? "(none)" : parts.join("\n\n");
}

function rulePacksSection(packs: readonly RulePackEntry[]): string {
  return packs.map((p) => `[pack ${oneLine(p.name)}]\n${escapeUntrusted(p.text.trim())}`).join("\n\n");
}

function checksSection(checks: readonly PromptCheck[]): string {
  return checks.map((c) => `[${oneLine(c.name)}]\n${escapeUntrusted(c.instructions.trim())}`).join("\n\n");
}

function labelsSection(labels: readonly PromptLabel[]): string {
  return labels
    .map((l) => {
      const what = oneLine(l.instructions);
      return `- ${oneLine(l.label)}${what === "" ? "" : `: ${what}`}`;
    })
    .join("\n");
}

function staticAnalysisSection(hits: readonly StaticAnalysisHit[]): string {
  return hits
    .map((h) => `- ${oneLine(h.tool)}:${oneLine(h.rule)} ${oneLine(h.path)}:${h.line} ${oneLine(h.message)}`)
    .join("\n");
}

/** Cuts to `limit` UTF-16 units without splitting a surrogate pair. */
function cutText(s: string, limit: number): string {
  if (s.length <= limit) return s;
  let out = s.slice(0, limit);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return `${out}…`;
}

function issueBlock(head: string, title: string, body: string): string {
  const text = body.trim() === "" ? "(empty)" : escapeUntrusted(body.trim());
  return `${head} ${oneLine(title)}\n${text}`;
}

function candidatesSection(candidates: readonly RelatedCandidate[]): string {
  return candidates
    .map((c) => issueBlock(`[#${c.number} ${c.kind}]`, c.title, cutText(c.body, CANDIDATE_BODY_CHARS)))
    .join("\n\n");
}

function linkedIssuesSection(issues: readonly LinkedIssue[]): string {
  return issues.map((i) => issueBlock(`[#${i.number}]`, i.title, i.body)).join("\n\n");
}

function verifyFindingBlock(f: VerifyFinding): string {
  const range = f.end_line !== null && f.end_line !== f.line ? `${f.line}-${f.end_line}` : `${f.line}`;
  return [
    `path: ${oneLine(f.path)}`,
    `lines: ${range} (${f.side})`,
    `severity: ${f.severity}`,
    `category: ${f.category}`,
    `title: ${oneLine(f.title)}`,
    `body:\n${escapeUntrusted(f.body)}`,
    `failure_scenario:\n${escapeUntrusted(f.failure_scenario)}`,
    `evidence:\n${bullets(f.evidence.map((e) => `- ${oneLine(e)}`))}`,
  ].join("\n");
}

export function buildReviewPrompt(input: ReviewPromptInput, templates: Templates = loadTemplates()): BuiltPrompt {
  const { context, mode } = input;
  if (mode === "incremental" && input.lastSha === null) throw new Error("incremental review needs lastSha");
  const head = oneLine(input.headSha);
  const base = oneLine(input.baseSha);
  const last = input.lastSha === null ? "(none)" : oneLine(input.lastSha);
  const pr = input.pr;
  const prMeta = [
    `Title: ${oneLine(pr.title)}`,
    `Description:\n${pr.description.trim() === "" ? "(empty)" : escapeUntrusted(pr.description)}`,
    `Commits:\n${bullets(pr.commitSubjects.map((s) => `- ${oneLine(s)}`))}`,
  ].join("\n");

  const slots = {
    relatedCode: present(input.relatedCode),
    staticAnalysis: present(input.staticAnalysis),
    learnings: input.styleGuides.some((g) => g.learning !== undefined),
  } satisfies Required<SystemSlots>;

  const prompt = render(templates.review, {
    nonce: context.nonce,
    mode,
    base,
    last,
    head,
    range: mode === "incremental" ? `${last}..${head} (changes since the last review)` : `${base}...${head} (merge-base diff)`,
    file_count: String(input.files.length),
    reported_count: String(input.alreadyReported.length),
    mode_note:
      mode === "incremental"
        ? "Incremental review: report problems in the diff below. You may read the full pull request and the repository for context."
        : "Full review of the pull request.",
    style_guide: styleGuideSection(input.styleGuides, input.pathInstructions),
    files: bullets(
      input.files.map((f) => {
        const ids = f.ruleIds.length === 0 ? "" : ` [${f.ruleIds.map(oneLine).join(", ")}]`;
        return `- ${oneLine(f.path)}${ids}`;
      }),
    ),
    already_reported: bullets(
      input.alreadyReported.map(
        (r) => `- fp=${oneLine(r.fingerprint)} ${oneLine(r.path)}:${r.line} [${r.severity}] ${oneLine(r.title)}`,
      ),
    ),
    pr_meta: prMeta,
    diff: escapeUntrusted(input.diff),
    related_code: escapeUntrusted((input.relatedCode ?? "").trim()),
    static_analysis: staticAnalysisSection(input.staticAnalysis ?? []),
    candidates: candidatesSection(input.candidates ?? []),
    linked_issues: linkedIssuesSection(input.linkedIssues ?? []),
    checks: checksSection(input.checks ?? []),
    rule_packs: rulePacksSection(input.rulePacks ?? []),
    labels: labelsSection(input.labels ?? []),
  }, {
    related_code: slots.relatedCode,
    static_analysis: slots.staticAnalysis,
    candidates: present(input.candidates),
    linked_issues: present(input.linkedIssues),
    checks: present(input.checks),
    rule_packs: present(input.rulePacks),
    labels: present(input.labels),
    effort: input.effort === true,
  });
  return {
    systemPrompt: buildSystemPrompt(context, templates, slots),
    prompt,
    nonce: context.nonce,
    promptVersion: promptVersion(templates),
  };
}

export function buildVerifyPrompt(input: VerifyPromptInput, templates: Templates = loadTemplates()): BuiltPrompt {
  const prompt = render(templates.verify, {
    nonce: input.context.nonce,
    head: oneLine(input.headSha),
    finding: verifyFindingBlock(input.finding),
  });
  return {
    systemPrompt: buildSystemPrompt(input.context, templates),
    prompt,
    nonce: input.context.nonce,
    promptVersion: promptVersion(templates),
  };
}

export function buildResolvePrompt(input: ResolvePromptInput, templates: Templates = loadTemplates()): BuiltPrompt {
  const f = input.finding;
  const range = f.end_line !== null && f.end_line !== f.line ? `${f.line}-${f.end_line}` : `${f.line}`;
  const finding = [
    `path: ${oneLine(f.path)}`,
    `lines: ${range} (${f.side})`,
    `severity: ${f.severity}`,
    `title: ${oneLine(f.title)}`,
    `body:\n${escapeUntrusted(f.body)}`,
  ].join("\n");
  const prompt = render(templates.resolve, {
    nonce: input.context.nonce,
    last: oneLine(input.lastSha),
    head: oneLine(input.headSha),
    finding,
    diff: input.diff.trim() === "" ? "(not available)" : escapeUntrusted(input.diff),
  });
  return {
    systemPrompt: buildSystemPrompt(input.context, templates),
    prompt,
    nonce: input.context.nonce,
    promptVersion: promptVersion(templates),
  };
}

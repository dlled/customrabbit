// Shared types for myrabbit. Source of truth for design.md §4, §5, §8.3 and §9.
// Owned by W0; later changes go through myrabbit-lead.
//
// Enum-like unions are declared as `as const` tuples so zod schemas (z.enum(SEVERITIES)) and
// JSON schemas can be built from the same values without drifting.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Most severe first. */
export const SEVERITIES = ["critical", "major", "minor", "trivial"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "correctness",
  "security",
  "reliability",
  "performance",
  "maintainability",
  "testing",
  "docs",
  "style",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SIDES = ["RIGHT", "LEFT"] as const;
export type Side = (typeof SIDES)[number];

export const ENGINE_NAMES = ["claude", "codex"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export const PROFILES = ["quiet", "chill", "assertive"] as const;
export type Profile = (typeof PROFILES)[number];

/** `request_changes_threshold`: lowest severity that blocks. `trivial` never blocks (§4). */
export const THRESHOLDS = ["critical", "major", "minor"] as const;
export type Threshold = (typeof THRESHOLDS)[number];

/** myrabbit never posts COMMENT (§1). */
export const VERDICTS = ["APPROVE", "REQUEST_CHANGES"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Mode written to the state marker. `skip` posts nothing, so it never appears in a marker. */
export const REVIEW_MODES = ["full", "incremental"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
export type RunMode = ReviewMode | "skip";

export const FINDING_STATUSES = ["new", "open", "addressed", "superseded", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * How a finding's blocking eligibility was established (§6.3, §7.2 step 7):
 * - agreed: reported by both engines, no verification needed
 * - verified / rejected: a verify call confirmed / refuted a single-source finding
 * - unverified_budget: needed verification but the per-run verify budget ran out
 * - unverified_error: the verify call failed
 * - not_needed: below threshold, so never verified
 */
export const VERIFICATIONS = [
  "agreed",
  "verified",
  "rejected",
  "unverified_budget",
  "unverified_error",
  "not_needed",
] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/** Claude Agent SDK `EffortLevel`. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Codex SDK `modelReasoningEffort`. */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

// design-v2 enums (§2, §4, §5, §7). Values mirror eval/schema/findings.schema.json (E4).

/** Pre-merge check mode (§5). `off` checks are not run and never appear in the run document. */
export const CHECK_MODES = ["off", "warning", "error"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];
export type ActiveCheckMode = Exclude<CheckMode, "off">;

export const CHECK_STATUSES = ["pass", "fail", "inconclusive"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Built-in pre-merge checks (§5.1, §5.5); custom checks may not reuse these names. */
export const BUILTIN_CHECKS = ["title", "description", "docstrings", "linked_issues"] as const;
export type BuiltinCheck = (typeof BUILTIN_CHECKS)[number];

/** Merge risk (§4.2), most severe first. Computed, never model-set. */
export const RISKS = ["critical", "high", "moderate", "low", "minimal"] as const;
export type Risk = (typeof RISKS)[number];

/** Static-analysis tools of the v2 safe set (§7.1). */
export const TOOL_NAMES = [
  "shellcheck",
  "actionlint",
  "hadolint",
  "zizmor",
  "ruff",
  "yamllint",
  "squawk",
  "gitleaks",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** `unverified` = sha256 mismatch against tools.lock (§7.2); the tool did not run. */
export const TOOL_RUN_STATUSES = ["ok", "timeout", "error", "skipped", "unverified"] as const;
export type ToolRunStatus = (typeof TOOL_RUN_STATUSES)[number];

/** Rule packs (§4.4). */
export const RULE_PACK_NAMES = [
  "typescript",
  "python",
  "go",
  "rust",
  "shell",
  "github_actions",
  "dockerfile",
  "sql",
] as const;
export type RulePackName = (typeof RULE_PACK_NAMES)[number];

export const RELATED_KINDS = ["issue", "pr"] as const;
export type RelatedKind = (typeof RELATED_KINDS)[number];

export const REVIEWER_REASONS = ["codeowners", "recent_changes"] as const;
export type ReviewerReason = (typeof REVIEWER_REASONS)[number];

/** Kinds of synthetic blocking item a feature can add to the verdict (§5.3, §7.5). */
export const SYNTHETIC_BLOCKER_KINDS = ["check", "secret", "coverage"] as const;
export type SyntheticBlockerKind = (typeof SYNTHETIC_BLOCKER_KINDS)[number];

// ---------------------------------------------------------------------------
// §5.1 Engine output (what both models return). No verdict field: models do not vote.
// ---------------------------------------------------------------------------

export interface EngineChange {
  area: string;
  files: string[];
  summary: string;
}

export interface EngineFinding {
  /** Repo-relative; must be in the reviewed diff. */
  path: string;
  /** Head-side line (RIGHT), or LEFT line when side = LEFT. */
  line: number;
  /** Multi-line range end, >= line. */
  end_line: number | null;
  side: Side;
  severity: Severity;
  category: Category;
  /** <= 120 chars. */
  title: string;
  /** <= 1,500 chars: what breaks and why. */
  body: string;
  /** input/state -> wrong result; required, non-empty. */
  failure_scenario: string;
  /** path:line references, >= 1. */
  evidence: string[];
  /** Quoted style-guide or path-instruction rule when the finding enforces one. */
  rule: string | null;
  /** Exact replacement for line..end_line (RIGHT side only). */
  suggestion: string | null;
  /** 0..1 */
  confidence: number;
}

/** design-v2 §4.1: 1 trivial … 5 very complex (CodeRabbit's scale), with review minutes. */
export interface EngineEffort {
  score: number;
  minutes: number;
}

/** design-v2 §5.1: one pre-merge check as judged by one engine. */
export interface EngineCheck {
  name: string;
  status: CheckStatus;
  explanation: string;
}

/** design-v2 §4.6: a related issue or PR; `number` must be one of the given candidates. */
export interface EngineRelated {
  number: number;
  reason: string;
}

export interface EngineOutput {
  /** 2-4 sentences: what the PR does. */
  summary: string;
  changes: EngineChange[];
  findings: EngineFinding[];
  // design-v2 §8 fields. Asked for only when their feature is on (src/engines/schema.ts
  // `reviewOutputSchema`) and absent otherwise. A missing or invalid value means "not provided"
  // and never invalidates the rest of the output.
  effort?: EngineEffort | null;
  checks?: EngineCheck[];
  labels?: string[];
  related?: EngineRelated[];
}

/** §5.1 verify prompt output (§6.3). */
export interface VerifyOutput {
  confirmed: boolean;
  reason: string;
  evidence: string[];
}

/** §5.1 resolve prompt output (§6.4). */
export interface ResolveOutput {
  fixed: boolean;
  reason: string;
  evidence: string[];
}

// ---------------------------------------------------------------------------
// §5.2 Merged finding (internal, and the eval output) + run document
// ---------------------------------------------------------------------------

export interface MergedFinding {
  path: string;
  line: number;
  end_line: number | null;
  side: Side;
  severity: Severity;
  category: Category;
  /** = EngineFinding.title */
  summary: string;
  body: string;
  /** From the cluster's most confident member; for the renderer's "Fails when:". Not in the run document. */
  failure_scenario: string;
  /**
   * What the finding enforces, from the same member: `<tool>:<rule>` (design-v2 §7.4),
   * `learning:<title>` (§6.1) or a quoted style-guide rule; null when none. Written to the run
   * document only when non-blank.
   */
  rule: string | null;
  suggestion: string | null;
  /** severity >= threshold AND (confirmed by both OR verified) AND anchored (§7.2 step 7). */
  blocking: boolean;
  sources: EngineName[];
  confidence: number;
  /** 12 hex chars (§7.1). */
  fingerprint: string;
  status: FindingStatus;
  outside_diff: boolean;
  verification: Verification;
  /** True for findings myrabbit creates itself, e.g. the coverage finding of §7.5. */
  synthetic: boolean;
}

export interface RunInfo {
  prompt_version: string;
  merge_version: string;
  /** Engines whose output contributed to this run. */
  sources: EngineName[];
}

/**
 * Written to the job summary and `$RUNNER_TEMP/myrabbit-run.json` (§5.2).
 * Must never contain anything read from env.
 */
export interface RunDocument extends RunExtras {
  schema_version: "1";
  run: RunInfo;
  verdict: Verdict;
  findings: MergedFinding[];
}

// design-v2 §8 run-document fields. Exact shapes: eval/schema/findings.schema.json (E4). Each is
// left out unless its feature produced something (serialised only when non-empty), so a
// v1-default run document is unchanged.

/** §3.2 context pack statistics. */
export interface RunContextInfo {
  symbols: number;
  usages: number;
  /** e.g. "tree-sitter" or "tree-sitter+ts". */
  resolver: string;
  /** Symbols left out by the budget; truncation is not incomplete coverage. */
  dropped: number;
}

export interface ToolRun {
  tool: ToolName;
  status: ToolRunStatus;
  /** Changed files staged for this tool. */
  files?: number;
}

/** §7.4 step 1 normalised hit. */
export interface ToolHit {
  tool: ToolName;
  rule: string;
  path: string;
  line: number;
  /** Redacted; for gitleaks never the matched value (§7.5). */
  message: string;
  /** Some engine reported it as a finding with rule = `<tool>:<rule>`. */
  confirmed?: boolean;
}

export interface RunToolsInfo {
  runs: ToolRun[];
  /** At most {@link MAX_RUN_TOOL_HITS}. */
  hits: ToolHit[];
}

/** §5.2 combined (damped) status of one configured check. Checks in mode off are not listed. */
export interface RunCheck {
  /** ≤ 50 chars: a built-in or custom check name. */
  name: string;
  mode: ActiveCheckMode;
  status: CheckStatus;
  explanation: string;
}

/** §4.1: the higher engine score with its minutes. Never affects the verdict. */
export interface RunEffort {
  /** 1..5 */
  score: number;
  minutes: number;
}

export interface RelatedItem {
  number: number;
  kind?: RelatedKind;
  reason: string;
}

export interface SuggestedReviewer {
  login: string;
  reason: ReviewerReason;
}

/** §6.2 proposal, rendered as a snippet and never written by myrabbit. */
export interface ProposedLearning {
  /** Proposed `## ` section title. */
  title?: string;
  /** One sentence, redacted. */
  rule: string;
  /** Globs for the `paths:` line; empty = repo-wide. */
  paths: string[];
  /** Fingerprint of the finding whose thread produced the proposal. */
  fingerprint?: string;
  source?: EngineName;
}

/** Caps of the E4 schema. */
export const MAX_RUN_TOOL_HITS = 50;
export const MAX_RUN_RELATED = 20;
export const MAX_PROPOSED_LEARNINGS = 3;

export interface RunExtras {
  context?: RunContextInfo;
  tools?: RunToolsInfo;
  checks?: RunCheck[];
  effort?: RunEffort;
  risk?: Risk;
  labels?: string[];
  related?: RelatedItem[];
  reviewers?: SuggestedReviewer[];
  proposed_learnings?: ProposedLearning[];
}

// ---------------------------------------------------------------------------
// §4 `.myrabbit.yaml` (v1), after defaults are applied
// ---------------------------------------------------------------------------

export interface StyleGuideConfig {
  /** Collect AGENTS.md, CLAUDE.md, .claude/rules/**\/*.md from the base SHA. */
  auto: boolean;
  /** Extra repo files, applied repo-wide. */
  files: string[];
}

export interface PathInstruction {
  /** minimatch glob. */
  path: string;
  /** <= 20,000 chars. */
  instructions: string;
}

export interface AutoReviewConfig {
  enabled: boolean;
  drafts: boolean;
  ignore_title_keywords: string[];
  /** "!x" skips when label x is present; a positive label makes review opt-in. */
  labels: string[];
}

export interface ClaudeEngineConfig {
  enabled: boolean;
  model: string;
  effort: ClaudeEffort;
  max_turns: number;
  max_budget_usd: number;
}

export interface CodexEngineConfig {
  enabled: boolean;
  /** null = Codex CLI recommended model. */
  model: string | null;
  effort: CodexEffort;
}

export interface EnginesConfig {
  claude: ClaudeEngineConfig;
  codex: CodexEngineConfig;
  /** Per engine; the job timeout is 30. */
  timeout_minutes: number;
}

export interface LimitsConfig {
  max_files: number;
  max_diff_bytes: number;
  max_inline_comments: number;
}

// design-v2 §2 additions. P0 ships every feature off; each feature flips its own default once its
// eval delta lands.

export interface ContextConfig {
  enabled: boolean;
  /** Effective cap = min(diff chars, max_chars). */
  max_chars: number;
  max_usages_per_symbol: number;
  /** TS LanguageService refinement when a tsconfig.json exists at base. */
  typescript: boolean;
}

export type RulePacksConfig = Record<RulePackName, boolean>;

export interface LearningsConfig {
  /** Read `.myrabbit/learnings.md` from the base SHA (§6.1). */
  enabled: boolean;
  /** Propose learnings in the body from trusted replies (§6.2). */
  propose: boolean;
}

export interface WalkthroughConfig {
  effort: boolean;
  merge_risk: boolean;
  ai_agent_prompts: boolean;
  related: boolean;
  suggested_reviewers: boolean;
}

/** §4.5: suggested only, never applied. */
export interface LabelConfig {
  label: string;
  instructions: string;
}

/** A check judged by the engines from trusted requirements (§5.1). */
export interface ModelCheckConfig {
  mode: CheckMode;
  /** Base-config requirements; empty = the built-in wording. */
  requirements: string;
}

export interface DocstringsCheckConfig {
  mode: CheckMode;
  /** Percent of added or signature-changed functions that must be documented. */
  threshold: number;
}

export interface CustomCheckConfig {
  /** ≤ 50 chars, unique, not a built-in check name. */
  name: string;
  mode: CheckMode;
  /** ≤ 10,000 chars. */
  instructions: string;
}

export interface PreMergeChecksConfig {
  title: ModelCheckConfig;
  description: ModelCheckConfig;
  docstrings: DocstringsCheckConfig;
  linked_issues: { mode: CheckMode };
  /** ≤ 5. */
  custom: CustomCheckConfig[];
}

export type ToolsConfig = { enabled: boolean } & Record<ToolName, { enabled: boolean }>;

export interface Config {
  version: 1;
  profile: Profile;
  request_changes_threshold: Threshold;
  language: string;
  /** <= 250 chars. */
  tone_instructions: string;
  style_guide: StyleGuideConfig;
  /** CodeRabbit semantics: "!" excludes, exclusions win, any include = allowlist. */
  path_filters: string[];
  path_instructions: PathInstruction[];
  auto_review: AutoReviewConfig;
  engines: EnginesConfig;
  limits: LimitsConfig;
  // design-v2 §2
  context: ContextConfig;
  rule_packs: RulePacksConfig;
  learnings: LearningsConfig;
  walkthrough: WalkthroughConfig;
  labels: LabelConfig[];
  pre_merge_checks: PreMergeChecksConfig;
  tools: ToolsConfig;
}

// ---------------------------------------------------------------------------
// §9 Engines
// ---------------------------------------------------------------------------

/** `learning`: a design-v2 §6.2 proposal call (src/orchestrator/learnings.ts). */
export type EngineTask = "review" | "verify" | "resolve" | "learning";

/** Uniform input for both adapters. Both engines get the same content (§6). */
export interface EngineInput<T = EngineOutput> {
  task: EngineTask;
  /** Trusted system part (§6.1). Claude: systemPrompt; Codex: prepended to the prompt. */
  systemPrompt: string;
  /** Review/verify/resolve input (§6.2-§6.4). */
  prompt: string;
  /** Strict JSON schema (draft-07 and OpenAI-strict compatible) for the expected output. */
  outputSchema: Record<string, unknown>;
  /**
   * Validates the parsed JSON (zod). Throws on invalid output; the adapter turns that into a
   * retry (Codex, once) or an `invalid_output` failure.
   */
  parse: (raw: unknown) => T;
  /** Absolute path to the PR checkout; the engines' read-only working directory. */
  cwd: string;
}

/** Token counts, normalised across SDKs. */
export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
}

export interface EngineError {
  /**
   * Short machine-readable reason, e.g. "timeout", "invalid_output", "sdk_error".
   * "credential": the engine was skipped before starting because its credential is unusable
   * (Codex token expired, expiring within 15 min, or malformed; §9.1 step 4).
   * The account is unusable for this run (classified from the SDK's error text, never retried):
   * "quota": usage limit, quota or credits exhausted, or the plan does not include the engine;
   * "rate_limit": rate limited (HTTP 429, retries exhausted);
   * "auth": rejected or expired auth (HTTP 401/403, invalid key, token refresh failed).
   */
  kind: "timeout" | "aborted" | "invalid_output" | "budget" | "sdk_error" | "credential" | "quota" | "rate_limit" | "auth";
  /** Already redacted (src/env.ts `redact`). */
  message: string;
}

interface EngineResultBase {
  engine: EngineName;
  /** Model actually used, when the SDK reports it. */
  model: string | null;
  usage: EngineUsage | null;
  costUsd: number | null;
  durationMs: number;
  toolCalls: number;
  /** Tool uses denied by the permission policy. */
  denials: number;
}

export interface EngineSuccess<T> extends EngineResultBase {
  ok: true;
  output: T;
}

export interface EngineFailure extends EngineResultBase {
  ok: false;
  error: EngineError;
}

export type EngineResult<T = EngineOutput> = EngineSuccess<T> | EngineFailure;

export interface Engine {
  readonly name: EngineName;
  review<T>(input: EngineInput<T>, signal: AbortSignal): Promise<EngineResult<T>>;
}

// ---------------------------------------------------------------------------
// §8.3 State markers
// ---------------------------------------------------------------------------

/** `<!-- myrabbit:state v=1 head=<40hex> base=<40hex> mode=<full|incremental> config=<sha1-12> prompt=<ver> -->` */
export interface ReviewState {
  v: 1;
  head: string;
  base: string;
  mode: ReviewMode;
  /** sha1 of the effective config, first 12 hex chars. */
  config: string;
  prompt: string;
}

/** `<!-- myrabbit:f v=1 fp=<12hex> sev=<s> blk=<0|1> -->` on each inline comment. */
export interface FindingMarker {
  v: 1;
  fp: string;
  sev: Severity;
  blk: boolean;
}

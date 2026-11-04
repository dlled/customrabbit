// Input and output types of the renderer (design §8.5, §8.6). Shared domain types come from
// src/types.ts; these are render-specific views the orchestrator (W6) fills in.

import type {
  Config,
  EngineChange,
  EngineError,
  EngineName,
  MergedFinding,
  ProposedLearning,
  RelatedItem,
  ReviewMode,
  ReviewState,
  Risk,
  RunCheck,
  RunContextInfo,
  RunDocument,
  RunEffort,
  RunToolsInfo,
  Severity,
  SuggestedReviewer,
  Category,
  Side,
  Verdict,
} from "../types.js";

/**
 * The finding the renderer shows. MergedFinding carries `failure_scenario` (rendered as
 * "**Fails when:**"; "" when there is none) and `rule` (the quoted style-guide rule, or null);
 * the run document drops both (src/merge/run-document.ts).
 */
export type RenderFinding = MergedFinding;

/** One engine's part in the run, for the header, the review info and the job summary. */
export interface EngineRunSummary {
  engine: EngineName;
  /**
   * ok: ran and produced output · failed: ran (or was skipped for its credential) without usable
   * output · disabled: off in the config · not_run: enabled, but there was nothing to send it
   * (no reviewable text changes).
   */
  status: "ok" | "failed" | "disabled" | "not_run";
  /** Short reason when failed, e.g. "timeout", "invalid_output", "credential expired". */
  error?: string | null;
  /** The EngineError kind when failed (quota, rate_limit, auth and credential mean unavailable). */
  errorKind?: EngineError["kind"] | null;
  model?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
}

/** A prior myrabbit thread (still open and blocking, or dismissed by a human). */
export interface ThreadRef {
  path: string;
  line: number | null;
  severity: Severity;
  category: Category;
  title: string;
  fingerprint: string;
  /** html_url of the thread's first comment, when known. */
  url?: string | null;
  /** Login of the human who resolved it (dismissed threads). */
  resolvedBy?: string | null;
}

/**
 * A changed file left out by path_filters. `excluded`: an exclusion pattern matched (`pattern` is
 * that pattern). `not_included`: an allowlist is set and nothing matched (`pattern` is null).
 */
export interface FilteredPath {
  path: string;
  reason: "excluded" | "not_included";
  pattern: string | null;
}

/**
 * Same shape as `partitionPaths()` from src/config/ (W1), defined here so render does not depend on
 * config; the orchestrator can spread that result in and add the limit/binary lists.
 */
export interface PathPartition {
  reviewed: string[];
  filtered: FilteredPath[];
}

/**
 * Every changed file is either reviewed or listed in the body with the reason it was not
 * (filtered by a pattern, binary, or over a limit): myrabbit is the merge gate.
 */
export interface SupersededThread extends ThreadRef {
  supersededBy: string;
}

export interface FileCoverage extends PathPartition {
  /** Files in the reviewed diff after path_filters (excluding binary and over-limit files). */
  reviewed: string[];
  /** Files excluded by path_filters (incl. default exclusions). */
  filtered: FilteredPath[];
  /** In-scope files left out because of limits (§7.5). */
  notReviewed: string[];
  /** Binary files: listed, never counted as incomplete. */
  binary: string[];
}

export interface ReviewRenderInput {
  /** Computed by src/merge/verdict.ts; the renderer checks it against the blocking set. */
  verdict: Verdict;
  /** owner/name, for links to the reviewed head. */
  repo: string;
  /** Written as the body's last line (§8.3). `state.head` is also the link target. */
  state: ReviewState;
  /** Start of the reviewed range: base (full) or the last reviewed SHA (incremental). */
  rangeFrom: string;
  config: Pick<Config, "profile" | "request_changes_threshold" | "limits">;
  /** Engine-written PR summary (untrusted). */
  summary: string;
  changes: EngineChange[];
  /** New findings of this run, as merged (§7.2). Synthetic findings (coverage) included. */
  findings: RenderFinding[];
  /** Prior myrabbit threads that are still open and blocking (§7.4). */
  priorBlocking: ThreadRef[];
  /** Blocking threads a human resolved: dismissed, listed for audit (Q9). */
  dismissed: ThreadRef[];
  /**
   * Prior non-blocking threads replaced by a new blocking finding of this run (W4 status
   * "superseded"). `supersededBy` is the new finding's fingerprint.
   */
  superseded: SupersededThread[];
  /** Threads resolved as addressed in this run (§6.4). */
  addressed: number;
  engines: EngineRunSummary[];
  files: FileCoverage;
  /** Engine findings dropped by validation (§7.2 step 1). */
  droppedByValidation: number;
  runUrl: string | null;
  mergeVersion: string;
  configWarnings: string[];
  /** Trusted notes from the orchestrator, e.g. "config changes take effect after merge". */
  notes: string[];
  /**
   * design-v2 body items. Each is rendered only when present (and non-empty), so a run with every
   * v2 feature off renders exactly the v1 body. The orchestrator passes an item only when its
   * feature is on in the base config.
   */
  walkthrough?: WalkthroughRenderInput;
}

/** design-v2 §3.2, §4.1–§4.7, §5.3, §6.2, §7.4.4 items; shapes are the run-document ones (§8). */
export interface WalkthroughRenderInput {
  /** §4.2, from src/merge/risk.ts; checked against the verdict (≥ moderate ⇔ REQUEST_CHANGES). */
  risk?: Risk;
  /** §4.1. */
  effort?: RunEffort;
  /** §4.3: per inline comment and aggregated at the end of the body. */
  aiAgentPrompts?: boolean;
  /** §4.5: label names already filtered to the base config's list. */
  labels?: string[];
  /** §4.6: the union of the engines' picks among the candidates. */
  related?: RelatedItem[];
  /** §4.6: the candidate search failed; shown as "unavailable". */
  relatedUnavailable?: boolean;
  /** §4.7. */
  reviewers?: SuggestedReviewer[];
  /** §5.3: combined checks (mode off never listed). */
  checks?: RunCheck[];
  /** §6.2. */
  proposedLearnings?: ProposedLearning[];
  /** §7.4.4 unconfirmed hits and §7.5 tool failure notes. */
  tools?: RunToolsInfo;
  /** §3.2 "Additional context" line in Review info. */
  context?: RunContextInfo;
}

export interface RenderOptions {
  /**
   * false = 422 fallback (§2.2, §8.5): no inline comments, every finding in the body.
   * Default true.
   */
  inline?: boolean;
}

/** Per-comment options (design-v2). */
export interface CommentOptions {
  /** §4.3: add the collapsed "Prompt for AI agents" block. Default false. */
  aiAgentPrompt?: boolean;
}

/** One entry of the `comments` array of POST /pulls/{n}/reviews. */
export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: Side;
  start_line?: number;
  start_side?: Side;
}

export interface ReviewCounts {
  /** New blocking findings + prior open blocking threads. */
  blocking: number;
  /** New non-blocking findings, including those the profile shows as a count only. */
  nonBlocking: number;
  inline: number;
  bodyOnly: number;
  dismissed: number;
  addressed: number;
}

export interface RenderedReview {
  event: Verdict;
  body: string;
  comments: ReviewComment[];
  counts: ReviewCounts;
  /** Fingerprints posted inline, in order. */
  inlineFingerprints: string[];
  /** Strings that needed redaction while rendering (§9.3). */
  redactions: number;
  /** True when the body hit the 60,000 cap and sections were cut. */
  truncated: boolean;
}

export type JobOutcome =
  | { kind: "posted"; verdict: Verdict }
  | { kind: "skipped"; reason: string }
  | { kind: "head_moved"; reviewed: string; current: string }
  | { kind: "failed"; reason: string };

export interface JobSummaryInput {
  repo: string;
  pr: number;
  outcome: JobOutcome;
  mode: ReviewMode | "skip" | null;
  engines: EngineRunSummary[];
  /** RenderedReview.counts, when a review was rendered. */
  counts?: ReviewCounts | null;
  redactions: number;
  totalDurationMs?: number | null;
  runDocument?: RunDocument | null;
}

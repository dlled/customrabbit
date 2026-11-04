// Input/output types of the merge step (design §7). Shared domain types live in src/types.ts.

import type {
  Category,
  EngineName,
  FindingMarker,
  MergedFinding,
  Profile,
  Side,
  Threshold,
  VerifyOutput,
} from "../types.js";

/** Version of the merge/dedupe logic, recorded in the run document (`run.merge_version`). */
export const MERGE_VERSION = "m1";

/** Default number of verify calls per run (§6.3). */
export const DEFAULT_VERIFY_BUDGET = 8;

/**
 * Where a finding may be anchored (§8.2). Built by src/github from the merge-base diff.
 * `isAnchored` must return true only when every line of `line..endLine` is a valid comment line of
 * `path` on `side`, and the whole range lies in one hunk.
 */
export interface AnchorMap {
  isAnchored(path: string, side: Side, line: number, endLine: number | null): boolean;
}

/** One commentable line of the merge-base diff: added/context lines are RIGHT, deleted lines LEFT. */
export interface AnchorTuple {
  path: string;
  side: Side;
  line: number;
  /** Index of the hunk within the file (any stable id); a range must stay inside one hunk. */
  hunk: number;
}

/** Engine output that reached the merge step, before validation. */
export interface EngineOutputInput {
  engine: EngineName;
  /** Parsed JSON from the engine; validated again here (§7.2 step 1). */
  output: unknown;
}

/**
 * A myrabbit review thread from earlier runs of this PR (§8.4), as parsed by src/github.
 * `state` already reflects this run's resolve step (§6.4):
 * - open: unresolved
 * - addressed: resolved by myrabbit, earlier or in this run
 * - superseded: an open `blk=0` thread replaced in this run by a blocking new finding with the same
 *   fingerprint (set by mergeReview; never blocks)
 * - dismissed: resolved by a human (Q9)
 */
export interface PriorThread {
  marker: FindingMarker;
  state: "open" | "addressed" | "superseded" | "dismissed";
  path: string;
  /** Current line, or the original line when the thread is outdated. */
  line: number;
  end_line: number | null;
  side: Side;
  category: Category;
  summary: string;
  body: string;
  /** From the comment footer; empty means unknown (the run's sources are used then). */
  sources: EngineName[];
  confidence: number | null;
}

/** What a verify call gets (§6.3). The caller picks the engine: the one not in `finding.sources`. */
export interface VerifyRequest {
  finding: MergedFinding;
  failure_scenario: string;
  evidence: string[];
  rule: string | null;
}

/**
 * Injected verifier; rejects (throws) on error or timeout. `signal` aborts when the merge step's
 * per-call timeout fires, so the caller can cancel the engine call instead of leaving it running.
 */
export type VerifyFn = (request: VerifyRequest, signal: AbortSignal) => Promise<VerifyOutput>;

/**
 * No engine contributed valid output (both failed, both outputs failed validation here, or none
 * were given). Design §2.2: post no review and exit 1; never APPROVE. W6 maps this to exit 1.
 */
export class NoEngineOutputError extends Error {
  override readonly name = "NoEngineOutputError";
  constructor(message = "no engine produced valid output; refusing to decide a verdict") {
    super(message);
  }
}

/** Throws {@link NoEngineOutputError} when no engine contributed. */
export function assertSources(sources: readonly unknown[]): void {
  if (sources.length === 0) throw new NoEngineOutputError();
}

/** Coverage gap (§7.5); null or `notReviewed: 0` means complete. */
export interface CoverageGap {
  /** Files in scope after path_filters that were not reviewed. */
  notReviewed: number;
  /** Human-readable limit that was hit, e.g. "max_files 150". */
  limit: string;
}

export interface MergeOptions {
  threshold: Threshold;
  profile: Profile;
  maxInlineComments: number;
  /** Paths of the reviewed diff; findings on other paths are dropped (§7.2 step 1). */
  diffPaths: ReadonlySet<string>;
  anchors: AnchorMap;
  priorThreads: readonly PriorThread[];
  verify: VerifyFn;
  /** Default {@link DEFAULT_VERIFY_BUDGET}. */
  verifyBudget?: number;
  /** Parallel verify calls. Default 2. */
  verifyConcurrency?: number;
  /** Per-call timeout; a timeout counts as a verifier error. Default: none (the verifier owns it). */
  verifyTimeoutMs?: number;
  /**
   * design-v2 §7.4.3: deterministic support from static analysis. A single-source finding that
   * needs verification, and has a member whose `rule` equals an item's rule and whose RIGHT-side
   * range on the same path holds the item's line, counts as `verified` with no verify call (a
   * deterministic tool plus one engine are two independent sources). Default: none.
   */
  externalSupport?: readonly ExternalSupport[];
  /**
   * design-v2 §4.5: the base config's label names. Engine `labels` outside it are dropped.
   * Absent = no labels are kept.
   */
  labelNames?: ReadonlySet<string>;
  /**
   * design-v2 §4.6: the candidate numbers given to the engines. Engine `related` items naming any
   * other number are dropped. Absent = no related items are kept.
   */
  candidateNumbers?: ReadonlySet<number>;
}

/** One (path, line, rule) a deterministic tool reported (design-v2 §7.4.3). */
export interface ExternalSupport {
  path: string;
  /** Head-side (RIGHT) line. */
  line: number;
  /** `<tool>:<rule>`, as the engines are told to cite it. */
  rule: string;
}

/** Counts of everything the merge step removed, for the review body (§8.6 "Review info"). */
export interface DropCounts {
  /** Whole engine outputs that failed validation. */
  invalid_output: number;
  /** Findings that failed the schema for any other reason. */
  invalid_finding: number;
  missing_failure_scenario: number;
  missing_evidence: number;
  path_not_in_diff: number;
  /** Not drops: findings whose strings were cut to the length limits. */
  truncated: number;
  /**
   * Merged findings dropped because an open myrabbit thread already has their fingerprint (a new
   * blocking finding that supersedes an open `blk=0` thread is kept, not counted here).
   */
  duplicate_open: number;
  /** Merged findings dropped because a human resolved a thread with their fingerprint. */
  duplicate_dismissed: number;
}

export interface Placement {
  /** Inline comments, in order, at most maxInlineComments. */
  inline: MergedFinding[];
  /** Listed in the body. */
  body: MergedFinding[];
  /** Shown only as a count in the body (quiet profile: non-blocking minor/trivial). */
  countOnly: MergedFinding[];
}

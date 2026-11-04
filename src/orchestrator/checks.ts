// design-v2 §5 wiring: pre-merge checks from the base config, run around the review call.
//
// Before the review: linked issues (§5.5), docstring coverage (§5.1) and, only when it can matter,
// the override label's timeline events (§5.4) are gathered in parallel under one time budget and
// the run signal; each falls back to "nothing" (inconclusive / no override), never to a pass.
// After the merge: the engines' answers are combined (§5.2), failed error-mode checks become
// synthetic blockers (§5.3), and a trusted override drops them.

import {
  applyOverride,
  closingIssueNumbers,
  combineChecks,
  docstringCoverage,
  fetchLabelEvents,
  fetchLinkedIssues,
  OVERRIDE_LABEL,
  overrideDecision,
  type DocstringResult,
  type LabelEvent,
  type OverrideDecision,
} from "../checks/index.js";
import { redact } from "../env.js";
import type { DiffFile } from "../github/diff.js";
import type { GitHub, GitRunner, RepoRef } from "../github/index.js";
import type { EngineSummary } from "../merge/merge.js";
import type { SyntheticBlocker } from "../merge/verdict.js";
import type { LinkedIssue } from "../prompts/builder.js";
import type { CheckMode, EngineName, PreMergeChecksConfig, RunCheck } from "../types.js";
import { withBudget } from "./related.js";

/** Wall-clock budget shared by the check inputs (they are small: ≤ 5 issues, one parse pass). */
export const CHECKS_BUDGET_MS = 60_000;

const isOverrideLabel = (name: string) => name.toLowerCase() === OVERRIDE_LABEL;

function modes(config: PreMergeChecksConfig): CheckMode[] {
  return [config.title.mode, config.description.mode, config.docstrings.mode, config.linked_issues.mode, ...config.custom.map((c) => c.mode)];
}

/** Some check can block: only then can the override change anything. */
export function hasErrorCheck(config: PreMergeChecksConfig): boolean {
  return modes(config).includes("error");
}

/**
 * §5.4: a `labeled` / `unlabeled` event for the override label, from the pull_request payload, or
 * null for any other event. Such an event runs a full review (the head may already be reviewed).
 */
export function overrideLabelAction(payload: unknown): "labeled" | "unlabeled" | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { action?: unknown; label?: { name?: unknown } | null };
  if (p.action !== "labeled" && p.action !== "unlabeled") return null;
  const name = p.label?.name;
  return typeof name === "string" && isOverrideLabel(name) ? p.action : null;
}

export interface CheckInputs {
  /** §5.5; empty when the check is off, nothing is linked, or the fetch did not finish. */
  linkedIssues: LinkedIssue[];
  /** §5.1; absent when the check is off. */
  docstrings?: DocstringResult;
  /**
   * §5.4 timeline label events; empty when not needed; null when needed but the fetch failed or ran
   * out of time (the override is then "unreadable" and the blockers stay).
   */
  labelEvents: LabelEvent[] | null;
}

export interface GatherInput {
  config: PreMergeChecksConfig;
  github: GitHub;
  /** From the runner, never from the PR. */
  repo: RepoRef;
  pr: { number: number; body: string; labels: readonly string[] };
  git: GitRunner;
  headSha: string;
  /** Reviewed files of the diff. */
  files: readonly DiffFile[];
}

const NOT_FINISHED: DocstringResult = {
  status: "inconclusive",
  explanation: "Docstring coverage did not finish within the time budget.",
  total: 0,
  documented: 0,
};

/** Never rejects. */
export async function gatherCheckInputs(
  input: GatherInput,
  opts: { budgetMs?: number; now?: () => number; signal?: AbortSignal } = {},
): Promise<CheckInputs> {
  const now = opts.now ?? Date.now;
  const budget = { deadline: now() + (opts.budgetMs ?? CHECKS_BUDGET_MS), now, ...(opts.signal ? { signal: opts.signal } : {}) };
  const c = input.config;

  const numbers = c.linked_issues.mode === "off" ? [] : closingIssueNumbers(input.pr.body, input.repo);
  const linked = numbers.length === 0 ? Promise.resolve([]) : withBudget(fetchLinkedIssues(input.github, input.repo, numbers), [], budget);
  const docstrings =
    c.docstrings.mode === "off"
      ? Promise.resolve(undefined)
      : withBudget(docstringCoverage({ git: input.git, headSha: input.headSha, files: input.files, threshold: c.docstrings.threshold }), NOT_FINISHED, budget);
  // The events are read only when the label is on the PR now and a check can block.
  const needEvents = hasErrorCheck(c) && input.pr.labels.some(isOverrideLabel);
  // A failed or timed-out fetch (withBudget maps both to the fallback) stays apart from "no events".
  const events = needEvents
    ? withBudget<LabelEvent[] | null>(fetchLabelEvents(input.github, input.repo, input.pr.number), null, budget)
    : Promise.resolve([] as LabelEvent[]);

  const [linkedIssues, doc, labelEvents] = await Promise.all([linked, docstrings, events]);
  return { linkedIssues, labelEvents, ...(doc === undefined ? {} : { docstrings: doc }) };
}

export interface FinishedChecks {
  /** Run-document / body `checks` (empty when every check is off). */
  checks: RunCheck[];
  /** Synthetic blockers left after the override. */
  blockers: SyntheticBlocker[];
  /** Set when the label is on the PR and some check blocked or could block. */
  override: OverrideDecision | null;
}

/**
 * §5.2–§5.4. The engines' explanations are model text: they are redacted here, before they reach
 * the blocker title (and so the fingerprint and run document), and the renderer sanitizes both the
 * table cell and the blocker title on top of that.
 */
export function finishChecks(
  config: PreMergeChecksConfig,
  summaries: readonly EngineSummary[],
  ran: readonly EngineName[],
  inputs: CheckInputs,
  pr: { labels: readonly string[] },
  trustedAuthors: readonly string[],
): FinishedChecks {
  const clean = summaries.map((s) =>
    s.checks === undefined ? s : { ...s, checks: s.checks.map((c) => ({ ...c, explanation: redact(c.explanation) })) },
  );
  const combined = combineChecks(config, clean, ran, {
    linkedIssues: inputs.linkedIssues.length,
    ...(inputs.docstrings === undefined ? {} : { docstrings: inputs.docstrings }),
  });
  const labelled = pr.labels.some(isOverrideLabel);
  const override = labelled && hasErrorCheck(config) ? overrideDecision(inputs.labelEvents, pr.labels, trustedAuthors) : null;
  const blockers = override === null ? combined.blockers : applyOverride(combined.blockers, override);
  return { checks: combined.checks, blockers, override };
}

/** Trusted body note for §5.4 ("The body records who applied the label and when"), or null. */
export function overrideNote(d: OverrideDecision | null): string | null {
  if (d === null) return null;
  // Logins in code spans: nobody is notified. GitHub logins are [A-Za-z0-9-] only.
  const who = (login: string) => `\`${login.replace(/[^A-Za-z0-9-]/g, "")}\``;
  if (d.applied) {
    const at = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d.at) ? ` at ${d.at}` : "";
    return `Pre-merge check blockers are overridden by the \`${OVERRIDE_LABEL}\` label, applied by ${who(d.by)}${at}.`;
  }
  if (d.reason === "untrusted") {
    return `The \`${OVERRIDE_LABEL}\` label is ignored: it was last applied by ${d.by === undefined ? "an unknown sender" : who(d.by)}, who is not a trusted author.`;
  }
  if (d.reason === "unreadable") {
    return `The \`${OVERRIDE_LABEL}\` label is on the pull request, but its label events could not be read, so it is not applied and the pre-merge check blockers stay.`;
  }
  return null;
}

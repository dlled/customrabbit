// Pre-merge checks (design-v2 §5).
//
// Checks come only from the base config: a pull request can't add, change or waive one.
// - title, description, custom and linked_issues are judged by the engines in the review call: they
//   go into the trusted `<pre-merge-checks>` section (`promptChecks` → builder `checks`);
// - docstrings is computed in code (./docstrings.ts), with no model call;
// - linked_issues needs at least one linked issue (./linked-issues.ts); with none it is
//   `inconclusive` and is not asked;
// - the engines' answers are damped across engines (§5.2, ./damping.ts);
// - a combined `fail` in `error` mode becomes a SyntheticBlocker (§5.3) for src/merge/verdict.ts;
//   `warning` only shows in the body and the merge risk; `inconclusive` never blocks;
// - the trusted label override drops those blockers (§5.4, ./override.ts).
// Every check is off by default (P0 schema), and a check in mode `off` is neither asked nor listed.

import type { EngineSummary } from "../merge/merge.js";
import type { SyntheticBlocker } from "../merge/verdict.js";
import type { PromptCheck } from "../prompts/builder.js";
import type { ActiveCheckMode, CheckMode, CheckStatus, EngineName, PreMergeChecksConfig, RunCheck } from "../types.js";
import { dampStatus, type CheckVote } from "./damping.js";
import type { DocstringResult } from "./docstrings.js";

export { dampStatus, type CheckVote } from "./damping.js";
export { docstringCoverage, docstringResult, fileDocstrings, type DocstringResult } from "./docstrings.js";
export { closingIssueNumbers, fetchLinkedIssues, MAX_LINKED_ISSUES } from "./linked-issues.js";
export {
  applyOverride,
  fetchLabelEvents,
  OVERRIDE_LABEL,
  overrideDecision,
  type LabelEvent,
  type OverrideDecision,
} from "./override.js";

/** Built-in wording when the base config gives no `requirements`. */
export const DEFAULT_REQUIREMENTS = {
  title:
    "The title says what the change does, specifically enough to tell it apart from other changes, and matches the diff. " +
    'Fail an empty or generic title ("fix", "update", "wip", "changes") or one that describes something the diff does not do.',
  description:
    "The description says what changed and why, and is consistent with the diff. " +
    "Fail an empty description, a template left unfilled, or one that contradicts the diff.",
  linked_issues:
    "The pull request addresses the issues in `<linked-issues>` and contains no changes outside their scope. " +
    "Fail when a linked issue's stated problem is clearly left unaddressed or the diff adds unrelated changes.",
} as const;

/** One-line explanations are cut to this length in the blocker body (the title holds only the name). */
export const BLOCKER_EXPLANATION_CHARS = 200;

const active = (mode: CheckMode): mode is ActiveCheckMode => mode !== "off";
const requirementsOr = (r: string, d: string) => (r.trim() === "" ? d : r.trim());

export interface CheckContext {
  /** Linked issues fetched for §5.5 (count); 0 or absent → linked_issues is inconclusive. */
  linkedIssues?: number;
  /** §5.1 docstrings result; absent → inconclusive. */
  docstrings?: DocstringResult;
}

/** The model-judged checks to put in the prompt, in config order. */
export function promptChecks(config: PreMergeChecksConfig, ctx: CheckContext = {}): PromptCheck[] {
  const out: PromptCheck[] = [];
  if (active(config.title.mode)) {
    out.push({ name: "title", instructions: requirementsOr(config.title.requirements, DEFAULT_REQUIREMENTS.title) });
  }
  if (active(config.description.mode)) {
    out.push({ name: "description", instructions: requirementsOr(config.description.requirements, DEFAULT_REQUIREMENTS.description) });
  }
  if (active(config.linked_issues.mode) && (ctx.linkedIssues ?? 0) > 0) {
    out.push({ name: "linked_issues", instructions: DEFAULT_REQUIREMENTS.linked_issues });
  }
  for (const c of config.custom) {
    if (active(c.mode)) out.push({ name: c.name, instructions: c.instructions });
  }
  return out;
}

export interface CombinedChecks {
  /** Run-document `checks` (modes warning and error only). */
  checks: RunCheck[];
  /** Failed error-mode checks. */
  blockers: SyntheticBlocker[];
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** §5.2 for one model-judged check: status and explanation from the engines that ran. */
function modelCheck(name: string, summaries: readonly EngineSummary[], ran: readonly EngineName[]): { status: CheckStatus; explanation: string } {
  const votes: { engine: EngineName; vote: CheckVote; explanation: string }[] = ran.map((engine) => {
    const c = summaries.find((s) => s.engine === engine)?.checks?.find((x) => x.name === name);
    return { engine, vote: c?.status ?? "missing", explanation: oneLine(c?.explanation ?? "") };
  });
  const status = dampStatus(votes.map((v) => v.vote));
  if (votes.length === 0) return { status, explanation: "No engine result." };
  const agreeing = votes.find((v) => v.vote === status && v.explanation !== "");
  if (status !== "inconclusive" || votes.every((v) => v.vote === "inconclusive")) {
    return { status, explanation: agreeing?.explanation ?? "" };
  }
  const parts = votes.map((v) => `${v.engine}: ${v.vote === "missing" ? "no result" : v.vote}`);
  return { status, explanation: `Engines did not agree (${parts.join(", ")}).` };
}

/**
 * §5.2 damping over the engines that ran, and §5.3 blockers. `ran` lists the engines whose output
 * was used (MergeResult.sources): an engine that failed or was skipped did not run (v1 §2.2) and
 * casts no vote, so it does not split one.
 */
export function combineChecks(
  config: PreMergeChecksConfig,
  summaries: readonly EngineSummary[],
  ran: readonly EngineName[],
  ctx: CheckContext = {},
): CombinedChecks {
  const checks: RunCheck[] = [];
  const add = (name: string, mode: CheckMode, r: { status: CheckStatus; explanation: string }) => {
    if (active(mode)) checks.push({ name, mode, status: r.status, explanation: r.explanation });
  };

  add("title", config.title.mode, modelCheck("title", summaries, ran));
  add("description", config.description.mode, modelCheck("description", summaries, ran));
  add("docstrings", config.docstrings.mode, ctx.docstrings ?? { status: "inconclusive", explanation: "Docstring coverage was not computed." });
  add(
    "linked_issues",
    config.linked_issues.mode,
    (ctx.linkedIssues ?? 0) > 0
      ? modelCheck("linked_issues", summaries, ran)
      : { status: "inconclusive", explanation: "No linked issue: the description has no closing keyword for an issue in this repository." },
  );
  for (const c of config.custom) add(c.name, c.mode, modelCheck(c.name, summaries, ran));

  const blockers: SyntheticBlocker[] = checks
    .filter((c) => c.mode === "error" && c.status === "fail")
    .map((c) => {
      // The title is also the fingerprint's title (src/merge/verdict.ts), so it holds only the
      // check name: the engines' wording changes from run to run, and a blocker for the same
      // failed check must keep its fingerprint. The explanation goes in the body.
      const title = `Pre-merge check failed: ${c.name}`;
      const why = cut(oneLine(c.explanation), BLOCKER_EXPLANATION_CHARS);
      return { kind: "check", title, severity: "major", ...(why === "" ? {} : { body: `${title} — ${why}` }) };
    });
  return { checks, blockers };
}

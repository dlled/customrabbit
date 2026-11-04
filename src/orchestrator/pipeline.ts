// The review pipeline (design §2), end to end, with the failure policy of §2.2:
//
//   1 prepare  2 state  3 config  4 diff  5 context  6 review  7 merge  8 resolve  9 verdict
//   10 render  11 post  12 report
//
// Exit codes: 0 = posted, skipped, or head moved / PR closed before posting; 1 = failure (fail
// closed: no review, red check). Nothing here chooses the verdict except src/merge/verdict.ts.
// Every dependency with side effects is injected, so test/main.test.ts runs the whole pipeline
// offline with fake engines and a fake GitHub API.

import { basename } from "node:path";

import { CONFIG_PATH, LEARNINGS_PATH, loadReviewConfig, type GitReader, type ReviewConfig } from "../config/index.js";
import { loadRuntimeEnv, redact, type RuntimeEnv } from "../env.js";
import { engineTimeoutMs, resolveFinding, reviewInput, runBoth, verifierFor, verifyFinding } from "../engines/index.js";
import {
  AnchorMap,
  checkEligibility,
  fetchPullRequest,
  findLastReview,
  headSha,
  incrementalDiff,
  isBotLogin,
  listReviewThreads,
  listReviews,
  markAddressed,
  mergeBaseDiff,
  postReview,
  selectMode,
  applyIncrementalLimit,
  toPriorThread,
  type GitHub,
  type GitRunner,
  type ModeSelection,
  type ReviewThread,
} from "../github/index.js";
import {
  buildRunDocument,
  computeVerdict,
  MERGE_VERSION,
  mergeReview,
  NoEngineOutputError,
  serializeRunDocument,
  type DropCounts,
  type MergeResult,
  type PriorThread,
  type VerdictResult,
  type VerifyFn,
} from "../merge/index.js";
import { mergeRisk } from "../merge/risk.js";
import { packsFor } from "../prompts/packs/index.js";
import { buildContextPack, type ContextPack } from "../context/index.js";
import type { CandidatesResult } from "../related/index.js";
import { relatedUnion, startRelated } from "./related.js";
import { OVERRIDE_LABEL, promptChecks } from "../checks/index.js";
import { markConfirmed, type StaticAnalysisResult } from "../tools/index.js";
import { staticAnalysisStep, TOOLS_ISOLATION_NONE_WARNING, type ToolsDeps } from "./tools.js";
import { finishChecks, gatherCheckInputs, hasErrorCheck, overrideLabelAction, overrideNote, type CheckInputs } from "./checks.js";
import { reviewOutputSchema } from "../engines/schema.js";
import {
  buildReviewPrompt,
  newNonce,
  promptVersion,
  reviewOutputFeatures,
  type PromptContext,
  type ReportedFinding,
  type ReviewPromptInput,
  type StyleGuideEntry,
  type Templates,
} from "../prompts/builder.js";
import {
  renderJobSummary,
  renderReview,
  unavailableBanner,
  type EngineRunSummary,
  type JobOutcome,
  type ReviewCounts,
  type ReviewRenderInput,
  type SupersededThread,
  type ThreadRef,
  type WalkthroughRenderInput,
} from "../render/index.js";
import { applicableRules } from "../config/index.js";
import {
  ENGINE_NAMES,
  type Config,
  type Engine,
  type EngineName,
  type EngineResult,
  type ProposedLearning,
  type RunDocument,
  type RunEffort,
  type RunCheck,
  type RunExtras,
  type RunMode,
  type SuggestedReviewer,
} from "../types.js";
import { loadLearningTemplate } from "../learnings/index.js";
import { autoReviewSkipReason } from "./auto-review.js";
import { existingLearningTitles, proposeLearnings } from "./learnings.js";
import { normalizePrInput, readActionContext, resolvePrNumber, type ActionContext } from "./context.js";
import type { SetupEngines } from "./engines.js";
import { errorText, type Log } from "./log.js";
import { resolveCandidates } from "./resolve.js";
import { reviewScope, type ReviewScope } from "./scope.js";

/** Everything stops before the 30-minute job timeout so a failure is still reported. */
export const RUN_DEADLINE_MS = 24 * 60_000;
/** Per verify / resolve call (§6.3, §6.4); a timeout keeps a blocker blocking. */
export const SMALL_CALL_TIMEOUT_MS = 5 * 60_000;
/** Commit subjects shown to the engines (§6.2 pr-meta). */
export const MAX_COMMIT_SUBJECTS = 50;
export const RUN_DOCUMENT_FILE = "myrabbit-run.json";

export interface PipelineDeps {
  /** process.env; the secrets are deleted from it once read. */
  env: NodeJS.ProcessEnv;
  readEvent: (path: string) => Promise<unknown>;
  github: (runtime: RuntimeEnv, log: Log) => GitHub;
  git: (workspace: string) => GitRunner;
  gitReader: (workspace: string) => GitReader;
  setupEngines: SetupEngines;
  templates: Templates;
  /** design-v2 §6.2 proposal template; default src/prompts/learning.md (the bundle embeds it). */
  learningTemplate?: string;
  writeFile: (path: string, text: string) => Promise<void>;
  appendFile: (path: string, text: string) => Promise<void>;
  log: Log;
  now?: () => number;
  nonce?: () => string;
  runDeadlineMs?: number;
  smallCallTimeoutMs?: number;
  /** design-v2 §4.6–§4.7 budget; default RELATED_BUDGET_MS. */
  relatedBudgetMs?: number;
  /** design-v2 §5 check inputs budget; default CHECKS_BUDGET_MS. */
  checksBudgetMs?: number;
  /** design-v2 §7 tool install/run; absent = tools cannot be installed (gitleaks then fails closed). */
  tools?: ToolsDeps;
}

/** What the job summary reports; filled in as the run progresses. */
interface Report {
  repo: string;
  pr: number;
  mode: RunMode | null;
  engines: EngineRunSummary[];
  counts: ReviewCounts | null;
  redactions: number;
  runDocument: RunDocument | null;
  notes: string[];
}

class Outcome {
  constructor(
    readonly outcome: JobOutcome,
    readonly exitCode: 0 | 1,
  ) {}
}

const skipped = (reason: string): Outcome => new Outcome({ kind: "skipped", reason }, 0);

/**
 * MYRABBIT_ENGINES applied to the repository config: an engine not selected for this job is
 * disabled. Fails before any model call when nothing is left to run.
 */
export function withSelectedEngines(config: Config, selected: readonly EngineName[]): Config {
  const engines = { ...config.engines };
  if (!selected.includes("claude")) engines.claude = { ...engines.claude, enabled: false };
  if (!selected.includes("codex")) engines.codex = { ...engines.codex, enabled: false };
  if (!engines.claude.enabled && !engines.codex.enabled) {
    throw new Error(`no engine to run: this job selects ${selected.join(" and ")}, and the repository config disables ${selected.length === 1 ? "it" : "them"}`);
  }
  return { ...config, engines };
}

/** Runs one review. Never throws: every failure becomes exit 1 with the reason in the job summary. */
export async function runPipeline(deps: PipelineDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const report: Report = { repo: "", pr: 0, mode: null, engines: [], counts: null, redactions: 0, runDocument: null, notes: [] };
  let ctx: ActionContext | null = null;
  let result: Outcome;
  try {
    normalizePrInput(deps.env);
    // Secrets first: they are captured for redaction before anything else can print.
    const runtime = loadRuntimeEnv(deps.env);
    ctx = readActionContext(deps.env);
    report.repo = ctx.repoFullName;
    result = await review(deps, ctx, runtime, report);
  } catch (err) {
    const reason = err instanceof NoEngineOutputError ? `both engines failed: ${engineFailures(report.engines)}` : errorText(err);
    result = new Outcome({ kind: "failed", reason }, 1);
  }

  const o = result.outcome;
  deps.log(
    o.kind === "posted"
      ? `myrabbit: posted ${o.verdict}`
      : o.kind === "skipped"
        ? `myrabbit: skipped (${o.reason})`
        : o.kind === "head_moved"
          ? "myrabbit: head moved before posting; nothing posted"
          : `myrabbit: failed: ${o.reason}`,
  );
  await writeReport(deps, ctx, report, o, now() - startedAt);
  return result.exitCode;
}

function engineFailures(engines: readonly EngineRunSummary[]): string {
  const failed = engines.filter((e) => e.status === "failed").map((e) => `${e.engine}: ${e.error ?? "error"}`);
  return failed.length > 0 ? failed.join("; ") : "no engine produced valid output";
}

async function writeReport(deps: PipelineDeps, ctx: ActionContext | null, report: Report, outcome: JobOutcome, durationMs: number): Promise<void> {
  const stepSummary = ctx?.stepSummary ?? (deps.env.GITHUB_STEP_SUMMARY?.trim() || null);
  if (ctx?.runnerTemp && report.runDocument) {
    try {
      await deps.writeFile(`${ctx.runnerTemp}/${RUN_DOCUMENT_FILE}`, redact(serializeRunDocument(report.runDocument)));
    } catch (err) {
      deps.log(`could not write the run document: ${errorText(err)}`);
    }
  }
  if (stepSummary === null) return;
  let md = renderJobSummary({
    repo: report.repo || "unknown/unknown",
    pr: report.pr,
    outcome,
    mode: report.mode,
    engines: report.engines,
    counts: report.counts,
    redactions: report.redactions,
    totalDurationMs: durationMs,
    runDocument: report.runDocument,
  });
  if (report.notes.length > 0) md += `\n### Notes\n\n${report.notes.map((n) => `- ${n.replace(/\s+/g, " ")}`).join("\n")}\n`;
  try {
    await deps.appendFile(stepSummary, redact(md));
  } catch (err) {
    deps.log(`could not write the job summary: ${errorText(err)}`);
  }
}

// ---------------------------------------------------------------------------

async function review(deps: PipelineDeps, ctx: ActionContext, runtime: RuntimeEnv, report: Report): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const templates = deps.templates;
  const runSignal = AbortSignal.timeout(deps.runDeadlineMs ?? RUN_DEADLINE_MS);
  const smallTimeout = deps.smallCallTimeoutMs ?? SMALL_CALL_TIMEOUT_MS;

  // Loop guard (§8.1): never review a run the bot itself triggered.
  if (ctx.actor !== null && isBotLogin(ctx.actor, runtime.botLogin)) return skipped(`triggered by ${runtime.botLogin}`);

  // 1. prepare
  const event = await readEventPayload(deps, ctx);
  const prNumber = resolvePrNumber(ctx.trigger, runtime.prNumber, event);
  report.pr = prNumber;
  const gh = deps.github(runtime, log);
  const git = deps.git(ctx.workspace);
  const pr = await fetchPullRequest(gh, ctx.repo, prNumber);
  const head = await headSha(git);
  // §10.1: open, not a fork, trusted author, checkout == PR head. Before any model call, on both events.
  const eligibility = checkEligibility(pr, { trustedAuthors: runtime.trustedAuthors, checkedOutHead: head });
  // A PR merged or closed while its dispatch was queued (the sweep) has nothing left to review: a
  // neutral skip, not a failure. Only when that is the sole reason; anything else still fails closed.
  if (!eligibility.ok && eligibility.reasons.every((r) => r === "not_open")) {
    const state = pr.merged ? "merged" : "closed";
    log(`::notice::myrabbit: PR #${String(prNumber)} is ${state}; nothing to review`);
    return skipped(`PR is ${state}`);
  }
  if (!eligibility.ok) throw new Error(`refusing to review: ${eligibility.message}`);
  const headLower = head.toLowerCase();
  const baseSha = pr.base.sha.toLowerCase();

  // 2-3. state + config (config from the BASE SHA only)
  const reviews = await listReviews(gh, ctx.repo, prNumber);
  const last = findLastReview(reviews, runtime.botLogin);
  const cfg = await loadReviewConfig(deps.gitReader(ctx.workspace), baseSha);
  // The job's MYRABBIT_ENGINES narrows the repository config: an engine runs only if both enable it.
  const config = withSelectedEngines(cfg.config, runtime.engines);
  for (const w of cfg.warnings) log(`config: ${w}`);

  if (ctx.trigger === "pull_request") {
    const why = autoReviewSkipReason(config.auto_review, pr);
    if (why !== null) return skipped(why);
  }

  let selection: ModeSelection = await selectMode({ trigger: ctx.trigger, headSha: headLower, baseSha, configHash: cfg.hash, last, git });
  // design-v2 §5.4: adding or removing the override label runs a normal full review, even for a head
  // already reviewed, so the verdict follows the label. Only when some check can block.
  const labelAction = ctx.trigger === "pull_request" ? overrideLabelAction(event) : null;
  if (labelAction !== null && hasErrorCheck(config.pre_merge_checks)) {
    log(`${OVERRIDE_LABEL} ${labelAction}: full review`);
    selection = { mode: "full", reason: "label_override", last, from: baseSha, head: headLower };
  }
  report.mode = selection.mode;
  if (selection.mode === "skip") return skipped(`head ${headLower.slice(0, 7)} already reviewed`);

  // 4. diff: the merge-base diff is the anchor map in both modes (§8.2).
  const fullDiff = await mergeBaseDiff(git, baseSha, headLower);
  let incremental: Awaited<ReturnType<typeof incrementalDiff>> | null = null;
  let scope: ReviewScope;
  if (selection.mode === "incremental" && selection.from !== null) {
    incremental = await incrementalDiff(git, selection.from, headLower, baseSha);
    scope = reviewScope(incremental.files, cfg.pathFilter, config.limits);
    selection = applyIncrementalLimit(selection, scope.inScopeCount, config.limits.max_files, baseSha);
    if (selection.mode !== "incremental") {
      incremental = null;
      scope = reviewScope(fullDiff.files, cfg.pathFilter, config.limits);
    }
  } else {
    scope = reviewScope(fullDiff.files, cfg.pathFilter, config.limits);
  }
  const mode = selection.mode === "incremental" ? "incremental" : "full";
  report.mode = mode;
  const rangeFrom = mode === "incremental" && selection.from !== null ? selection.from : baseSha;
  log(
    `mode ${mode} (${selection.reason}); ${scope.files.reviewed.length} reviewed, ${scope.files.filtered.length} filtered, ` +
      `${scope.files.binary.length} binary, ${scope.files.notReviewed.length} over limit`,
  );
  const anchors = new AnchorMap(fullDiff.files);

  // 5. context: our threads from earlier runs.
  const threads = await listReviewThreads(gh, ctx.repo, prNumber, runtime.botLogin);
  const pairs = threads.flatMap((t) => {
    const p = toPriorThread(t);
    return p === null ? [] : [{ thread: t, prior: p }];
  });
  const ourThreads: ReviewThread[] = pairs.map((p) => p.thread);
  const priorInput: PriorThread[] = pairs.map((p) => p.prior);
  const alreadyReported: ReportedFinding[] = priorInput
    .filter((t) => t.state === "open")
    .map((t) => ({ fingerprint: t.marker.fp, path: t.path, line: t.line, severity: t.marker.sev, title: t.summary }));

  const promptCtx: PromptContext = {
    repo: ctx.repoFullName,
    language: config.language,
    toneInstructions: config.tone_instructions,
    nonce: (deps.nonce ?? newNonce)(),
  };
  const pVersion = promptVersion(templates);
  const notes = [...cfg.styleGuide.notes];
  if (touchesConfig(fullDiff.files.map((f) => f.path), cfg)) {
    notes.push("This PR changes the myrabbit config or a style guide; config changes take effect after merge.");
  }

  // 6-8. review, merge, resolve
  let merged: MergeResult;
  let sources: EngineName[];
  let addressed: ResolvedThread[] = [];
  let proposals: ProposedLearning[] = [];
  /** design-v2 §3; `symbols` are the §4.6 search keywords. */
  let contextPack: ContextPack | null = null;
  const reviewedPaths = new Set(scope.files.reviewed);
  /** design-v2 §4.6 (null = feature off) and §4.7 (null = off or not run). */
  let candidates: CandidatesResult | null = null;
  let reviewersP: Promise<SuggestedReviewer[] | null> = Promise.resolve(null);
  /** design-v2 §5 inputs; none when the engines do not run. */
  let checkInputs: CheckInputs = { linkedIssues: [], labelEvents: [] };
  /** design-v2 §7 result; null when off or when the engines do not run. */
  let tools: StaticAnalysisResult | null = null;
  if (scope.selected.length === 0) {
    // Nothing to send to a model (every file filtered, binary or over a limit, or no change at all).
    sources = ENGINE_NAMES.filter((e) => config.engines[e].enabled);
    report.engines = ENGINE_NAMES.map((engine) => ({ engine, status: config.engines[engine].enabled ? "not_run" : "disabled" }));
    notes.push("No reviewable text changes; the engines were not run.");
    merged = emptyMerge(sources, priorInput);
  } else {
    // design-v2 §4.6–§4.7 (off by default): reviewers start now, the candidate search once the pack's
    // symbols are known; each gets its own time budget from when it starts, and neither fails the run.
    const related = startRelated(
      { related: config.walkthrough.related, reviewers: config.walkthrough.suggested_reviewers },
      { repo: ctx.repo, baseSha, prNumber, prAuthor: pr.author, title: pr.title, paths: scope.files.reviewed },
      { github: gh, git },
      { ...(deps.relatedBudgetMs === undefined ? {} : { budgetMs: deps.relatedBudgetMs }), now, signal: runSignal },
    );
    reviewersP = related.reviewers;
    const reviewedFiles = (incremental ?? fullDiff).files.filter((f) => reviewedPaths.has(f.path));
    // design-v2 §5 inputs (linked issues, docstrings, override label events), under their own time
    // budget and the run signal, while the context pack is built.
    const checkInputsP = gatherCheckInputs(
      {
        config: config.pre_merge_checks,
        github: gh,
        repo: ctx.repo,
        pr: { number: prNumber, body: pr.body, labels: pr.labels },
        git,
        headSha: headLower,
        files: reviewedFiles,
      },
      { ...(deps.checksBudgetMs === undefined ? {} : { budgetMs: deps.checksBudgetMs }), now, signal: runSignal },
    );
    // design-v2 §7 (off by default): install + run the pinned tools, also while the context pack is
    // built. Never rejects; per-tool timeouts and the run signal bound it. Always over the FULL PR
    // range (merge-base diff, path_filters applied), incremental runs included: a secret blocker is a
    // locationless synthetic item with no thread or marker state, so it must be recomputed against the
    // whole PR every run or it would stop blocking after an unrelated push.
    const prFiles = fullDiff.files.filter((f) => cfg.pathFilter.matches(f.path));
    if (config.tools.enabled && runtime.isolation === "none") log(TOOLS_ISOLATION_NONE_WARNING);
    const toolsP = staticAnalysisStep({
      config: config.tools,
      deps: deps.tools,
      git,
      headSha: headLower,
      files: prFiles,
      signal: runSignal,
      log,
      isolation: runtime.isolation,
    });
    // 5. context (design-v2 §3): the code-graph pack, computed once for both engines from git blobs
    // of the reviewed range. Off by default; never fails the run (null on any error).
    // buildContextPack only listens for a later `abort` event, so a deadline that has already passed
    // is checked here.
    contextPack = runSignal.aborted ? null : await buildContextPack({
      git,
      baseSha: rangeFrom,
      headSha: headLower,
      files: reviewedFiles,
      includePath: (p) => cfg.pathFilter.matches(p),
      diffChars: scope.diffText.length,
      config: config.context,
      signal: runSignal,
    });
    if (contextPack !== null) {
      log(`context: ${contextPack.info.symbols} symbol(s), ${contextPack.info.usages} usage(s), ${contextPack.info.dropped} dropped`);
    }
    candidates = await related.candidates(contextPack?.symbols ?? []);
    if (candidates !== null) {
      log(candidates.unavailable ? "related: unavailable" : `related: ${candidates.candidates.length} candidate(s)`);
    }
    checkInputs = await checkInputsP;
    tools = await toolsP;
    for (const n of tools?.notes ?? []) log(`tools: ${n}`);
    const checksAsked = promptChecks(config.pre_merge_checks, {
      linkedIssues: checkInputs.linkedIssues.length,
      ...(checkInputs.docstrings === undefined ? {} : { docstrings: checkInputs.docstrings }),
    });
    const setup = await deps.setupEngines({
      config,
      secrets: runtime.secrets,
      workspace: ctx.workspace,
      runnerTemp: ctx.runnerTemp,
      now: now(),
      log,
      isolation: runtime.isolation,
    });
    report.notes.push(...setup.denyNotes);
    try {
      const commitSubjects = await commitSubjectsOf(git, baseSha, headLower);
      const rules = applicableRules(scope.files.reviewed, cfg.styleGuide.guides, cfg.styleGuide.instructions);
      const styleGuides: StyleGuideEntry[] = cfg.styleGuide.guides.map((g) => ({
        id: g.id,
        source: g.path,
        scope: g.scope.join(", "),
        text: g.content,
        // design-v2 §6.1: a learnings section is cited as `rule: "learning:<title>"`.
        ...(g.origin === "learnings" && g.title !== undefined ? { learning: g.title } : {}),
      }));
      const packs = packsFor(scope.files.reviewed, config.rule_packs);
      const promptInput: ReviewPromptInput = {
          context: promptCtx,
          mode,
          baseSha,
          headSha: headLower,
          lastSha: mode === "incremental" ? rangeFrom : null,
          styleGuides,
          pathInstructions: cfg.styleGuide.instructions.map((p) => ({ id: p.id, path: p.path, instructions: p.instructions })),
          files: scope.files.reviewed.map((path) => {
            const r = rules.get(path);
            return { path, ruleIds: r === undefined ? [] : [...r.guides, ...r.instructions] };
          }),
          alreadyReported,
          pr: { title: pr.title, description: pr.body, commitSubjects },
          diff: scope.diffText,
          // design-v2 §3.3: the pack goes only into the untrusted `<related-code>` block.
          ...(contextPack !== null && contextPack.text.trim() !== "" ? { relatedCode: contextPack.text } : {}),
          // design-v2 §4.4: enabled packs whose globs match a reviewed file (none by default).
          ...(packs.length > 0 ? { rulePacks: packs.map((p) => ({ name: p.name, text: p.text })) } : {}),
          // design-v2 §4.1: ask for the effort estimate only while the walkthrough shows it.
          ...(config.walkthrough.effort ? { effort: true } : {}),
          // design-v2 §4.6: the candidates go into the untrusted `<candidates>` block, enabling `related`.
          ...(candidates !== null && candidates.candidates.length > 0 ? { candidates: candidates.candidates } : {}),
          // design-v2 §5.1/§5.5: checks in the trusted section, linked issues in the untrusted block.
          ...(checksAsked.length > 0 ? { checks: checksAsked } : {}),
          ...(checkInputs.linkedIssues.length > 0 ? { linkedIssues: checkInputs.linkedIssues } : {}),
          // design-v2 §7.4: hits in the untrusted `<static-analysis>` block (gitleaks: location and rule only).
          ...(tools !== null && tools.info.hits.length > 0
            ? { staticAnalysis: tools.info.hits.map(({ tool, rule, path, line, message }) => ({ tool, rule, path, line, message })) }
            : {}),
      };
      const built = buildReviewPrompt(promptInput, templates);
      // The output schema asks for exactly the v2 fields the prompt asks for (v1 schema when none).
      const engineInput = {
        ...reviewInput(built, ctx.workspace),
        outputSchema: reviewOutputSchema(reviewOutputFeatures(promptInput)),
      };

      const results =
        setup.engines.length === 0
          ? []
          : await runBoth(setup.engines, engineInput, {
              timeoutMs: engineTimeoutMs(config.engines),
              signal: runSignal,
            });
      report.engines = engineSummaries(setup.notRunning, results);
      for (const r of results) {
        log(r.ok ? `${r.engine}: ok in ${Math.round(r.durationMs / 1000)} s` : `${r.engine}: failed (${r.error.kind}): ${r.error.message}`);
      }
      // Loud in the job log too: an engine account that was unusable (quota, rate limit, auth).
      const banner = unavailableBanner(report.engines);
      if (banner !== null) for (const line of banner.split("\n")) log(`::warning::myrabbit: ${line}`);
      const okEngines = setup.engines.filter((e) => results.some((r) => r.ok && r.engine === e.name));

      const callOpts = { context: promptCtx, cwd: ctx.workspace, headSha: headLower, templates, timeoutMs: smallTimeout };
      const verify: VerifyFn = async (req, signal) => {
        const engine = verifierFor(req.finding.sources[0] ?? "claude", okEngines);
        if (engine === null) throw new Error("no engine available to verify");
        const f = req.finding;
        const res = await verifyFinding(
          engine,
          {
            path: f.path,
            line: f.line,
            end_line: f.end_line,
            side: f.side,
            severity: f.severity,
            category: f.category,
            title: f.summary,
            body: f.body,
            failure_scenario: req.failure_scenario,
            evidence: req.evidence,
          },
          { ...callOpts, signal: AbortSignal.any([signal, runSignal]) },
        );
        if (!res.ok) throw new Error(`${res.engine} verify failed: ${res.error.kind}`);
        return res.output;
      };

      // 7. merge (throws NoEngineOutputError when no engine produced valid output: exit 1).
      merged = await mergeReview(
        results.flatMap((r) => (r.ok ? [{ engine: r.engine, output: r.output }] : [])),
        {
          threshold: config.request_changes_threshold,
          profile: config.profile,
          maxInlineComments: config.limits.max_inline_comments,
          diffPaths: new Set(scope.files.reviewed),
          anchors,
          priorThreads: priorInput,
          verify,
          verifyTimeoutMs: smallTimeout,
          // design-v2 §7.4.3: a finding citing a hit's `<tool>:<rule>` at its line counts as verified.
          ...(tools !== null && tools.support.length > 0 ? { externalSupport: tools.support } : {}),
          ...(candidates !== null ? { candidateNumbers: new Set(candidates.candidates.map((c) => c.number)) } : {}),
        },
      );
      sources = merged.sources;
      log(`merge: ${merged.findings.length} findings, ${merged.verifyCalls} verify calls`);

      // 8. resolve (incremental only): one engine, ≤ 10 threads on changed code.
      const resolver = okEngines[0];
      if (mode === "incremental" && incremental !== null && resolver !== undefined) {
        addressed = await resolveThreads(resolver, ourThreads, merged.priorThreads, incremental.files, {
          ...callOpts,
          lastSha: rangeFrom,
          signal: runSignal,
          log,
        });
      }

      // design-v2 §6.2: learning proposals for dismissed threads (off by default).
      if (config.learnings.propose && okEngines.length > 0) {
        proposals = await proposeLearnings({
          threads: ourThreads,
          priors: merged.priorThreads,
          reviews,
          botLogin: runtime.botLogin,
          trustedAuthors: runtime.trustedAuthors,
          engines: okEngines,
          git,
          baseSha,
          headSha: headLower,
          existingTitles: await existingLearningTitles(deps.gitReader(ctx.workspace), baseSha, log),
          context: promptCtx,
          templates,
          learningTemplate: deps.learningTemplate ?? loadLearningTemplate(),
          cwd: ctx.workspace,
          timeoutMs: smallTimeout,
          signal: runSignal,
          log,
        });
      }
    } finally {
      await setup.cleanup();
    }
  }

  const reviewers = await reviewersP;
  if (reviewers !== null) log(`reviewers: ${reviewers.length} suggested`);

  const priorThreads = merged.priorThreads.map((t, i) => (addressed.some((a) => a.index === i) ? { ...t, state: "addressed" as const } : t));

  // design-v2 §5.2–§5.4: combined over the engines whose output was used; a failed error-mode check
  // is a synthetic blocker unless a trusted override drops it.
  const checks = finishChecks(config.pre_merge_checks, merged.engineSummaries, merged.sources, checkInputs, pr, runtime.trustedAuthors);
  const note = overrideNote(checks.override);
  if (note !== null) notes.push(note);
  const blockers = [...(tools?.blockers ?? []), ...checks.blockers];
  // design-v2 §7.4.4: hits an engine reported as a `<tool>:<rule>` finding are confirmed; the rest
  // are the collapsed "Static analysis (not confirmed)" list.
  const toolsInfo = tools === null ? null : { runs: tools.info.runs, hits: markConfirmed(tools.info.hits, merged.findings) };

  // 9. verdict (deterministic)
  const verdict = computeVerdict({
    findings: merged.findings,
    priorThreads,
    threshold: config.request_changes_threshold,
    coverage: scope.coverage,
    sources,
    // design-v2 §7.5 secret / secret-scan blockers first, then §5.3 failed checks.
    ...(blockers.length > 0 ? { syntheticBlockers: blockers } : {}),
  });

  // design-v2 §4: walkthrough items, each only while its feature is on, so the defaults render
  // exactly the v1 body and run document.
  const walkthrough = walkthroughItems(config, merged, priorThreads, verdict, proposals, checks.checks);
  // §3.2: the "Additional context" line in Review info, and the run document `context` field.
  if (contextPack !== null) walkthrough.context = { ...contextPack.info };
  // §4.6–§4.7: present only while the feature is on.
  if (candidates !== null) {
    if (candidates.unavailable) walkthrough.relatedUnavailable = true;
    const items = relatedUnion(merged.engineSummaries.map((s) => s.related), candidates.candidates);
    if (items.length > 0) walkthrough.related = items;
  }
  if (reviewers !== null && reviewers.length > 0) walkthrough.reviewers = reviewers.map((r) => ({ ...r }));
  // §7.4.4 / §7.5: tool runs and hits (run document `tools`, body "Static analysis").
  if (toolsInfo !== null) walkthrough.tools = toolsInfo;
  const extras: RunExtras = {
    ...(walkthrough.tools === undefined ? {} : { tools: walkthrough.tools }),
    ...(walkthrough.risk === undefined ? {} : { risk: walkthrough.risk }),
    ...(walkthrough.effort === undefined ? {} : { effort: walkthrough.effort }),
    ...(walkthrough.context === undefined ? {} : { context: walkthrough.context }),
    ...(walkthrough.related === undefined ? {} : { related: walkthrough.related }),
    ...(walkthrough.reviewers === undefined ? {} : { reviewers: walkthrough.reviewers }),
    ...(walkthrough.checks === undefined ? {} : { checks: walkthrough.checks }),
    ...(proposals.length > 0 ? { proposed_learnings: proposals } : {}),
  };

  // The run document checks verdict vs findings; built before posting so a mismatch posts nothing.
  const runDocument = buildRunDocument({
    promptVersion: pVersion,
    sources,
    verdict: verdict.verdict,
    findings: merged.findings,
    coverage: verdict.coverage,
    ...(verdict.synthetic.length > 0 ? { synthetic: verdict.synthetic } : {}),
    priorThreads,
    threshold: config.request_changes_threshold,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  });
  report.runDocument = runDocument;

  // 10. render
  const threadRef = (t: PriorThread, i: number): ThreadRef => ({
    path: t.path,
    line: t.line,
    severity: t.marker.sev,
    category: t.category,
    title: t.summary,
    fingerprint: t.marker.fp,
    url: null,
    resolvedBy: ourThreads[i]?.resolvedBy ?? null,
  });
  const indexed = priorThreads.map((t, i) => ({ t, i }));
  const renderInput: ReviewRenderInput = {
    verdict: verdict.verdict,
    repo: ctx.repoFullName,
    state: { v: 1, head: headLower, base: baseSha, mode, config: cfg.hash, prompt: pVersion },
    rangeFrom,
    config,
    summary: leadSummary(merged)?.summary ?? "",
    changes: leadSummary(merged)?.changes ?? [],
    findings: [...(verdict.coverage ? [verdict.coverage] : []), ...verdict.synthetic, ...merged.findings],
    priorBlocking: verdict.blockingThreads.map((t) => threadRef(t, priorThreads.indexOf(t))),
    dismissed: indexed.filter(({ t }) => t.state === "dismissed" && t.marker.blk).map(({ t, i }) => threadRef(t, i)),
    superseded: indexed
      .filter(({ t }) => t.state === "superseded")
      .map(({ t, i }): SupersededThread => ({
        ...threadRef(t, i),
        supersededBy: merged.supersededBy.get(t.marker.fp) ?? t.marker.fp,
      })),
    addressed: addressed.length,
    engines: report.engines,
    files: scope.files,
    droppedByValidation: droppedByValidation(merged.drops),
    runUrl: ctx.runUrl,
    mergeVersion: MERGE_VERSION,
    configWarnings: cfg.warnings,
    notes,
    ...(Object.keys(walkthrough).length > 0 ? { walkthrough } : {}),
  };
  const rendered = renderReview(renderInput);
  report.counts = rendered.counts;
  report.redactions = rendered.redactions;

  // 11. post (head recheck, one POST, 422 → body-only retry)
  const posted = await postReview(gh, ctx.repo, {
    pullNumber: prNumber,
    commitId: headLower,
    event: rendered.event,
    body: rendered.body,
    comments: rendered.comments,
    bodyWithComments: (body, comments) => (comments.length === 0 ? body : renderReview(renderInput, { inline: false }).body),
  });
  if (posted.status === "head_moved") {
    return new Outcome({ kind: "head_moved", reviewed: headLower, current: posted.currentHead }, 0);
  }
  if (posted.status === "closed") return skipped("PR was closed before posting");
  if (posted.bodyOnly) log(`inline comments rejected (422); posted body-only. Rejected anchors: ${posted.rejectedAnchors.join(", ")}`);

  // Thread edits happen only after the review is posted, so a run that posts nothing changes nothing.
  for (const a of addressed) {
    try {
      const r = await markAddressed(gh, ctx.repo, a.thread, headLower);
      if (r.resolveError !== null) log(`thread marked addressed but not resolved (${r.resolveError})`);
    } catch (err) {
      log(`could not mark a thread addressed: ${errorText(err)}`);
    }
  }
  return new Outcome({ kind: "posted", verdict: rendered.event }, 0);
}

// ---------------------------------------------------------------------------

async function readEventPayload(deps: PipelineDeps, ctx: ActionContext): Promise<unknown> {
  if (ctx.trigger === "workflow_dispatch") return null;
  const path = deps.env.GITHUB_EVENT_PATH?.trim();
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set");
  return deps.readEvent(path);
}

async function commitSubjectsOf(git: GitRunner, base: string, head: string): Promise<string[]> {
  const r = await git(["log", "--no-color", "--format=%s", `-n${MAX_COMMIT_SUBJECTS}`, `${base}..${head}`, "--"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((s) => s.trim() !== "");
}

const GUIDE_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

/** True when the PR edits the config or a style guide (they apply only after merge, §4). */
function touchesConfig(paths: readonly string[], cfg: ReviewConfig): boolean {
  const extra = new Set(cfg.config.style_guide.files);
  return paths.some(
    (p) => p === CONFIG_PATH || p === LEARNINGS_PATH || GUIDE_NAMES.has(basename(p)) || /(^|\/)\.claude\/rules\//.test(p) || extra.has(p),
  );
}

function engineSummaries(notRunning: readonly EngineRunSummary[], results: readonly EngineResult[]): EngineRunSummary[] {
  const byName = new Map<EngineName, EngineRunSummary>();
  for (const s of notRunning) byName.set(s.engine, s);
  for (const r of results) {
    byName.set(r.engine, {
      engine: r.engine,
      status: r.ok ? "ok" : "failed",
      error: r.ok ? null : r.error.kind === "credential" ? r.error.message : r.error.kind,
      errorKind: r.ok ? null : r.error.kind,
      model: r.model,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
    });
  }
  return ENGINE_NAMES.flatMap((e) => {
    const s = byName.get(e);
    return s === undefined ? [] : [s];
  });
}

/**
 * design-v2 §4.1–§4.3, §6.2 body items for this run. Empty when every feature is off.
 * - risk (§4.2): mergeRisk over the verdict's blocking set; it throws on a verdict mismatch, which
 *   fails the run before anything is posted (fail closed).
 * - effort (§4.1): the higher score among the engines, with its minutes.
 */
export function walkthroughItems(
  config: ReviewConfig["config"],
  merged: Pick<MergeResult, "findings" | "engineSummaries">,
  priorThreads: readonly PriorThread[],
  verdict: VerdictResult,
  proposals: readonly ProposedLearning[],
  checks: readonly RunCheck[] = [],
): WalkthroughRenderInput {
  const wt = config.walkthrough;
  const out: WalkthroughRenderInput = {};
  if (wt.merge_risk) {
    const openNonBlocking =
      merged.findings.filter((f) => !f.blocking).length +
      priorThreads.filter((t) => t.state === "open" && !verdict.blockingThreads.includes(t)).length;
    // §4.2: a failed warning-mode check raises the risk to low; error-mode ones are in the verdict.
    out.risk = mergeRisk({ verdict, openNonBlocking, checks });
  }
  // §5.3: the "Pre-merge checks" table (checks in mode off are never in the list).
  if (checks.length > 0) out.checks = checks.map((c) => ({ ...c }));
  if (wt.effort) {
    let best: RunEffort | undefined;
    for (const s of merged.engineSummaries) {
      if (s.effort && (best === undefined || s.effort.score > best.score)) best = { score: s.effort.score, minutes: s.effort.minutes };
    }
    if (best !== undefined) out.effort = best;
  }
  if (wt.ai_agent_prompts) out.aiAgentPrompts = true;
  if (proposals.length > 0) out.proposedLearnings = proposals.map((p) => ({ ...p, paths: [...p.paths] }));
  return out;
}

function leadSummary(merged: MergeResult): MergeResult["engineSummaries"][number] | undefined {
  return merged.engineSummaries.find((s) => s.engine === "claude") ?? merged.engineSummaries[0];
}

function droppedByValidation(d: DropCounts): number {
  return d.invalid_output + d.invalid_finding + d.missing_failure_scenario + d.missing_evidence + d.path_not_in_diff;
}

function emptyMerge(sources: EngineName[], priorThreads: PriorThread[]): MergeResult {
  if (sources.length === 0) throw new NoEngineOutputError("no engine is enabled");
  return {
    sources,
    findings: [],
    details: new Map(),
    engineSummaries: [],
    drops: {
      invalid_output: 0,
      invalid_finding: 0,
      missing_failure_scenario: 0,
      missing_evidence: 0,
      path_not_in_diff: 0,
      truncated: 0,
      duplicate_open: 0,
      duplicate_dismissed: 0,
    },
    placement: { inline: [], body: [], countOnly: [] },
    verifyCalls: 0,
    priorThreads,
    supersededBy: new Map(),
  };
}

interface ResolvedThread {
  index: number;
  thread: ReviewThread;
}

async function resolveThreads(
  engine: Engine,
  threads: readonly ReviewThread[],
  priors: readonly PriorThread[],
  incremental: Parameters<typeof resolveCandidates>[2],
  opts: Omit<Parameters<typeof resolveFinding>[2], "diff"> & { log: Log },
): Promise<ResolvedThread[]> {
  const out: ResolvedThread[] = [];
  for (const c of resolveCandidates(threads, priors, incremental)) {
    const p = c.prior;
    const res = await resolveFinding(
      engine,
      { path: p.path, line: p.line, end_line: p.end_line, side: p.side, severity: p.marker.sev, title: p.summary, body: p.body },
      { ...opts, diff: c.patch },
    );
    if (!res.ok) {
      opts.log(`resolve failed (${res.error.kind}); thread stays open`);
      continue;
    }
    if (res.output.fixed) out.push({ index: c.index, thread: c.thread });
  }
  opts.log(`resolve: ${out.length} thread(s) addressed`);
  return out;
}


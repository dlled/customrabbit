// Related issues/PRs and suggested reviewers (design-v2 §4.6, §4.7).
//
// Candidates are found in code and given to the engines as the untrusted `<candidates>` block;
// engines may only name candidate numbers (mergeReview `candidateNumbers`). Reviewers are computed
// from the base SHA with no model and are never requested. A failure here never fails the run.
//
// - Issues: one search `repo:<o>/<r> is:issue ("t1" OR …)` with safe, quoted tokens (keywords.ts),
//   post-filtered to `repository_url` == this repo, at most 10, within the 30/min search budget.
// - PRs: `git log --format=%H -n 20 <base> -- <files>` → `GET /repos/{o}/{r}/commits/{sha}/pulls`,
//   merged PRs of this repo only, deduped, at most 10.
// - Reviewers: CODEOWNERS at base (git blob) for the changed files, then the top 3 `git log`
//   authors of the last 12 months (before the base commit), mapped to logins via
//   `GET /repos/{o}/{r}/commits/{sha}`. The PR author, bots and unmapped authors are dropped.
//
// `deps.signal` really stops the work: every API call gets `request: { signal }` (which also cuts
// the client's rate-limit waits), every `git` process is killed, and loops stop at the next step.
// An aborted run still resolves: candidates found so far, and reviewers keep the CODEOWNERS pick.

import { listTree } from "../context/git.js";
import { assertSha, type GitHub, type GitResult, type GitRunner, type RepoRef } from "../github/index.js";
import type { RelatedCandidate } from "../prompts/builder.js";
import type { SuggestedReviewer } from "../types.js";
import { loadCodeowners, ownersOf } from "./codeowners.js";
import { issueQuery } from "./keywords.js";

/** §4.6: at most this many issues and this many PRs. */
export const MAX_CANDIDATES_PER_KIND = 10;
/** §4.6: the builder also cuts bodies; this keeps the run's memory small. */
export const CANDIDATE_BODY_CHARS = 500;
/** §4.6: commits that last touched the changed files. */
export const MAX_LOG_COMMITS = 20;
/** §4.7 step 2. */
export const MAX_RECENT_AUTHORS = 3;
export const MAX_CODEOWNERS_REVIEWERS = 5;
/** Changed paths given to one `git log` (pathspecs). */
export const MAX_LOG_PATHS = 200;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface RelatedInput {
  /** From the runner (GITHUB_REPOSITORY), never from the PR. */
  repo: RepoRef;
  baseSha: string;
  prNumber: number;
  prAuthor: string;
  title: string;
  /** Reviewed paths. */
  paths: readonly string[];
  /** Changed symbol names from the context pack (§3), if any. */
  symbols: readonly string[];
}

export interface RelatedDeps {
  github: GitHub;
  /** Full-history checkout; only `log`, `show -s`, `ls-tree` and `cat-file` are issued. */
  git: GitRunner;
  /** Search budget shared by the process (default {@link searchBudget}). */
  budget?: SearchBudget;
  /** Time budget: aborting stops requests, rate-limit waits and git; partial results are kept. */
  signal?: AbortSignal;
}

/** Sliding-window limiter for the search API (30 requests per minute). */
export class SearchBudget {
  private readonly stamps: number[] = [];
  constructor(
    readonly limit = 30,
    readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one request from the budget; false when the window is full. */
  tryTake(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(t);
    return true;
  }
}

export const searchBudget = new SearchBudget();

export interface CandidatesResult {
  /** Issues first, then PRs. */
  candidates: RelatedCandidate[];
  /** The issue search failed (or had no budget) and no PR candidate was found: "related: unavailable". */
  unavailable: boolean;
}

const LOG_CONFIG = ["-c", "core.quotePath=false", "-c", "log.showSignature=false", "-c", "color.ui=never"] as const;

function aborted(deps: RelatedDeps): boolean {
  return deps.signal?.aborted === true;
}

/** Per-request octokit option carrying the signal. */
function req(deps: RelatedDeps): { request?: { signal: AbortSignal } } {
  return deps.signal !== undefined ? { request: { signal: deps.signal } } : {};
}

/**
 * Settles with `work`, or rejects once `signal` aborts, even if the underlying call ignores the
 * signal (an injected runner, say). The call itself is cancelled through the signal it was given.
 */
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  work.catch(() => undefined);
  if (signal.aborted) throw new Error("related: aborted");
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new Error("related: aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stop]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function runGit(deps: RelatedDeps, args: readonly string[]): Promise<GitResult> {
  // Spent budget: start no git process at all.
  if (aborted(deps)) return Promise.reject(new Error("related: aborted"));
  return untilAbort(deps.git(args, deps.signal !== undefined ? { signal: deps.signal } : undefined), deps.signal);
}

function sameRepo(a: string | undefined, repo: RepoRef): boolean {
  return a !== undefined && a.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();
}

function cut(body: string | null | undefined): string {
  return (body ?? "").slice(0, CANDIDATE_BODY_CHARS);
}

/** Literal pathspecs: a PR path is never a glob or a pathspec magic. */
function pathspecs(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_LOG_PATHS).filter((p) => p !== "" && !p.includes("\0")).map((p) => `:(literal)${p}`);
}

async function searchIssues(input: RelatedInput, deps: RelatedDeps): Promise<RelatedCandidate[] | null> {
  const q = issueQuery(input.repo.owner, input.repo.repo, input.title, input.symbols);
  if (q === null) return [];
  if (aborted(deps) || !(deps.budget ?? searchBudget).tryTake()) return null;
  try {
    const res = await untilAbort(
      deps.github.rest.search.issuesAndPullRequests({ q, per_page: MAX_CANDIDATES_PER_KIND, ...req(deps) }),
      deps.signal,
    );
    const suffix = `/repos/${input.repo.owner}/${input.repo.repo}`.toLowerCase();
    const out: RelatedCandidate[] = [];
    for (const it of res.data.items) {
      // The App may be installed on several repos: keep this repo's issues only.
      if (!it.repository_url.toLowerCase().endsWith(suffix)) continue;
      if (it.pull_request || it.number === input.prNumber) continue;
      out.push({ number: it.number, kind: "issue", title: it.title, body: cut(it.body) });
      if (out.length >= MAX_CANDIDATES_PER_KIND) break;
    }
    return out;
  } catch {
    return null;
  }
}

async function logShas(deps: RelatedDeps, args: readonly string[]): Promise<string[]> {
  const r = await runGit(deps, [...LOG_CONFIG, "log", ...args]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
}

async function findPrs(input: RelatedInput, deps: RelatedDeps): Promise<RelatedCandidate[]> {
  const specs = pathspecs(input.paths);
  if (specs.length === 0) return [];
  const shas = await logShas(deps, ["--format=%H", "-n", String(MAX_LOG_COMMITS), input.baseSha, "--", ...specs]);
  const out: RelatedCandidate[] = [];
  const seen = new Set<number>();
  for (const sha of shas) {
    if (out.length >= MAX_CANDIDATES_PER_KIND || aborted(deps)) break;
    let pulls;
    try {
      pulls = (
        await untilAbort(
          deps.github.rest.repos.listPullRequestsAssociatedWithCommit({ ...input.repo, commit_sha: sha, ...req(deps) }),
          deps.signal,
        )
      ).data;
    } catch {
      continue;
    }
    for (const p of pulls) {
      if (p.merged_at === null || p.number === input.prNumber || seen.has(p.number)) continue;
      if (!sameRepo(p.base.repo.full_name, input.repo)) continue;
      seen.add(p.number);
      out.push({ number: p.number, kind: "pr", title: p.title, body: cut(p.body) });
      if (out.length >= MAX_CANDIDATES_PER_KIND) break;
    }
  }
  return out;
}

/** §4.6 candidates. Never throws. */
export async function findCandidates(input: RelatedInput, deps: RelatedDeps): Promise<CandidatesResult> {
  try {
    assertSha(input.baseSha, "base");
  } catch {
    return { candidates: [], unavailable: true };
  }
  // An abort keeps what was found so far; findPrs stops between requests.
  const [issues, prs] = await Promise.all([
    searchIssues(input, deps),
    findPrs(input, deps).catch(() => [] as RelatedCandidate[]),
  ]);
  return { candidates: [...(issues ?? []), ...prs], unavailable: issues === null && prs.length === 0 };
}

function isBot(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

/**
 * §4.7 suggested reviewers. Never throws; an empty list on any failure. When `deps.signal` aborts
 * during the recent-authors step, the CODEOWNERS pick (step 1) is returned as a partial result.
 */
export async function suggestReviewers(input: RelatedInput, deps: RelatedDeps): Promise<SuggestedReviewer[]> {
  try {
    assertSha(input.baseSha, "base");
  } catch {
    return [];
  }
  const author = input.prAuthor.toLowerCase();
  const out: SuggestedReviewer[] = [];
  const taken = new Set<string>();
  const add = (login: string, reason: SuggestedReviewer["reason"]): boolean => {
    const k = login.toLowerCase();
    if (k === author || isBot(login) || taken.has(k)) return false;
    taken.add(k);
    out.push({ login, reason });
    return true;
  };

  // 1. CODEOWNERS at base. The tree listing and the blob read go through runGit too, so an abort
  // kills them and a hanging read never holds the result.
  try {
    const base = await listTree((args) => runGit(deps, args), input.baseSha);
    const rules = await loadCodeowners(base);
    let n = 0;
    for (const p of input.paths) {
      for (const o of ownersOf(rules, p)) {
        if (n >= MAX_CODEOWNERS_REVIEWERS) break;
        if (add(o, "codeowners")) n++;
      }
    }
  } catch {
    // No CODEOWNERS suggestions.
  }

  // 2. Top recent authors of the changed files.
  try {
    const specs = pathspecs(input.paths);
    if (specs.length === 0 || aborted(deps)) return out;
    const t = await runGit(deps, [...LOG_CONFIG, "show", "-s", "--format=%ct", input.baseSha]);
    const baseTime = Number(t.stdout.trim());
    if (t.code !== 0 || !Number.isFinite(baseTime)) return out;
    const since = new Date(baseTime * 1000 - YEAR_MS).toISOString();
    const r = await runGit(deps, [
      ...LOG_CONFIG, "log", "--no-merges", "-n", "500", `--since=${since}`, "--format=%H%x00%aE", input.baseSha, "--", ...specs,
    ]);
    if (r.code !== 0) return out;
    const byEmail = new Map<string, { count: number; sha: string; first: number }>();
    for (const [i, line] of r.stdout.split("\n").entries()) {
      const [sha, email] = line.split("\0");
      if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !email) continue;
      const k = email.toLowerCase();
      const e = byEmail.get(k);
      if (e) e.count++;
      else byEmail.set(k, { count: 1, sha, first: i });
    }
    const ranked = [...byEmail.values()].sort((a, b) => b.count - a.count || a.first - b.first);
    let n = 0;
    for (const e of ranked) {
      if (n >= MAX_RECENT_AUTHORS || aborted(deps)) break;
      let login: string | undefined;
      let type: string | undefined;
      try {
        const c = (await untilAbort(deps.github.rest.repos.getCommit({ ...input.repo, ref: e.sha, ...req(deps) }), deps.signal)).data;
        login = c.author?.login;
        type = c.author?.type;
      } catch {
        continue;
      }
      if (!login || type === "Bot") continue;
      if (add(login, "recent_changes")) n++;
    }
  } catch {
    // No recent-change suggestions.
  }
  return out;
}

// Local git access through an injected runner (design §8.2). The checkout is full history
// (`fetch-depth: 0`), so diffs never depend on the API's truncated `/pulls/{n}/files` patches.

import { spawn } from "node:child_process";

import { redact } from "../env.js";
import { parseUnifiedDiff, type DiffFile } from "./diff.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Aborting kills the git process (SIGKILL) and rejects with a GitError. */
  signal?: AbortSignal;
}

/** Runs `git <args>` in the checkout. Must not use a shell. */
export type GitRunner = (args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;

export class GitError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

const SHA = /^[0-9a-f]{40}$/;

/** Throws unless `sha` is a full lowercase 40-hex commit id (also keeps option-looking args out of git). */
export function assertSha(sha: string, what = "sha"): void {
  if (!SHA.test(sha)) throw new GitError(`invalid ${what}: expected 40 hex chars`, -1);
}

export function isSha(sha: unknown): sha is string {
  return typeof sha === "string" && SHA.test(sha);
}

/**
 * Pin every setting that changes `git diff` output, so the parser sees one stable format no matter
 * what the checkout's config says.
 */
const CONFIG_ARGS = [
  "-c", "core.quotePath=true",
  "-c", "color.ui=never",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.interHunkContext=0",
] as const;

const DIFF_ARGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames",
  "--diff-algorithm=myers",
  "--unified=3",
] as const;

export interface NodeGitRunnerOptions {
  /** Max stdout bytes before the process is killed (default 256 MiB). */
  maxBuffer?: number;
  /** Override the environment (default: gitEnv()). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Minimal environment for git: no ACTIONS_* / GITHUB_* / runner credentials, and no inherited GIT_*
 * (GIT_DIR, GIT_CONFIG_*, …) that would change behaviour. System and global config are ignored, and
 * HOME is unset, so only the checkout's own config (overridden by CONFIG_ARGS) applies.
 */
export function gitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/** Real runner: spawns `git` in `cwd`, no shell, non-interactive, minimal env. */
export function createGitRunner(cwd: string, options: NodeGitRunnerOptions = {}): GitRunner {
  const maxBuffer = options.maxBuffer ?? 256 * 1024 * 1024;
  const env = options.env ?? gitEnv();
  return (args, runOptions = {}) =>
    new Promise<GitResult>((resolve, reject) => {
      const { signal } = runOptions;
      if (signal?.aborted === true) {
        reject(new GitError("git aborted", -1));
        return;
      }
      const child = spawn("git", [...args], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(signal !== undefined ? { signal, killSignal: "SIGKILL" as const } : {}),
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBuffer) {
          child.kill("SIGKILL");
          reject(new GitError("git output exceeded the buffer limit", -1));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (err.length < 64) err.push(chunk);
      });
      child.on("error", (e) => {
        // Node kills the child on abort and reports it as an AbortError.
        if (e.name === "AbortError") reject(new GitError("git aborted", -1));
        else reject(new GitError(`cannot run git: ${redact(e.message)}`, -1));
      });
      child.on("close", (code) => {
        if (signal?.aborted === true) {
          reject(new GitError("git aborted", -1));
          return;
        }
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
}

async function run(git: GitRunner, args: readonly string[], what: string): Promise<string> {
  const r = await git([...CONFIG_ARGS, ...args]);
  if (r.code !== 0) {
    const first = redact(r.stderr.split("\n")[0] ?? "").slice(0, 200);
    throw new GitError(`git ${what} failed (exit ${r.code})${first ? `: ${first}` : ""}`, r.code);
  }
  return r.stdout;
}

/** The checked-out HEAD commit. */
export async function headSha(git: GitRunner): Promise<string> {
  const sha = (await run(git, ["rev-parse", "--verify", "HEAD^{commit}"], "rev-parse")).trim();
  assertSha(sha, "HEAD");
  return sha;
}

/** True when `sha` names a commit present in the checkout. */
export async function commitExists(git: GitRunner, sha: string): Promise<boolean> {
  assertSha(sha);
  const r = await git([...CONFIG_ARGS, "cat-file", "-e", `${sha}^{commit}`]);
  return r.code === 0;
}

/**
 * `git merge-base --is-ancestor`. A commit missing from the checkout (force-pushed away) is not an
 * ancestor; any other failure throws.
 */
export async function isAncestor(git: GitRunner, ancestor: string, descendant: string): Promise<boolean> {
  assertSha(ancestor, "ancestor");
  assertSha(descendant, "descendant");
  if (!(await commitExists(git, ancestor))) return false;
  const r = await git([...CONFIG_ARGS, "merge-base", "--is-ancestor", ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new GitError(`git merge-base --is-ancestor failed (exit ${r.code})`, r.code);
}

export interface GitDiff {
  /** Revision range as shown to humans: `base...head` or `last..head`. */
  range: string;
  files: DiffFile[];
  /** Raw diff text. */
  text: string;
}

/**
 * `git diff` reads `.gitattributes` from the working tree, which is the untrusted PR head. A PR that
 * adds `*.ts -diff` or `binary` would turn its own changes into "Binary files differ", and binary
 * files are not counted as unreviewed (§7.5). `--attr-source=<base>` (git >= 2.40) makes git use only
 * the trusted base commit's attributes.
 */
function attrSourceArg(baseSha: string): string {
  assertSha(baseSha, "attr source");
  return `--attr-source=${baseSha}`;
}

/** Full review and anchor map: `git diff --merge-base <base> <head>` (GitHub's PR diff). */
export async function mergeBaseDiff(git: GitRunner, base: string, head: string): Promise<GitDiff> {
  assertSha(base, "base");
  assertSha(head, "head");
  const text = await run(
    git,
    [attrSourceArg(base), "diff", ...DIFF_ARGS, "--merge-base", base, head, "--"],
    "diff --merge-base",
  );
  return { range: `${base}...${head}`, files: parseUnifiedDiff(text), text };
}

/**
 * Incremental review target: `git diff <last> <head>`. `prBase` is the PR's base SHA (not `last`,
 * which is PR code): its `.gitattributes` are the only ones applied.
 */
export async function incrementalDiff(git: GitRunner, last: string, head: string, prBase: string): Promise<GitDiff> {
  assertSha(last, "last");
  assertSha(head, "head");
  const text = await run(git, [attrSourceArg(prBase), "diff", ...DIFF_ARGS, last, head, "--"], "diff");
  return { range: `${last}..${head}`, files: parseUnifiedDiff(text), text };
}

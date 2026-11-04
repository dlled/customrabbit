import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitRunner, type GitRunner } from "../../src/github/git.js";
import { ownersOf, parseCodeowners } from "../../src/related/codeowners.js";
import {
  findCandidates,
  SearchBudget,
  suggestReviewers,
  type RelatedDeps,
  type RelatedInput,
} from "../../src/related/index.js";
import { issueQuery, MAX_QUERY_CHARS, safeTokens, titleKeywords } from "../../src/related/keywords.js";
import { REPO, testClient } from "../github/helpers.js";

// ---------------------------------------------------------------------------------------------
// Temp repo with per-commit authors and dates.

interface Commit {
  files: Record<string, string>;
  email: string;
  /** ISO date. */
  date: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function history(commits: Commit[]): { dir: string; git: GitRunner; head: string; shas: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "myrabbit-rel-"));
  dirs.push(dir);
  const sh = (env: Record<string, string>, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    }).trim();
  sh({}, "init", "-q", "-b", "main");
  const shas: string[] = [];
  for (const c of commits) {
    for (const [p, text] of Object.entries(c.files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    sh({}, "add", "-A");
    const env = {
      GIT_AUTHOR_NAME: c.email.split("@")[0] ?? "x",
      GIT_AUTHOR_EMAIL: c.email,
      GIT_AUTHOR_DATE: c.date,
      GIT_COMMITTER_NAME: "c",
      GIT_COMMITTER_EMAIL: "c@example.invalid",
      GIT_COMMITTER_DATE: c.date,
    };
    sh(env, "commit", "-q", "--allow-empty", "-m", `c${shas.length}`);
    shas.push(sh({}, "rev-parse", "HEAD"));
  }
  return { dir, git: createGitRunner(dir), head: shas.at(-1) ?? "", shas };
}

function input(overrides: Partial<RelatedInput> = {}): RelatedInput {
  return {
    repo: REPO,
    baseSha: "b".repeat(40),
    prNumber: 42,
    prAuthor: "alice",
    title: "fix: Retry webhook delivery on timeout",
    paths: ["src/webhook.ts"],
    symbols: ["deliverWebhook"],
    ...overrides,
  };
}

const issue = (n: number, repoUrl = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`, extra: object = {}) => ({
  number: n,
  title: `issue ${n}`,
  body: "x".repeat(900),
  repository_url: repoUrl,
  ...extra,
});

// ---------------------------------------------------------------------------------------------

describe("keywords", () => {
  it("keeps only [A-Za-z0-9_]{2,40} tokens; every ':' and quote is a separator", () => {
    expect(safeTokens('repo:evil/x is:pr "a" b OR label:x ' + "y".repeat(41))).toEqual(["repo", "evil", "is", "pr", "OR", "label"]);
    expect(safeTokens("a:b")).toEqual([]);
  });

  it("picks the most distinctive title tokens", () => {
    expect(titleKeywords("fix(api): Retry webhook delivery on timeout for #123")).toEqual(["delivery", "webhook", "timeout", "Retry", "api"]);
  });

  it("builds a repo-scoped, quoted OR query within GitHub's limits", () => {
    const q = issueQuery("acme", "widgets", 'feat: repo:other/secret "quoted" in:body webhook', ["deliverWebhook", "bad:name", "x"]);
    expect(q).toBe('repo:acme/widgets is:issue ("webhook" OR "secret" OR "quoted" OR "other" OR "repo" OR "deliverWebhook")');
    // The title's qualifiers end up as plain quoted words, never as qualifiers.
    expect(q?.match(/\w+:/g)).toEqual(["repo:", "is:"]);
    expect((q?.match(/ OR /g) ?? []).length).toBeLessThanOrEqual(5);
    const long = issueQuery("acme", "widgets", Array.from({ length: 10 }, (_, i) => `${"w".repeat(38)}${i}`).join(" "), []);
    expect(long?.length ?? 0).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(issueQuery("acme", "widgets", "fix: the", [])).toBeNull();
  });
});

describe("SearchBudget", () => {
  it("allows 30 per sliding minute", () => {
    let t = 0;
    const b = new SearchBudget(30, 60_000, () => t);
    for (let i = 0; i < 30; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t = 60_000;
    expect(b.tryTake()).toBe(true);
  });
});

describe("findCandidates", () => {
  it("searches once, post-filters to this repo, and maps merged PRs from git log", async () => {
    const repo = history([
      { files: { "src/webhook.ts": "a\n" }, email: "bob@example.invalid", date: "2026-01-01T00:00:00Z" },
      { files: { "src/webhook.ts": "b\n" }, email: "bob@example.invalid", date: "2026-02-01T00:00:00Z" },
      { files: { "README.md": "r\n" }, email: "bob@example.invalid", date: "2026-03-01T00:00:00Z" },
    ]);
    const { gh, server } = testClient();
    server.on("GET", "/search/issues", {
      body: {
        items: [
          issue(1),
          issue(2, "https://api.github.com/repos/acme/other"), // another repo of the installation
          issue(3, undefined, { pull_request: {} }),
          issue(42), // the PR itself
        ],
      },
    });
    server.on("GET", /\/commits\/[0-9a-f]{40}\/pulls$/, (call) => {
      const sha = call.path.split("/").at(-2);
      if (sha === repo.shas[1]) {
        return {
          body: [
            { number: 10, title: "pr 10", body: null, merged_at: "2026-02-02T00:00:00Z", base: { repo: { full_name: "acme/widgets" } } },
            { number: 11, title: "open", body: "", merged_at: null, base: { repo: { full_name: "acme/widgets" } } },
            { number: 12, title: "fork base", body: "", merged_at: "2026-02-02T00:00:00Z", base: { repo: { full_name: "evil/widgets" } } },
          ],
        };
      }
      return { body: [{ number: 10, title: "pr 10", body: null, merged_at: "2026-02-02T00:00:00Z", base: { repo: { full_name: "acme/widgets" } } }] };
    });
    const deps: RelatedDeps = { github: gh, git: repo.git, budget: new SearchBudget() };
    const res = await findCandidates(input({ baseSha: repo.head }), deps);
    expect(res.unavailable).toBe(false);
    expect(res.candidates.map((c) => [c.kind, c.number])).toEqual([["issue", 1], ["pr", 10]]);
    expect(res.candidates[0]?.body).toHaveLength(500);
    const searches = server.calls.filter((c) => c.path === "/search/issues");
    expect(searches).toHaveLength(1);
    expect(searches[0]?.query.get("q")).toBe('repo:acme/widgets is:issue ("delivery" OR "webhook" OR "timeout" OR "Retry" OR "deliverWebhook")');
    expect(searches[0]?.query.get("per_page")).toBe("10");
    // README-only commit is not a candidate source.
    expect(server.calls.some((c) => c.path.includes(repo.shas[2] ?? "-"))).toBe(false);
  });

  it("a search failure without PR candidates is 'unavailable'; never throws", async () => {
    const repo = history([{ files: { "a.ts": "a\n" }, email: "bob@example.invalid", date: "2026-01-01T00:00:00Z" }]);
    const { gh, server } = testClient();
    server.on("GET", "/search/issues", { status: 500, body: { message: "boom" } });
    server.on("GET", /\/pulls$/, { body: [] });
    const res = await findCandidates(input({ baseSha: repo.head, paths: ["a.ts"] }), { github: gh, git: repo.git, budget: new SearchBudget() });
    expect(res).toEqual({ candidates: [], unavailable: true });
  });

  it("an exhausted search budget skips the search", async () => {
    const repo = history([{ files: { "a.ts": "a\n" }, email: "bob@example.invalid", date: "2026-01-01T00:00:00Z" }]);
    const { gh, server } = testClient();
    server.on("GET", /\/pulls$/, { body: [] });
    const budget = new SearchBudget(0);
    const res = await findCandidates(input({ baseSha: repo.head, paths: ["a.ts"] }), { github: gh, git: repo.git, budget });
    expect(res.unavailable).toBe(true);
    expect(server.calls.some((c) => c.path === "/search/issues")).toBe(false);
  });

  it("passes PR paths to git as literal pathspecs", async () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const { gh, server } = testClient();
    server.on("GET", "/search/issues", { body: { items: [] } });
    await findCandidates(input({ paths: ["*", ":(glob)**", "-n"] }), { github: gh, git, budget: new SearchBudget() });
    const log = calls.find((a) => a.includes("log"));
    expect(log?.slice(log.indexOf("--") + 1)).toEqual([":(literal)*", ":(literal):(glob)**", ":(literal)-n"]);
  });
});

describe("CODEOWNERS", () => {
  const rules = parseCodeowners(`
# comment
*            @org/everyone
*.js         @js-owner
/docs/*      @docs-owner     # trailing comment
apps/        @apps-owner
/build/logs/ @logs-owner
src/api/**   @api-owner foo@example.invalid
!negated     @nobody
src/empty
`);
  it("last matching rule wins, GitHub's gitignore subset", () => {
    expect(ownersOf(rules, "README.md")).toEqual(["org/everyone"]);
    expect(ownersOf(rules, "lib/x.js")).toEqual(["js-owner"]);
    expect(ownersOf(rules, "docs/a.md")).toEqual(["docs-owner"]);
    expect(ownersOf(rules, "docs/sub/b.md")).toEqual(["org/everyone"]);
    expect(ownersOf(rules, "x/apps/y.ts")).toEqual(["apps-owner"]);
    expect(ownersOf(rules, "build/logs/a.log")).toEqual(["logs-owner"]);
    expect(ownersOf(rules, "src/api/v1/h.ts")).toEqual(["api-owner"]);
    expect(ownersOf(rules, "src/empty/x.ts")).toEqual([]);
  });
});

describe("suggestReviewers", () => {
  const old = "2024-01-01T00:00:00Z";
  it("CODEOWNERS at base first, then the top recent authors mapped to logins", async () => {
    const repo = history([
      { files: { ".github/CODEOWNERS": "src/** @carol @alice @team-bot[bot]\n" }, email: "x@example.invalid", date: old },
      { files: { "src/webhook.ts": "1\n" }, email: "old@example.invalid", date: old },
      { files: { "src/webhook.ts": "2\n" }, email: "dave@example.invalid", date: "2026-05-01T00:00:00Z" },
      { files: { "src/webhook.ts": "3\n" }, email: "dave@example.invalid", date: "2026-06-01T00:00:00Z" },
      { files: { "src/webhook.ts": "4\n" }, email: "erin@example.invalid", date: "2026-07-01T00:00:00Z" },
      { files: { "src/webhook.ts": "5\n" }, email: "alice@example.invalid", date: "2026-08-01T00:00:00Z" },
      { files: { "src/webhook.ts": "6\n" }, email: "bot@example.invalid", date: "2026-09-01T00:00:00Z" },
      { files: { "src/webhook.ts": "7\n" }, email: "ghost@example.invalid", date: "2026-09-02T00:00:00Z" },
    ]);
    const loginBySha: Record<string, { login: string; type: string } | null> = {
      [repo.shas[3] ?? ""]: { login: "dave", type: "User" },
      [repo.shas[4] ?? ""]: { login: "erin", type: "User" },
      [repo.shas[5] ?? ""]: { login: "Alice", type: "User" },
      [repo.shas[6] ?? ""]: { login: "renovate", type: "Bot" },
      [repo.shas[7] ?? ""]: null,
    };
    const { gh, server } = testClient();
    server.on("GET", /\/repos\/acme\/widgets\/commits\/[0-9a-f]{40}$/, (call) => ({
      body: { author: loginBySha[call.path.split("/").at(-1) ?? ""] ?? null },
    }));
    const got = await suggestReviewers(input({ baseSha: repo.head }), { github: gh, git: repo.git });
    expect(got).toEqual([
      { login: "carol", reason: "codeowners" },
      { login: "dave", reason: "recent_changes" },
      { login: "erin", reason: "recent_changes" },
    ]);
    // old@ is outside the 12 months before the base commit: never looked up.
    expect(server.calls.some((c) => c.path.endsWith(repo.shas[1] ?? "-"))).toBe(false);
  });

  it("reads CODEOWNERS only as a regular blob at base (a symlink is ignored)", async () => {
    const repo = history([{ files: { "src/a.ts": "a\n" }, email: "x@example.invalid", date: "2026-01-01T00:00:00Z" }]);
    const secretDir = mkdtempSync(join(tmpdir(), "myrabbit-rel-secret-"));
    dirs.push(secretDir);
    writeFileSync(join(secretDir, "owners"), "* @leaked-owner\n");
    execFileSync("ln", ["-s", join(secretDir, "owners"), join(repo.dir, "CODEOWNERS")]);
    execFileSync("git", ["add", "-A"], { cwd: repo.dir });
    execFileSync("git", ["-c", "user.email=x@example.invalid", "-c", "user.name=x", "commit", "-q", "-m", "link"], { cwd: repo.dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    const { gh, server } = testClient();
    server.on("GET", /\/commits\/[0-9a-f]{40}$/, { body: { author: null } });
    const got = await suggestReviewers(input({ baseSha: head, paths: ["src/a.ts"] }), { github: gh, git: repo.git });
    expect(got).toEqual([]);
  });

  it("returns [] on a bad base SHA or git failure", async () => {
    const { gh } = testClient();
    const git: GitRunner = () => Promise.reject(new Error("no git"));
    expect(await suggestReviewers(input({ baseSha: "not-a-sha" }), { github: gh, git })).toEqual([]);
    expect(await suggestReviewers(input(), { github: gh, git })).toEqual([]);
  });
});

describe("abort (deps.signal)", () => {
  const old = "2024-01-01T00:00:00Z";
  const ownedRepo = () =>
    history([
      { files: { ".github/CODEOWNERS": "src/** @carol\n" }, email: "x@example.invalid", date: old },
      { files: { "src/webhook.ts": "1\n" }, email: "dave@example.invalid", date: "2026-05-01T00:00:00Z" },
      { files: { "src/webhook.ts": "2\n" }, email: "erin@example.invalid", date: "2026-06-01T00:00:00Z" },
    ]);

  /** Wraps the fake server: matching requests hang until their signal aborts (a slow API). */
  function hangOn(pattern: RegExp, opts: Parameters<typeof testClient>[0] = {}) {
    const base = testClient(opts);
    const hung: (AbortSignal | null | undefined)[] = [];
    // Each waiter resolves once `n` requests hang: no fixed sleep that load can outrun.
    const waiters: { n: number; resolve: () => void }[] = [];
    const hangingCount = (n: number) =>
      new Promise<void>((resolve) => {
        if (hung.length >= n) resolve();
        else waiters.push({ n, resolve });
      });
    const hanging = hangingCount(1);
    const fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (!pattern.test(path)) return base.server.fetch(url, init);
      hung.push(init?.signal);
      for (const w of waiters) if (hung.length >= w.n) w.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    const { gh } = testClient({ ...opts, fetch });
    return { gh, server: base.server, hung, hanging, hangingCount };
  }

  it("an abort mid-request stops the candidate search and still resolves", async () => {
    const repo = ownedRepo();
    const { gh, hung, hangingCount } = hangOn(/^\/search\/issues$|\/pulls$/);
    const ac = new AbortController();
    // A git slower than the search, as under load: the abort must still wait for both requests.
    const slowGit: typeof repo.git = (a, o) => new Promise<void>((r) => setTimeout(r, 50)).then(() => repo.git(a, o));
    const p = findCandidates(input({ baseSha: repo.head }), { github: gh, git: slowGit, budget: new SearchBudget(), signal: ac.signal });
    // Both in flight: the search, and findPrs's first commit lookup, which waits for `git log`
    // (a fixed 20 ms sleep lost that race under load and aborted before it).
    await hangingCount(2);
    ac.abort();
    expect(await p).toEqual({ candidates: [], unavailable: true });
    // The search plus one commit lookup: findPrs stopped at the abort instead of trying the next commit.
    expect(hung).toHaveLength(2);
    // Every hung request carried the signal, so the fetch itself was cancelled.
    expect(hung.every((s) => s?.aborted === true)).toBe(true);
  });

  it("an abort mid rate-limit sleep returns without retrying", async () => {
    const repo = ownedRepo();
    let sleeping: (() => void) | undefined;
    const asleep = new Promise<void>((r) => (sleeping = r));
    const { gh, server } = testClient({
      sleep: () => {
        sleeping?.();
        return new Promise<void>(() => undefined); // only the abort ends this wait
      },
    });
    server.on("GET", "/search/issues", { status: 403, headers: { "retry-after": "60" }, body: { message: "secondary rate limit" } });
    server.on("GET", /\/pulls$/, { body: [] });
    const ac = new AbortController();
    const p = findCandidates(input({ baseSha: repo.head, paths: ["src/webhook.ts"] }), {
      github: gh,
      git: repo.git,
      budget: new SearchBudget(),
      signal: ac.signal,
    });
    await asleep;
    ac.abort();
    const res = await p;
    expect(res.unavailable).toBe(true);
    expect(server.calls.filter((c) => c.path === "/search/issues")).toHaveLength(1);
  });

  it("suggestReviewers keeps the CODEOWNERS pick when the budget runs out mid-request", async () => {
    const repo = ownedRepo();
    const { gh, hung, hanging } = hangOn(/\/repos\/acme\/widgets\/commits\/[0-9a-f]{40}$/);
    const ac = new AbortController();
    const p = suggestReviewers(input({ baseSha: repo.head }), { github: gh, git: repo.git, signal: ac.signal });
    await hanging;
    ac.abort();
    expect(await p).toEqual([{ login: "carol", reason: "codeowners" }]);
    // The loop stopped: the second author was never looked up.
    expect(hung).toHaveLength(1);
    expect(hung[0]?.aborted).toBe(true);
  });

  it("an abort during git log kills it and keeps the CODEOWNERS pick", async () => {
    const repo = ownedRepo();
    const { gh, server } = testClient();
    const seen: (AbortSignal | undefined)[] = [];
    let inLog: (() => void) | undefined;
    const logging = new Promise<void>((r) => (inLog = r));
    const git: GitRunner = (args, options) => {
      if (!args.includes("log")) return repo.git(args, options);
      seen.push(options?.signal);
      inLog?.();
      // A runner that honours the signal, like createGitRunner (which SIGKILLs git).
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("git aborted"));
        });
      });
    };
    const ac = new AbortController();
    const p = suggestReviewers(input({ baseSha: repo.head }), { github: gh, git, signal: ac.signal });
    await logging;
    ac.abort();
    expect(await p).toEqual([{ login: "carol", reason: "codeowners" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    expect(server.calls).toHaveLength(0);
  });

  it("returns promptly even if the git runner ignores the signal", async () => {
    const repo = ownedRepo();
    const { gh } = testClient();
    const git: GitRunner = (args, options) =>
      args.includes("log") ? new Promise(() => undefined) : repo.git(args, options);
    const ac = new AbortController();
    const p = findCandidates(input({ baseSha: repo.head, title: "", symbols: [] }), { github: gh, git, signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 20);
    expect(await p).toEqual({ candidates: [], unavailable: false });
  });

  it("an already aborted signal runs no git and makes no request", async () => {
    const repo = ownedRepo();
    const { gh, server } = testClient();
    const ac = new AbortController();
    ac.abort();
    const calls: string[][] = [];
    const git: GitRunner = (args, options) => {
      calls.push([...args]);
      return repo.git(args, options);
    };
    const got = await suggestReviewers(input({ baseSha: repo.head }), { github: gh, git, signal: ac.signal });
    expect(got).toEqual([]);
    const res = await findCandidates(input({ baseSha: repo.head }), { github: gh, git, budget: new SearchBudget(), signal: ac.signal });
    // A spent budget starts no git process at all (runGit refuses before calling the runner).
    expect(calls).toEqual([]);
    expect(res).toEqual({ candidates: [], unavailable: true });
    expect(server.calls).toHaveLength(0);
  });

  it("a hanging CODEOWNERS read is cut by the abort", async () => {
    const repo = ownedRepo();
    for (const step of ["ls-tree", "cat-file"]) {
      for (const honours of [true, false]) {
        const { gh, server } = testClient();
        const seen: (AbortSignal | undefined)[] = [];
        let reached: (() => void) | undefined;
        const hanging = new Promise<void>((r) => (reached = r));
        const git: GitRunner = (args, options) => {
          if (!args.includes(step)) return repo.git(args, options);
          seen.push(options?.signal);
          reached?.();
          // Either a runner that honours the signal (like createGitRunner) or one that ignores it.
          return new Promise((_resolve, reject) => {
            if (honours) options?.signal?.addEventListener("abort", () => {
              reject(new Error("git aborted"));
            });
          });
        };
        const ac = new AbortController();
        const p = suggestReviewers(input({ baseSha: repo.head }), { github: gh, git, signal: ac.signal });
        await hanging;
        ac.abort();
        expect(await p, `${step} honours=${String(honours)}`).toEqual([]);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.aborted).toBe(true);
        // Step 2 never started: no author lookups.
        expect(server.calls).toHaveLength(0);
      }
    }
  });

  it("a real git runner reads CODEOWNERS with the signal and still finds the owners", async () => {
    const repo = ownedRepo();
    const { gh, server } = testClient();
    server.on("GET", /\/commits\/[0-9a-f]{40}$/, { body: { author: null } });
    const signals: (AbortSignal | undefined)[] = [];
    const git: GitRunner = (args, options) => {
      signals.push(options?.signal);
      return repo.git(args, options);
    };
    const ac = new AbortController();
    const got = await suggestReviewers(input({ baseSha: repo.head }), { github: gh, git, signal: ac.signal });
    expect(got).toEqual([{ login: "carol", reason: "codeowners" }]);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s === ac.signal)).toBe(true);
  });

  it("without a signal nothing changes (no request option is added)", async () => {
    const repo = ownedRepo();
    const { gh, server } = testClient();
    server.on("GET", /\/commits\/[0-9a-f]{40}$/, (call) => ({
      body: { author: { login: call.path.endsWith(repo.shas[1] ?? "-") ? "dave" : "erin", type: "User" } },
    }));
    const got = await suggestReviewers(input({ baseSha: repo.head }), { github: gh, git: repo.git });
    expect(got.map((r) => r.login)).toEqual(["carol", "erin", "dave"]);
  });
});

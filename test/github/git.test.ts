import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AnchorMap } from "../../src/github/diff.js";
import {
  GitError,
  assertSha,
  createGitRunner,
  gitEnv,
  headSha,
  incrementalDiff,
  isAncestor,
  mergeBaseDiff,
  type GitResult,
  type GitRunner,
} from "../../src/github/git.js";
import { BASE, HEAD, OLD } from "./helpers.js";

function fakeRunner(reply: (args: readonly string[]) => Partial<GitResult>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    const r = reply(args);
    return Promise.resolve({ code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  };
  return { git, calls };
}

/** Drop the pinned `-c k=v` config pairs. */
const cmd = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else out.push(args[i] ?? "");
  }
  return out;
};

describe("git commands through the injected runner", () => {
  it("merge-base diff uses --merge-base base head and pinned flags", async () => {
    const { git, calls } = fakeRunner(() => ({ stdout: "" }));
    const d = await mergeBaseDiff(git, BASE, HEAD);
    expect(d).toEqual({ range: `${BASE}...${HEAD}`, files: [], text: "" });
    const args = calls[0] ?? [];
    expect(args).toContain("core.quotePath=true");
    expect(cmd(args)).toEqual([
      `--attr-source=${BASE}`,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames",
      "--diff-algorithm=myers",
      "--unified=3",
      "--merge-base",
      BASE,
      HEAD,
      "--",
    ]);
  });

  it("incremental diff is last..head, with the PR base's attributes", async () => {
    const { git, calls } = fakeRunner(() => ({ stdout: "" }));
    const d = await incrementalDiff(git, OLD, HEAD, BASE);
    expect(d.range).toBe(`${OLD}..${HEAD}`);
    expect(cmd(calls[0] ?? [])[0]).toBe(`--attr-source=${BASE}`);
    expect(cmd(calls[0] ?? []).slice(-3)).toEqual([OLD, HEAD, "--"]);
  });

  it("refuses anything that is not a 40-hex sha (no option injection)", async () => {
    const { git, calls } = fakeRunner(() => ({}));
    await expect(mergeBaseDiff(git, "--output=/tmp/x", HEAD)).rejects.toThrow(GitError);
    await expect(incrementalDiff(git, OLD, "HEAD", BASE)).rejects.toThrow(/invalid head/);
    await expect(incrementalDiff(git, OLD, HEAD, "HEAD~1")).rejects.toThrow(/invalid attr source/);
    expect(calls).toHaveLength(0);
    expect(() => {
      assertSha("A".repeat(40));
    }).toThrow(GitError);
  });

  it("isAncestor maps exit codes; a missing commit is not an ancestor", async () => {
    const run = (isAnc: number, exists = 0) =>
      fakeRunner((args) => ({ code: args.includes("cat-file") ? exists : isAnc }));
    await expect(isAncestor(run(0).git, OLD, HEAD)).resolves.toBe(true);
    await expect(isAncestor(run(1).git, OLD, HEAD)).resolves.toBe(false);
    await expect(isAncestor(run(0, 128).git, OLD, HEAD)).resolves.toBe(false);
    await expect(isAncestor(run(128).git, OLD, HEAD)).rejects.toThrow(GitError);
  });

  it("failures carry the exit code and a redacted first stderr line", async () => {
    const { git } = fakeRunner(() => ({ code: 128, stderr: "fatal: bad object ghp_" + "x".repeat(30) + "\nmore" }));
    const err = await mergeBaseDiff(git, BASE, HEAD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe(128);
    expect((err as GitError).message).toContain("fatal: bad object");
    expect((err as GitError).message).not.toContain("ghp_x");
    expect((err as GitError).message).not.toContain("more");
  });

  it("headSha validates rev-parse output", async () => {
    await expect(headSha(fakeRunner(() => ({ stdout: `${HEAD}\n` })).git)).resolves.toBe(HEAD);
    await expect(headSha(fakeRunner(() => ({ stdout: "nope\n" })).git)).rejects.toThrow(GitError);
  });
});

describe("real git (temporary repository)", () => {
  let dir = "";
  let base = "";
  let mid = "";
  let head = "";
  let other = "";
  let hidden = "";
  const sh = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "myrabbit-git-"));
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "test@example.invalid");
    sh("config", "user.name", "test");
    // Hostile local config: must not change the parsed output.
    sh("config", "diff.noprefix", "true");
    sh("config", "color.ui", "always");
    sh("config", "core.quotePath", "false");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "base");
    base = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\n");
    sh("commit", "-q", "-am", "mid");
    mid = sh("rev-parse", "HEAD");
    writeFileSync(join(dir, "b ü.ts"), "new\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "head");
    head = sh("rev-parse", "HEAD");
    // main moves on after the branch point: the merge-base diff must ignore it.
    sh("checkout", "-q", "main");
    writeFileSync(join(dir, "main-only.ts"), "x\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "main moves");
    other = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "feature");
    // Hostile PR: its own .gitattributes tries to hide .ts changes as binary.
    writeFileSync(join(dir, ".gitattributes"), "*.ts -diff\n");
    writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\nevil()\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "hide");
    hidden = sh("rev-parse", "HEAD");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("merge-base diff shows only the PR's changes", async () => {
    const git = createGitRunner(dir);
    const d = await mergeBaseDiff(git, other, head);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ["a.ts", "modified"],
      ["b ü.ts", "added"],
    ]);
    const anchors = new AnchorMap(d.files);
    expect(anchors.has("a.ts", "RIGHT", 2)).toBe(true);
    expect(anchors.has("a.ts", "LEFT", 2)).toBe(true);
    expect(anchors.has("b ü.ts", "RIGHT", 1)).toBe(true);
  });

  it("incremental diff and ancestry", async () => {
    const git = createGitRunner(dir);
    const d = await incrementalDiff(git, mid, head, other);
    expect(d.files.map((f) => f.path)).toEqual(["b ü.ts"]);
    await expect(isAncestor(git, mid, head)).resolves.toBe(true);
    await expect(isAncestor(git, other, head)).resolves.toBe(false);
    await expect(isAncestor(git, "d".repeat(40), head)).resolves.toBe(false);
    await expect(headSha(git)).resolves.toBe(hidden);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a PR's .gitattributes cannot hide its changes as binary", async () => {
    // The attack is real without --attr-source: git reports the .ts change as binary.
    expect(sh("diff", "--no-ext-diff", "--merge-base", other, hidden, "--", "a.ts")).toContain("Binary files");

    const git = createGitRunner(dir);
    const full = await mergeBaseDiff(git, other, hidden);
    const a = full.files.find((f) => f.path === "a.ts");
    expect(a?.binary).toBe(false);
    expect(a?.hunks[0]?.lines.some((l) => l.kind === "add" && l.text === "evil()")).toBe(true);

    const inc = await incrementalDiff(git, head, hidden, other);
    const b = inc.files.find((f) => f.path === "a.ts");
    expect(b?.binary).toBe(false);
    expect(b?.additions).toBe(1);
  });

  it("runs git with a minimal env (no runner credentials, no inherited GIT_*)", () => {
    const env = gitEnv({ PATH: "/bin", GITHUB_TOKEN: "fake", ACTIONS_RUNTIME_TOKEN: "fake", GIT_DIR: "/elsewhere", HOME: "/home/x" });
    expect(env).toEqual({
      PATH: "/bin",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });
});

describe("real git runner abort", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** An alias that records git's pid (the shell's parent) and then outlives the test unless killed. */
  function slowGit(): { git: GitRunner; pidFile: string; args: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "myrabbit-abort-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const pidFile = join(dir, "git.pid");
    return { git: createGitRunner(dir), pidFile, args: ["-c", `alias.slow=!echo $PPID > ${pidFile}; sleep 5`, "slow"] };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills git (SIGKILL) when the signal aborts", async () => {
    const { git, pidFile, args } = slowGit();
    const ac = new AbortController();
    const started = Date.now();
    const p = git(args, { signal: ac.signal });
    p.catch(() => undefined);
    let pid = 0;
    for (let i = 0; i < 150 && pid === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      try {
        pid = Number(readFileSync(pidFile, "utf8").trim());
      } catch {
        // Not written yet.
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    ac.abort();
    await expect(p).rejects.toThrow("git aborted");
    await expect(p).rejects.toBeInstanceOf(GitError);
    expect(Date.now() - started).toBeLessThan(4000);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it("an already aborted signal never spawns git", async () => {
    const { git, pidFile, args } = slowGit();
    const ac = new AbortController();
    ac.abort();
    await expect(git(args, { signal: ac.signal })).rejects.toThrow("git aborted");
    await new Promise((r) => setTimeout(r, 100));
    expect(() => readFileSync(pidFile)).toThrow();
  });

  it("a signal that never aborts changes nothing", async () => {
    const { git } = slowGit();
    const r = await git(["rev-parse", "--is-inside-work-tree"], { signal: new AbortController().signal });
    expect(r).toMatchObject({ code: 0, stdout: "true\n" });
  });
});

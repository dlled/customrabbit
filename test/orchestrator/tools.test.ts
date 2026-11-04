// design-v2 §7 wiring (PW-P6): which tools to install, the diff-line predicates, the step's
// failure paths, the install child's env, and the tools-install entry's request handling.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DiffFile } from "../../src/github/diff.js";
import type { GitRunner } from "../../src/github/git.js";
import { parseInstallRequest, runToolsInstall } from "../../src/orchestrator/tools-install.js";
import { diffLines, realToolsDeps, staticAnalysisStep, toolsToRun, type ToolsDeps } from "../../src/orchestrator/tools.js";
import type { ToolsManifest } from "../../src/tools/install.js";
import { TOOL_NAMES, type ToolName, type ToolsConfig } from "../../src/types.js";

function config(on: ToolName[]): ToolsConfig {
  return {
    enabled: on.length > 0,
    ...(Object.fromEntries(TOOL_NAMES.map((t) => [t, { enabled: on.includes(t) }])) as Record<ToolName, { enabled: boolean }>),
  };
}

function file(path: string, lines: { kind: "add" | "ctx" | "del"; n: number }[]): DiffFile {
  return {
    path,
    oldPath: path,
    status: "modified",
    binary: false,
    hunks: [
      {
        index: 0,
        lines: lines.map((l) => ({ kind: l.kind, oldLine: l.kind === "add" ? null : l.n, newLine: l.kind === "del" ? null : l.n, text: "x" })),
      },
    ],
  } as unknown as DiffFile;
}

const logs: string[] = [];
const log = (m: string) => logs.push(m);

describe("toolsToRun", () => {
  it("keeps enabled tools that understand a path; gitleaks understands every path", () => {
    const all = config([...TOOL_NAMES]);
    expect(toolsToRun(all, ["src/app.ts"])).toEqual(["gitleaks"]);
    expect(toolsToRun(all, ["a.py", ".github/workflows/ci.yml"])).toEqual(expect.arrayContaining(["ruff", "actionlint", "zizmor", "yamllint", "gitleaks"]));
    expect(toolsToRun(all, ["scripts/deploy"])).toEqual(expect.arrayContaining(["shellcheck", "gitleaks"]));
    expect(toolsToRun(config(["ruff"]), ["src/app.ts"])).toEqual([]);
  });
});

describe("diffLines", () => {
  it("inDiff is added + context RIGHT lines, isAdded only added ones", () => {
    const d = diffLines([file("a.ts", [{ kind: "ctx", n: 1 }, { kind: "add", n: 2 }, { kind: "del", n: 3 }])]);
    expect([d.inDiff("a.ts", 1), d.inDiff("a.ts", 2), d.inDiff("a.ts", 3), d.inDiff("b.ts", 1)]).toEqual([true, true, false, false]);
    expect([d.isAdded("a.ts", 1), d.isAdded("a.ts", 2)]).toEqual([false, true]);
  });
});

describe("staticAnalysisStep", () => {
  const failingGit: GitRunner = () => Promise.resolve({ code: 128, stdout: "", stderr: "fatal" });
  let roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
  });

  function deps(): { d: ToolsDeps; installed: ToolName[][]; removed: string[] } {
    const installed: ToolName[][] = [];
    const removed: string[] = [];
    const d: ToolsDeps = {
      install: (tools) => {
        installed.push([...tools]);
        const root = mkdtempSync(join(tmpdir(), "myrabbit-tools-"));
        roots.push(root);
        const m: ToolsManifest = { manifest_version: 1, root, installed: {}, failed: {}, versions: {} };
        return Promise.resolve(m);
      },
      remove: (root) => {
        removed.push(root);
        return Promise.resolve();
      },
      asTools: "/nonexistent",
      asRunnerTools: "/nonexistent-runner",
      ruffSelect: () => Promise.resolve(""),
    };
    return { d, installed, removed };
  }
  const base = { git: failingGit, headSha: "a".repeat(40), files: [file("a.ts", [{ kind: "add", n: 1 }])], log };

  it("is null with static analysis off, and installs nothing", async () => {
    const x = deps();
    expect(await staticAnalysisStep({ ...base, config: config([]), deps: x.d, signal: new AbortController().signal })).toBeNull();
    expect(x.installed).toEqual([]);
  });

  it("an unexpected error fails the secret scan closed and still removes the install", async () => {
    const x = deps();
    const r = await staticAnalysisStep({ ...base, config: config(["gitleaks"]), deps: x.d, signal: new AbortController().signal });
    expect(x.installed).toEqual([["gitleaks"]]);
    expect(x.removed).toEqual(roots);
    expect(r?.blockers).toEqual([{ kind: "coverage", severity: "critical", title: "Secret scan did not run (error)" }]);
  });

  it("does not install once the run signal has aborted", async () => {
    const x = deps();
    await staticAnalysisStep({ ...base, config: config(["gitleaks"]), deps: x.d, signal: AbortSignal.abort() });
    expect(x.installed).toEqual([]);
  });
});

describe("realToolsDeps.install", () => {
  let actionRoot: string;
  beforeEach(() => {
    actionRoot = mkdtempSync(join(tmpdir(), "pw6-action-"));
    mkdirSync(join(actionRoot, "dist"));
  });
  afterEach(() => {
    rmSync(actionRoot, { recursive: true, force: true });
  });

  /** A stand-in dist/tools-install.js: records its env and argument, writes a manifest. */
  function fakeEntry(body: string): void {
    writeFileSync(join(actionRoot, "dist/tools-install.js"), body);
  }

  it("spawns the entry with a minimal env (no secrets, no GITHUB_*/ACTIONS_*) and reads its manifest", async () => {
    const envFile = join(actionRoot, "env.json");
    fakeEntry(`
      import { mkdtempSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ env: process.env, arg: process.argv[2] }));
      const root = mkdtempSync("${tmpdir()}/myrabbit-tools-");
      writeFileSync(root + "/manifest.json", JSON.stringify({ manifest_version: 1, root, installed: {}, failed: {}, versions: {} }));
      console.log(JSON.stringify({ root }));
    `);
    process.env.CLAUDE_CODE_OAUTH_TOKEN_TEST_PW6 = "should-not-leak";
    try {
      const m = await realToolsDeps(actionRoot, log).install(["gitleaks"], new AbortController().signal);
      expect(m?.root).toMatch(/\/myrabbit-tools-[^/]+$/);
      if (m) rmSync(m.root, { recursive: true, force: true });
      const seen = JSON.parse(readFileSync(envFile, "utf8")) as { env: Record<string, string>; arg: string };
      expect(Object.keys(seen.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["LANG", "PATH"]);
      expect(JSON.parse(seen.arg)).toEqual({ tools: ["gitleaks"], lockPath: join(actionRoot, "tools/tools.lock"), configDir: join(actionRoot, "tools/config") });
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_TEST_PW6;
    }
  });

  it("is null when the entry fails or prints no root", async () => {
    fakeEntry(`console.log(JSON.stringify({ error: "boom" })); process.exit(1);`);
    expect(await realToolsDeps(actionRoot, log).install(["gitleaks"], new AbortController().signal)).toBeNull();
    fakeEntry(`console.log(JSON.stringify({ root: 42 }));`);
    expect(await realToolsDeps(actionRoot, log).install(["gitleaks"], new AbortController().signal)).toBeNull();
  });

  it("is null when the printed root is not the manifest's", async () => {
    fakeEntry(`console.log(JSON.stringify({ root: "/tmp/myrabbit-tools-does-not-exist" }));`);
    expect(await realToolsDeps(actionRoot, log).install(["gitleaks"], new AbortController().signal)).toBeNull();
    expect(existsSync("/tmp/myrabbit-tools-does-not-exist")).toBe(false);
  });
});

describe("tools-install entry", () => {
  const ok = { tools: ["gitleaks"], lockPath: "/a/tools.lock", configDir: "/a/config" };

  it("accepts only known tools and absolute paths", () => {
    expect(parseInstallRequest(JSON.stringify(ok))).toEqual(ok);
    expect(() => parseInstallRequest(JSON.stringify({ ...ok, tools: ["rm"] }))).toThrow("bad tools");
    expect(() => parseInstallRequest(JSON.stringify({ ...ok, lockPath: "tools.lock" }))).toThrow("bad lockPath");
    expect(() => parseInstallRequest(undefined)).toThrow();
  });

  it("prints the root on success and a short error otherwise", async () => {
    const install = (o: { tools: readonly ToolName[] }) =>
      Promise.resolve({ manifest_version: 1 as const, root: `/tmp/myrabbit-tools-x${String(o.tools.length)}`, installed: {}, failed: {}, versions: {} });
    expect(await runToolsInstall(JSON.stringify(ok), install)).toEqual({ code: 0, line: '{"root":"/tmp/myrabbit-tools-x1"}' });
    expect(await runToolsInstall("{", install)).toMatchObject({ code: 1 });
    const failing = () => Promise.reject(new Error("lock\nunusable"));
    expect(await runToolsInstall(JSON.stringify(ok), failing)).toEqual({ code: 1, line: '{"error":"lock unusable"}' });
  });
});

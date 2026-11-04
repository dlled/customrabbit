// design-v2 §7.4 flow and §7.5 secrets, with a fake tool executor and a fake git tree.

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TreeIndex, type TreeEntry } from "../../src/context/git.js";
import type { GitRunner } from "../../src/github/git.js";
import { enabledTools, markConfirmed, runStaticAnalysis, type StaticAnalysisInput } from "../../src/tools/index.js";
import type { ExecResult, ToolExec } from "../../src/tools/exec.js";
import type { ToolsManifest } from "../../src/tools/install.js";
import { TOOL_NAMES, type MergedFinding, type ToolName, type ToolsConfig } from "../../src/types.js";

const HEAD = "a".repeat(40);
const ROOT = "/tmp/myrabbit-tools-test";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "p6-analysis-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Blobs of every fake tree; an oid with no blob is a git read failure. */
const blobs = new Map<string, string>();
let nextOid = 1;
const git: GitRunner = (args) => {
  const text = blobs.get(args.at(-1) ?? "");
  return Promise.resolve(text === undefined ? { code: 128, stdout: "", stderr: "" } : { code: 0, stdout: text, stderr: "" });
};

/** A head tree. `null` content lists the file but makes reading it fail; `size` overrides the listed size. */
function tree(files: Record<string, string | null>, sizes: Record<string, number> = {}): TreeIndex {
  const entries = new Map<string, TreeEntry>();
  for (const [path, text] of Object.entries(files)) {
    const oid = (nextOid++).toString(16).padStart(40, "0");
    entries.set(path, { mode: "100644", oid, size: sizes[path] ?? text?.length ?? 10 });
    if (text !== null) blobs.set(oid, text);
  }
  return new TreeIndex(git, HEAD, entries);
}

function config(on: Partial<Record<ToolName, boolean>> = {}, enabled = true): ToolsConfig {
  return {
    enabled,
    ...(Object.fromEntries(TOOL_NAMES.map((t) => [t, { enabled: on[t] ?? true }])) as Record<ToolName, { enabled: boolean }>),
  };
}

function manifest(failed: ToolsManifest["failed"] = {}): ToolsManifest {
  const installed = Object.fromEntries(TOOL_NAMES.filter((t) => !(t in failed)).map((t) => [t, `${ROOT}/bin/${t}`]));
  return { manifest_version: 1, root: ROOT, installed, failed, versions: {} };
}

type Reply = Partial<ExecResult> | ((stage: string) => Partial<ExecResult>);

/** Executor that answers per tool (by binary name), recording each call and the staged files it saw. */
function fakeExec(replies: Partial<Record<ToolName, Reply>>, seen: { tool: string; args: string[]; staged?: string[] }[] = []): ToolExec {
  return async (cmd) => {
    const tool = (cmd.file === "/usr/bin/python3" ? "yamllint" : cmd.file.split("/").at(-1)) as ToolName;
    const stage = tool === "gitleaks" ? (cmd.args[1] ?? "") : (cmd.args.at(-1) ?? "").replace(/(\/myrabbit-stage-[^/]+)\/.*$/, "$1");
    seen.push({ tool, args: cmd.args, staged: await readdir(stage, { recursive: true }).catch(() => []) });
    const r = replies[tool];
    const out = typeof r === "function" ? r(stage) : (r ?? {});
    return { code: 0, stdout: tool === "shellcheck" ? '{"comments":[]}' : "[]", stderr: "", timedOut: false, failed: false, ...out };
  };
}

const leak = (stage: string, path: string, line: number, rule = "generic-api-key") =>
  JSON.stringify([{ RuleID: rule, File: `${stage}/${path}`, StartLine: line, Match: "x", Secret: "REDACTED" }]);

function input(over: Partial<StaticAnalysisInput>): StaticAnalysisInput {
  return {
    config: config(),
    tree: tree({ "scripts/run.sh": "#!/bin/sh\nrm -rf $1\n", "app.py": "import os\nkey = 'x'\n" }),
    git,
    paths: ["scripts/run.sh", "app.py"],
    manifest: manifest(),
    asTools: "/action/bin/as-tools",
    ruffSelect: "E9,F",
    inDiff: () => true,
    isAdded: () => true,
    exec: fakeExec({}),
    tmpBase: base,
    ...over,
  };
}

describe("runStaticAnalysis", () => {
  it("is off when tools.enabled is false or every tool is off", async () => {
    expect(await runStaticAnalysis(input({ config: config({}, false) }))).toBeNull();
    expect(enabledTools(config(Object.fromEntries(TOOL_NAMES.map((t) => [t, false]))))).toEqual([]);
  });

  it("runs only tools that understand a staged file, on staged copies, and removes the stage", async () => {
    const seen: { tool: string; args: string[]; staged?: string[] }[] = [];
    const r = await runStaticAnalysis(input({ exec: fakeExec({}, seen) }));
    expect(seen.map((s) => s.tool).sort()).toEqual(["gitleaks", "ruff", "shellcheck"]);
    const statuses = Object.fromEntries((r?.info.runs ?? []).map((x) => [x.tool, x.status]));
    expect(statuses).toMatchObject({ shellcheck: "ok", ruff: "ok", gitleaks: "ok", hadolint: "skipped", squawk: "skipped" });
    expect(seen.find((s) => s.tool === "gitleaks")?.staged?.sort()).toEqual(["app.py", "scripts", "scripts/run.sh"]);
    expect((await readdir(base)).filter((d) => d.startsWith("myrabbit-stage-"))).toEqual([]);
    expect(r?.blockers).toEqual([]);
  });

  it("stages exact blob content", async () => {
    let content = "";
    const exec = fakeExec({
      shellcheck: (stage) => {
        content = readFileSync(join(stage, "scripts/run.sh"), "utf8");
        return {};
      },
    });
    await runStaticAnalysis(input({ exec }));
    expect(content).toBe("#!/bin/sh\nrm -rf $1\n");
  });

  it("a gitleaks hit on an added line is a critical secret blocker naming only rule and location", async () => {
    const r = await runStaticAnalysis(input({ exec: fakeExec({ gitleaks: (s) => ({ code: 3, stdout: leak(s, "app.py", 2) }) }) }));
    expect(r?.blockers).toEqual([
      { kind: "secret", severity: "critical", title: "Possible secret committed (`generic-api-key`) at `app.py:2`" },
    ]);
    expect(r?.info.hits).toEqual([{ tool: "gitleaks", rule: "generic-api-key", path: "app.py", line: 2, message: "Possible secret (generic-api-key)" }]);
    expect(r?.support).toEqual([]);
  });

  it("a gitleaks hit on a context line does not block", async () => {
    const r = await runStaticAnalysis(
      input({ isAdded: () => false, exec: fakeExec({ gitleaks: (s) => ({ code: 3, stdout: leak(s, "app.py", 2) }) }) }),
    );
    expect(r?.blockers).toEqual([]);
  });

  it("drops every other tool's hit on a line gitleaks flagged (§7.4.5)", async () => {
    const ruff = (s: string) => ({
      stdout: JSON.stringify([
        { code: "F401", filename: `${s}/app.py`, location: { row: 1 }, message: "os imported but unused" },
        { code: "E999", filename: `${s}/app.py`, location: { row: 2 }, message: "quotes key = 'the secret'" },
      ]),
    });
    const r = await runStaticAnalysis(input({ exec: fakeExec({ ruff, gitleaks: (s) => ({ code: 3, stdout: leak(s, "app.py", 2) }) }) }));
    expect(r?.info.hits.map((h) => `${h.tool}:${h.rule}@${h.line}`)).toEqual(["gitleaks:generic-api-key@2", "ruff:F401@1"]);
    expect(r?.support).toEqual([{ path: "app.py", line: 1, rule: "ruff:F401" }]);
  });

  it("flags every line of a multi-line leak (a key block) for the drop rule", async () => {
    const ruff = (s: string) => ({
      stdout: JSON.stringify([1, 2, 3].map((row) => ({ code: "E999", filename: `${s}/app.py`, location: { row }, message: "m" }))),
    });
    const gitleaks = (s: string) => ({
      code: 3,
      stdout: JSON.stringify([{ RuleID: "private-key", File: `${s}/app.py`, StartLine: 1, EndLine: 2, Secret: "REDACTED" }]),
    });
    const r = await runStaticAnalysis(input({ exec: fakeExec({ ruff, gitleaks }) }));
    expect(r?.info.hits.filter((h) => h.tool === "ruff").map((h) => h.line)).toEqual([3]);
  });

  it("keeps only hits on the diff's added or context lines", async () => {
    const ruff = (s: string) => ({
      stdout: JSON.stringify([1, 2].map((row) => ({ code: "F401", filename: `${s}/app.py`, location: { row }, message: "m" }))),
    });
    const r = await runStaticAnalysis(input({ inDiff: (_p, l) => l === 2, exec: fakeExec({ ruff }) }));
    expect(r?.info.hits.map((h) => h.line)).toEqual([2]);
  });

  it("orders by tool severity and caps at 50", async () => {
    const shell = (s: string) => ({
      stdout: JSON.stringify({
        comments: Array.from({ length: 60 }, (_, i) => ({ file: `${s}/scripts/run.sh`, line: i + 1, code: 2086, level: i === 59 ? "error" : "info", message: "m" })),
      }),
    });
    const r = await runStaticAnalysis(input({ exec: fakeExec({ shellcheck: shell }) }));
    expect(r?.info.hits).toHaveLength(50);
    expect(r?.info.hits[0]?.line).toBe(60);
  });

  describe("the secret scan fails closed (§7.5)", () => {
    it.each([
      ["timeout", { timedOut: true, code: null }, "timeout", "timeout"],
      ["crash", { code: 2 }, "crashed (exit 2)", "error"],
      ["killed", { code: null }, "crashed", "error"],
      ["unparsable output", { code: 0, stdout: "panic: oops" }, "unparsable output", "error"],
      ["output limit", { failed: true }, "crashed", "error"],
    ] as const)("%s → blocking coverage item", async (_n, reply, reason, status) => {
      const r = await runStaticAnalysis(input({ exec: fakeExec({ gitleaks: reply }) }));
      expect(r?.blockers).toEqual([{ kind: "coverage", severity: "critical", title: `Secret scan did not run (${reason})` }]);
      expect(r?.info.runs.find((x) => x.tool === "gitleaks")?.status).toBe(status);
    });

    it.each([
      ["sha256", "sha256 mismatch against tools.lock", "unverified"],
      ["download", "download failed", "error"],
      ["extract", "install failed", "error"],
    ] as const)("install failure %s → blocking coverage item", async (failure, reason, status) => {
      const r = await runStaticAnalysis(input({ manifest: manifest({ gitleaks: failure }) }));
      expect(r?.blockers).toEqual([{ kind: "coverage", severity: "critical", title: `Secret scan did not run (${reason})` }]);
      expect(r?.info.runs.find((x) => x.tool === "gitleaks")?.status).toBe(status);
    });

    it("no manifest at all → blocking coverage item", async () => {
      const r = await runStaticAnalysis(input({ manifest: null }));
      expect(r?.blockers).toEqual([{ kind: "coverage", severity: "critical", title: "Secret scan did not run (not installed)" }]);
    });

    it.each([
      ["over 1 MiB", tree({ "big.txt": "k = 1\n", "ok.py": "x\n" }, { "big.txt": 1024 * 1024 + 1 })],
      ["unreadable (git failure)", tree({ "gone.txt": null, "ok.py": "x\n" })],
    ])("a changed file it could not scan (%s) → blocking coverage item", async (_n, t) => {
      const r = await runStaticAnalysis(input({ tree: t, paths: [...t.files.keys()] }));
      expect(r?.blockers).toEqual([
        { kind: "coverage", severity: "critical", title: "Secret scan did not cover 1 file(s): too large or unreadable" },
      ]);
    });

    it("binary blobs, deleted paths, symlinks and submodules need no secret scan", async () => {
      const t = tree({ "logo.png": "\x89PNG\0\0", "ok.py": "x\n" });
      const r = await runStaticAnalysis(input({ tree: t, paths: ["logo.png", "ok.py", "deleted.py", "link"] }));
      expect(r?.blockers).toEqual([]);
    });

    it("an uncovered file is not reported when gitleaks is off", async () => {
      const t = tree({ "big.txt": "k\n" }, { "big.txt": 2 * 1024 * 1024 });
      const r = await runStaticAnalysis(input({ tree: t, paths: ["big.txt"], config: config({ gitleaks: false }) }));
      expect(r?.blockers).toEqual([]);
    });

    it("a leak gitleaks reports outside the stage is unparsable output, not a dropped hit", async () => {
      const exec = fakeExec({ gitleaks: () => ({ code: 3, stdout: leak("/elsewhere", "app.py", 2) }) });
      const r = await runStaticAnalysis(input({ exec }));
      expect(r?.blockers).toEqual([{ kind: "coverage", severity: "critical", title: "Secret scan did not run (unparsable output)" }]);
    });

    it("does not block when gitleaks is off or no file is in scope", async () => {
      expect((await runStaticAnalysis(input({ manifest: null, config: config({ gitleaks: false }) })))?.blockers).toEqual([]);
      expect((await runStaticAnalysis(input({ manifest: null, paths: [] })))?.blockers).toEqual([]);
    });
  });

  it("every other tool fails soft: a note, no blocker", async () => {
    const r = await runStaticAnalysis(input({ exec: fakeExec({ shellcheck: { timedOut: true, code: null }, ruff: { code: 2 } }) }));
    expect(r?.blockers).toEqual([]);
    expect(r?.notes.sort()).toEqual(["ruff: crashed (exit 2)", "shellcheck: timeout"]);
  });

  it("never stages a path that could escape the stage", async () => {
    const seen: { tool: string; args: string[]; staged?: string[] }[] = [];
    const t = tree({ "ok.sh": "x", "../evil.sh": "x", "a/../../b.sh": "x" });
    const r = await runStaticAnalysis(input({ tree: t, paths: ["ok.sh", "../evil.sh", "a/../../b.sh", "missing.sh"], exec: fakeExec({}, seen) }));
    expect(seen.find((s) => s.tool === "gitleaks")?.staged).toEqual(["ok.sh"]);
    expect(r?.info.runs.find((x) => x.tool === "shellcheck")?.files).toBe(1);
  });

  it("strips backticks and newlines from a PR path in the secret title", async () => {
    const t = tree({ "a`b\nc.py": "k = 1\n" });
    const r = await runStaticAnalysis(
      input({ tree: t, paths: ["a`b\nc.py"], exec: fakeExec({ gitleaks: (s) => ({ code: 3, stdout: leak(s, "a`b\nc.py", 1) }) }) }),
    );
    // A newline in a path cannot be staged: the file was not scanned, which fails closed.
    expect(r?.blockers).toEqual([
      { kind: "coverage", severity: "critical", title: "Secret scan did not cover 1 file(s): too large or unreadable" },
    ]);
    const t2 = tree({ "a`b.py": "k = 1\n" });
    const r2 = await runStaticAnalysis(input({ tree: t2, paths: ["a`b.py"], exec: fakeExec({ gitleaks: (s) => ({ code: 3, stdout: leak(s, "a`b.py", 1) }) }) }));
    expect(r2?.blockers[0]?.title).toBe("Possible secret committed (`generic-api-key`) at `ab.py:1`");
  });
});

describe("markConfirmed (§7.4.4)", () => {
  const f = (over: Partial<MergedFinding>): MergedFinding =>
    ({ path: "a.sh", line: 3, end_line: 5, side: "RIGHT", rule: "shellcheck:SC2086", ...over }) as MergedFinding;
  const hit = { tool: "shellcheck" as const, rule: "SC2086", path: "a.sh", line: 4, message: "m" };

  it("confirms a hit inside a finding's range with the same tool:rule", () => {
    expect(markConfirmed([hit], [f({})])[0]?.confirmed).toBe(true);
  });
  it.each([
    ["other rule", { rule: "shellcheck:SC2034" }],
    ["other path", { path: "b.sh" }],
    ["outside the range", { line: 5, end_line: null }],
    ["LEFT side", { side: "LEFT" as const }],
  ])("not for %s", (_n, over) => {
    expect(markConfirmed([hit], [f(over)])[0]?.confirmed).toBe(false);
  });
});

it("the gitleaks fixture never contains a secret value", async () => {
  const text = await readFile(new URL("fixtures/gitleaks.out", import.meta.url), "utf8");
  expect((JSON.parse(text) as { Secret: string }[])[0]?.Secret).toBe("REDACTED");
});

// design-v2 §7.1 invocations and §7.2 lock.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OK_EXIT_CODES, toolCommand, toolHandles } from "../../src/tools/commands.js";
import { CONFIG_FILES } from "../../src/tools/install.js";
import { parseToolsLock } from "../../src/tools/lock.js";
import { TOOL_NAMES, type ToolName } from "../../src/types.js";

const lockText = readFileSync(new URL("../../tools/tools.lock", import.meta.url), "utf8");

describe("tools/tools.lock", () => {
  it("pins every v2 tool with a sha256 on an allowed https host", () => {
    const lock = parseToolsLock(lockText);
    expect(Object.keys(lock.tools).sort()).toEqual([...TOOL_NAMES].sort());
    expect(lock.tools.yamllint.archive).toBe("wheels");
  });

  it("ships a pinned config file for every tool that takes one", () => {
    for (const name of Object.values(CONFIG_FILES)) {
      expect(readFileSync(new URL(`../../tools/config/${name}`, import.meta.url), "utf8").length).toBeGreaterThan(0);
    }
  });

  const raw = (): { tools: Record<string, Record<string, unknown>> } => JSON.parse(lockText) as { tools: Record<string, Record<string, unknown>> };
  const tool = (l: ReturnType<typeof raw>, name: string): Record<string, unknown> => {
    const t = l.tools[name];
    if (t === undefined) throw new Error(`no ${name} in tools.lock`);
    return t;
  };
  it.each([
    ["http URL", (l: ReturnType<typeof raw>) => (tool(l, "hadolint").url = "http://github.com/x")],
    ["other host", (l: ReturnType<typeof raw>) => (tool(l, "hadolint").url = "https://evil.example/x")],
    ["credentials in URL", (l: ReturnType<typeof raw>) => (tool(l, "hadolint").url = "https://u:p@github.com/x")],
    ["short sha256", (l: ReturnType<typeof raw>) => (tool(l, "hadolint").sha256 = "abc")],
    ["member escaping the archive", (l: ReturnType<typeof raw>) => (tool(l, "gitleaks").member = "../gitleaks")],
    ["member that is an option", (l: ReturnType<typeof raw>) => (tool(l, "gitleaks").member = "--to-command=x")],
    ["tar without member", (l: ReturnType<typeof raw>) => delete tool(l, "gitleaks").member],
    ["unknown tool", (l: ReturnType<typeof raw>) => (l.tools.eslint = { ...l.tools.hadolint })],
  ])("rejects %s", (_name, mutate) => {
    const l = raw();
    mutate(l);
    expect(() => parseToolsLock(JSON.stringify(l))).toThrow();
  });
});

describe("which files each tool checks", () => {
  it.each([
    ["shellcheck", "scripts/a.sh", "", true],
    ["shellcheck", "bin/as-tools", "#!/usr/bin/env bash", true],
    ["shellcheck", "bin/tool", "#!/usr/bin/env python3", false],
    ["shellcheck", "a.py", "#!/bin/sh", false],
    ["actionlint", ".github/workflows/ci.yml", "", true],
    ["actionlint", "action.yml", "", false],
    ["zizmor", "action.yml", "", true],
    ["zizmor", "sub/action.yaml", "", true],
    ["hadolint", "Dockerfile", "", true],
    ["hadolint", "docker/api.Dockerfile", "", true],
    ["hadolint", "Containerfile.dev", "", true],
    ["hadolint", "docs/Dockerfile.md", "", true],
    ["ruff", "x.pyi", "", true],
    ["yamllint", "a.yaml", "", true],
    ["squawk", "db/001.SQL", "", true],
    ["squawk", "a.ts", "", false],
    ["gitleaks", "anything", "", true],
  ] as const)("%s %s → %s", (tool, path, first, want) => {
    expect(toolHandles(tool, path, first)).toBe(want);
  });
});

describe("§7.1 invocations", () => {
  const ctx = { root: "/tmp/myrabbit-tools-x", stage: "/tmp/myrabbit-stage-y", files: ["/tmp/myrabbit-stage-y/-rf"], shellcheck: "/tmp/myrabbit-tools-x/bin/shellcheck" };
  const cmd = (t: ToolName) => toolCommand(t, ctx, "E9,F\n");

  it("uses only absolute paths: a PR path starting with - is never an option", () => {
    for (const t of TOOL_NAMES) {
      const c = cmd(t);
      expect(c.file.startsWith("/")).toBe(true);
      if (t !== "gitleaks") expect(c.args.at(-1)).toBe("/tmp/myrabbit-stage-y/-rf");
    }
  });

  it("never reads repository config", () => {
    expect(cmd("shellcheck").args).toContain("--norc");
    expect(cmd("actionlint").args).toEqual(expect.arrayContaining(["-config-file", "/tmp/myrabbit-tools-x/config/actionlint.yaml", "-pyflakes="]));
    expect(cmd("hadolint").args).toEqual(expect.arrayContaining(["--config", "--disable-ignore-pragma"]));
    expect(cmd("zizmor").args).toEqual(expect.arrayContaining(["--offline", "--no-config"]));
    expect(cmd("ruff").args).toEqual(expect.arrayContaining(["--isolated", "--no-cache", "--select", "E9,F"]));
    expect(cmd("squawk").args.slice(0, 2)).toEqual(["-c", "/tmp/myrabbit-tools-x/config/squawk.toml"]);
  });

  it("yamllint runs from the pinned wheels with an isolated interpreter", () => {
    const c = cmd("yamllint");
    expect(c.file).toBe("/usr/bin/python3");
    expect(c.args[0]).toBe("-I");
    expect(c.args[2]).toContain('sys.path.insert(0, "/tmp/myrabbit-tools-x/py")');
  });

  it("gitleaks: pinned config, empty ignore dir, allow comments ignored, redacted JSON on stdout, leaks = exit 3", () => {
    expect(cmd("gitleaks").args).toEqual([
      "dir", "/tmp/myrabbit-stage-y",
      "--config", "/tmp/myrabbit-tools-x/config/gitleaks.toml",
      "-i", "/tmp/myrabbit-tools-x/no-ignore",
      "--ignore-gitleaks-allow", "--redact", "-f", "json", "-r", "-", "--no-banner", "--exit-code", "3",
    ]);
    expect(OK_EXIT_CODES.gitleaks).toEqual([0, 3]);
  });

  it("actionlint's shellcheck integration is off when shellcheck is not installed", () => {
    expect(toolCommand("actionlint", { ...ctx, shellcheck: null }, "").args).toContain("-shellcheck=");
  });
});

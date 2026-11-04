// design-v2 §2 config keys (P0): all default off, validated, covered by the config hash; and the
// §6.1 learnings hook in collectStyleGuides.

import { describe, expect, it, vi } from "vitest";

import { configHash } from "../../src/config/hash.js";
import { LEARNINGS_PATH, type Learning } from "../../src/config/learnings.js";
import { parseConfigText } from "../../src/config/load.js";
import { defaultConfig, MAX_CUSTOM_CHECKS } from "../../src/config/schema.js";
import { collectStyleGuides } from "../../src/config/style-guide.js";
import { RULE_PACK_NAMES, TOOL_NAMES, type Config } from "../../src/types.js";
import { BASE_SHA, fakeGit } from "./fake-git.js";

const learnings = vi.hoisted(() => ({ value: [] as Learning[] }));
vi.mock("../../src/config/learnings.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/config/learnings.js")>();
  return { ...mod, parseLearnings: vi.fn(() => learnings.value) };
});

/** The §2 YAML block with every feature on, as each will be once its eval delta lands. */
const DESIGN_V2_EXAMPLE = `
context:
  enabled: true
  max_chars: 60000
  max_usages_per_symbol: 8
  typescript: true
rule_packs:
  typescript: true
  python: true
  go: true
  rust: true
  shell: true
  github_actions: true
  dockerfile: true
  sql: true
learnings:
  enabled: true
  propose: true
walkthrough:
  effort: true
  merge_risk: true
  ai_agent_prompts: true
  related: true
  suggested_reviewers: true
labels:
  - { label: "bug", instructions: "Fixes a defect." }
  - { label: "breaking" }
pre_merge_checks:
  title:       { mode: warning, requirements: "Conventional commit style." }
  description: { mode: error, requirements: "" }
  docstrings:  { mode: warning, threshold: 80 }
  linked_issues: { mode: off }
  custom:
    - { name: "No TODOs", mode: error, instructions: "Fail when the diff adds a TODO." }
tools:
  enabled: true
  shellcheck: { enabled: true }
  actionlint: { enabled: true }
  hadolint:   { enabled: true }
  zizmor:     { enabled: true }
  ruff:       { enabled: true }
  yamllint:   { enabled: true }
  squawk:     { enabled: true }
  gitleaks:   { enabled: true }
`;

function invalid(yaml: string): string[] {
  const r = parseConfigText(yaml);
  expect(r.source).toBe("invalid");
  expect(r.config).toEqual(defaultConfig());
  return r.warnings;
}

describe("design-v2 config defaults (P0)", () => {
  it("ships every feature off", () => {
    const c = defaultConfig();
    expect(c.context.enabled).toBe(false);
    expect(c.context.typescript).toBe(false);
    for (const p of RULE_PACK_NAMES) expect(c.rule_packs[p], p).toBe(false);
    expect(c.learnings).toEqual({ enabled: false, propose: false });
    expect(Object.values(c.walkthrough).every((v) => !v)).toBe(true);
    expect(c.labels).toEqual([]);
    const checks = c.pre_merge_checks;
    expect([checks.title.mode, checks.description.mode, checks.docstrings.mode, checks.linked_issues.mode]).toEqual([
      "off", "off", "off", "off",
    ]);
    expect(checks.custom).toEqual([]);
    expect(c.tools.enabled).toBe(false);
    for (const t of TOOL_NAMES) expect(c.tools[t].enabled, t).toBe(false);
  });

  it("fills nested defaults for a partial v2 block", () => {
    const r = parseConfigText("tools:\n  gitleaks: { enabled: true }\npre_merge_checks:\n  title: { mode: error }\n");
    expect(r.source).toBe("file");
    expect(r.config.tools.gitleaks.enabled).toBe(true);
    expect(r.config.tools.enabled).toBe(false);
    expect(r.config.tools.ruff.enabled).toBe(false);
    expect(r.config.pre_merge_checks.title).toEqual({ mode: "error", requirements: "" });
    expect(r.config.pre_merge_checks.docstrings).toEqual({ mode: "off", threshold: 80 });
  });
});

describe("design-v2 config validation", () => {
  it("accepts the §2 example with every feature on", () => {
    const r = parseConfigText(DESIGN_V2_EXAMPLE);
    expect(r.warnings).toEqual([]);
    expect(r.source).toBe("file");
    expect(r.config.context).toEqual({ enabled: true, max_chars: 60_000, max_usages_per_symbol: 8, typescript: true });
    expect(r.config.labels).toEqual([
      { label: "bug", instructions: "Fixes a defect." },
      { label: "breaking", instructions: "" },
    ]);
    expect(r.config.pre_merge_checks.custom).toEqual([
      { name: "No TODOs", mode: "error", instructions: "Fail when the diff adds a TODO." },
    ]);
    for (const t of TOOL_NAMES) expect(r.config.tools[t].enabled, t).toBe(true);
  });

  it.each([
    ["an unknown tool", "tools:\n  eslint: { enabled: true }\n", "tools"],
    ["an unknown rule pack", "rule_packs:\n  java: true\n", "rule_packs"],
    ["an unknown check mode", "pre_merge_checks:\n  title: { mode: block }\n", "pre_merge_checks.title.mode"],
    ["a docstring threshold over 100", "pre_merge_checks:\n  docstrings: { threshold: 101 }\n", "pre_merge_checks.docstrings.threshold"],
    ["max_chars 0", "context:\n  max_chars: 0\n", "context.max_chars"],
    ["a duplicate label", "labels:\n  - { label: bug }\n  - { label: bug }\n", "labels"],
    ["a multi-line label", 'labels:\n  - { label: "a\\nb" }\n', "labels.0.label"],
    ["a custom check named like a built-in", "pre_merge_checks:\n  custom:\n    - { name: title, mode: error, instructions: x }\n", "pre_merge_checks.custom.0.name"],
    ["a blank custom check instruction", 'pre_merge_checks:\n  custom:\n    - { name: c, mode: error, instructions: "  " }\n', "pre_merge_checks.custom.0.instructions"],
    ["duplicate custom checks", "pre_merge_checks:\n  custom:\n    - { name: c, instructions: x }\n    - { name: c, instructions: y }\n", "pre_merge_checks.custom"],
  ])("rejects %s", (_what, yaml, where) => {
    expect(invalid(yaml).join("\n")).toContain(`- ${where}:`);
  });

  it("caps custom checks, names and instructions", () => {
    const check = (i: number): string => `    - { name: c${i}, mode: warning, instructions: x }\n`;
    const many = `pre_merge_checks:\n  custom:\n${Array.from({ length: MAX_CUSTOM_CHECKS + 1 }, (_, i) => check(i)).join("")}`;
    invalid(many);
    expect(parseConfigText(many.replace(check(MAX_CUSTOM_CHECKS), "")).source).toBe("file");
    invalid(`pre_merge_checks:\n  custom:\n    - { name: "${"n".repeat(51)}", instructions: x }\n`);
    invalid(`pre_merge_checks:\n  custom:\n    - { name: n, instructions: "${"x".repeat(10_001)}" }\n`);
    expect(parseConfigText(`pre_merge_checks:\n  custom:\n    - { name: "${"n".repeat(50)}", instructions: "${"x".repeat(10_000)}" }\n`).source).toBe("file");
  });
});

describe("config hash covers the design-v2 keys", () => {
  it("changes with any v2 setting", () => {
    const base = defaultConfig();
    const h = configHash(base);
    const variants: Config[] = [
      { ...base, context: { ...base.context, enabled: true } },
      { ...base, rule_packs: { ...base.rule_packs, sql: true } },
      { ...base, learnings: { ...base.learnings, propose: true } },
      { ...base, walkthrough: { ...base.walkthrough, effort: true } },
      { ...base, labels: [{ label: "bug", instructions: "" }] },
      { ...base, pre_merge_checks: { ...base.pre_merge_checks, linked_issues: { mode: "warning" } } },
      { ...base, tools: { ...base.tools, gitleaks: { enabled: true } } },
    ];
    for (const v of variants) expect(configHash(v)).not.toBe(h);
  });
});

describe("learnings hook (§6.1)", () => {
  const cfg = (enabled: boolean, files: string[] = []) => ({
    style_guide: { auto: false, files },
    path_instructions: [],
    path_filters: [],
    learnings: { enabled, propose: false },
  });

  it("does not read the learnings file while learnings are off (the default)", async () => {
    const git = fakeGit({ [BASE_SHA]: { [LEARNINGS_PATH]: "## A\nrule\n" } });
    const r = await collectStyleGuides(git, BASE_SHA, { ...defaultConfig(), style_guide: { auto: false, files: [] } });
    expect(r.guides).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it("turns each parsed learning into a scoped guide from the base SHA", async () => {
    learnings.value = [
      { title: "Use the logger", paths: ["src/**", "./lib/**"], content: "Never console.log." },
      { title: "Repo-wide", paths: [], content: "Prefer small PRs." },
      { title: "Empty", paths: [], content: "   " },
    ];
    const git = fakeGit({ [BASE_SHA]: { "AGENTS.md": "Root.", [LEARNINGS_PATH]: "(parsed by the mock)" } });
    const r = await collectStyleGuides(git, BASE_SHA, cfg(true, ["AGENTS.md"]));
    expect(git.calls).toContainEqual({ op: "showFile", sha: BASE_SHA, arg: LEARNINGS_PATH });
    expect(r.guides.map((g) => [g.id, g.origin, g.title, g.scope, g.content])).toEqual([
      ["G1", "files", undefined, ["**"], "Root."],
      ["G2", "learnings", "Use the logger", ["src/**", "lib/**"], "Never console.log."],
      ["G3", "learnings", "Repo-wide", ["**"], "Prefer small PRs."],
    ]);
    expect(r.warnings).toEqual([]);
    learnings.value = [];
  });

  it("is silent when the file is missing, and warns when it is also a style_guide file", async () => {
    learnings.value = [{ title: "T", paths: [], content: "x" }];
    const missing = await collectStyleGuides(fakeGit({ [BASE_SHA]: {} }), BASE_SHA, cfg(true));
    expect(missing).toMatchObject({ guides: [], warnings: [] });

    const git = fakeGit({ [BASE_SHA]: { [LEARNINGS_PATH]: "## T\nx\n" } });
    const both = await collectStyleGuides(git, BASE_SHA, cfg(true, [LEARNINGS_PATH]));
    expect(both.guides.map((g) => g.origin)).toEqual(["files"]);
    expect(both.warnings).toEqual([expect.stringContaining("used as one guide, not as learnings")]);
    learnings.value = [];
  });

  it("shares the style guide cap and changes the config hash", async () => {
    learnings.value = [{ title: "Long", paths: [], content: "y".repeat(100) }];
    const git = fakeGit({ [BASE_SHA]: { [LEARNINGS_PATH]: "x" } });
    const r = await collectStyleGuides(git, BASE_SHA, cfg(true), 40);
    expect(r.guides[0]).toMatchObject({ truncated: true, content: "y".repeat(40) });
    expect(configHash(defaultConfig(), r.guides)).not.toBe(configHash(defaultConfig(), []));
    learnings.value = [];
  });
});

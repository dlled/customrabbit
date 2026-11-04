import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONFIG_PATH, loadConfig, loadReviewConfig, parseConfigText } from "../../src/config/load.js";
import { defaultConfig } from "../../src/config/schema.js";
import type { GitReader } from "../../src/config/git.js";
import { BASE_SHA, fakeGit, HEAD_SHA } from "./fake-git.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("defaults", () => {
  it("match design §4", () => {
    expect(defaultConfig()).toEqual({
      version: 1,
      profile: "chill",
      request_changes_threshold: "major",
      language: "en-US",
      tone_instructions: "",
      style_guide: { auto: true, files: [] },
      path_filters: [],
      path_instructions: [],
      auto_review: {
        enabled: true,
        drafts: false,
        ignore_title_keywords: ["WIP", "[skip review]"],
        labels: ["!no-myrabbit"],
      },
      engines: {
        claude: { enabled: true, model: "claude-opus-5-5", effort: "high", max_turns: 40, max_budget_usd: 3 },
        codex: { enabled: true, model: null, effort: "high" },
        timeout_minutes: 12,
      },
      limits: { max_files: 150, max_diff_bytes: 400_000, max_inline_comments: 15 },
      // design-v2 §2: every feature ships off (P0).
      context: { enabled: false, max_chars: 60_000, max_usages_per_symbol: 8, typescript: false },
      rule_packs: {
        typescript: false, python: false, go: false, rust: false,
        shell: false, github_actions: false, dockerfile: false, sql: false,
      },
      learnings: { enabled: false, propose: false },
      walkthrough: { effort: false, merge_risk: false, ai_agent_prompts: false, related: false, suggested_reviewers: false },
      labels: [],
      pre_merge_checks: {
        title: { mode: "off", requirements: "" },
        description: { mode: "off", requirements: "" },
        docstrings: { mode: "off", threshold: 80 },
        linked_issues: { mode: "off" },
        custom: [],
      },
      tools: {
        enabled: false,
        shellcheck: { enabled: false }, actionlint: { enabled: false }, hadolint: { enabled: false },
        zizmor: { enabled: false }, ruff: { enabled: false }, yamllint: { enabled: false },
        squawk: { enabled: false }, gitleaks: { enabled: false },
      },
    });
  });

  it("returns a fresh object each time", () => {
    const a = defaultConfig();
    a.path_filters.push("x");
    expect(defaultConfig().path_filters).toEqual([]);
  });
});

describe("parseConfigText", () => {
  it("accepts the design §4 example and it equals the defaults plus its instruction", () => {
    const r = parseConfigText(fixture("design-example.yaml"));
    expect(r.source).toBe("file");
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({
      ...defaultConfig(),
      path_instructions: [{ path: "src/**/*.ts", instructions: "Prefer explicit return types." }],
    });
  });

  it("merges a partial file with defaults, including nested objects", () => {
    const r = parseConfigText(fixture("partial.yaml"));
    expect(r.source).toBe("file");
    expect(r.config.profile).toBe("assertive");
    expect(r.config.request_changes_threshold).toBe("critical");
    expect(r.config.path_filters).toEqual(["!**/fixtures/**", "**/*.csv"]);
    expect(r.config.engines.claude).toEqual({ ...defaultConfig().engines.claude, effort: "max" });
    expect(r.config.engines.codex).toEqual({ enabled: false, model: null, effort: "high" });
    expect(r.config.limits).toEqual({ ...defaultConfig().limits, max_inline_comments: 5 });
    expect(r.config.auto_review).toEqual(defaultConfig().auto_review);
  });

  it.each([
    ["comments-only.yaml"],
    ["empty", ""],
  ])("treats %s as defaults without warnings", (name, text?: string) => {
    const r = parseConfigText(text ?? fixture(name));
    expect(r).toEqual({ config: defaultConfig(), source: "default", warnings: [] });
  });

  it.each([
    ["unknown-key.yaml", /engines\.claude: .*efort/],
    ["bad-types.yaml", /^- profile: /],
    ["malformed.yaml", /^- YAML: /],
    ["both-engines-disabled.yaml", /engines: at least one engine must be enabled/],
    ["version-2.yaml", /^- version: /],
    ["duplicate-key.yaml", /^- YAML: .*[Uu]nique|^- YAML: .*duplicate/i],
    ["not-a-mapping.yaml", /must be a mapping/],
    ["threshold-trivial.yaml", /^- request_changes_threshold: /],
  ])("ignores the whole of %s and uses defaults", (name, pattern) => {
    const r = parseConfigText(fixture(name));
    expect(r.source).toBe("invalid");
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings[0]).toBe(`${CONFIG_PATH} ignored, defaults used:`);
    expect(r.warnings.slice(1).some((w) => pattern.test(w))).toBe(true);
  });

  it("reports every invalid field, not only the first", () => {
    const r = parseConfigText(fixture("bad-types.yaml"));
    const joined = r.warnings.join("\n");
    expect(joined).toMatch(/profile/);
    expect(joined).toMatch(/limits\.max_files/);
    expect(joined).toMatch(/tone_instructions/);
  });

  it("never applies the valid part of an invalid file", () => {
    const r = parseConfigText("profile: assertive\nnot_a_key: true\n");
    expect(r.source).toBe("invalid");
    expect(r.config.profile).toBe("chill");
  });

  it.each([
    ["tone_instructions over 250 chars", `tone_instructions: "${"x".repeat(251)}"`],
    ["path_instructions over 20,000 chars", `path_instructions: [{ path: "**", instructions: "${"x".repeat(20_001)}" }]`],
    ["blank instructions", `path_instructions: [{ path: "**", instructions: "  " }]`],
    ["a bare ! path filter", `path_filters: ["!"]`],
    ["a bare ! label", `auto_review: { labels: ["!"] }`],
    ["a style_guide file with ..", `style_guide: { files: ["../secrets.md"] }`],
    ["an absolute style_guide file", `style_guide: { files: ["/etc/passwd"] }`],
    ["more than 30 inline comments", `limits: { max_inline_comments: 31 }`],
    ["engine timeout over 25 minutes", `engines: { timeout_minutes: 26 }`],
    ["a fractional max_turns", `engines: { claude: { max_turns: 1.5 } }`],
    ["a non-positive budget", `engines: { claude: { max_budget_usd: 0 } }`],
    ["an unknown codex effort", `engines: { codex: { effort: turbo } }`],
    ["a blank claude model", `engines: { claude: { model: "" } }`],
    ["null for a non-nullable key", `profile: null`],
  ])("rejects %s", (_label, text) => {
    expect(parseConfigText(text).source).toBe("invalid");
  });

  it("accepts edge values that are valid", () => {
    const r = parseConfigText(
      [
        `tone_instructions: "${"x".repeat(250)}"`,
        "limits: { max_inline_comments: 0 }",
        "engines: { claude: { enabled: false }, codex: { model: gpt-5.5-codex } }",
        "style_guide: { files: [docs/style.md, .github/REVIEW.md] }",
      ].join("\n"),
    );
    expect(r.warnings).toEqual([]);
    expect(r.source).toBe("file");
    expect(r.config.engines.codex.model).toBe("gpt-5.5-codex");
  });

  it("rejects files over the size limit without parsing them", () => {
    const r = parseConfigText(`# ${"x".repeat(300 * 1024)}\n`);
    expect(r.source).toBe("invalid");
    expect(r.warnings[1]).toMatch(/larger than/);
  });

  it("refuses alias bombs", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 10; i++) {
      const prev = String.fromCharCode(97 + i);
      const next = String.fromCharCode(98 + i);
      lines.push(`${next}: &${next} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`);
    }
    const r = parseConfigText(lines.join("\n"));
    expect(r.source).toBe("invalid");
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseConfigText("﻿profile: quiet\n").config.profile).toBe("quiet");
  });

  it("caps the number of listed issues", () => {
    const text = Array.from({ length: 30 }, (_, i) => `unknown_${i}: 1`).join("\n");
    const r = parseConfigText(text);
    expect(r.source).toBe("invalid");
    expect(r.warnings.length).toBeLessThanOrEqual(1 + 21);
  });
});

describe("loadConfig", () => {
  it("reads .myrabbit.yaml from the base SHA only", async () => {
    const git = fakeGit({
      [BASE_SHA]: { ".myrabbit.yaml": "profile: quiet\n" },
      [HEAD_SHA]: { ".myrabbit.yaml": "request_changes_threshold: critical\nprofile: assertive\n" },
    });
    const r = await loadConfig(git, BASE_SHA);
    expect(r.config.profile).toBe("quiet");
    expect(r.config.request_changes_threshold).toBe("major");
    expect(git.calls.every((c) => c.sha === BASE_SHA)).toBe(true);
  });

  it("reads the config with a byte cap, so a huge file is rejected without reading it all", async () => {
    const git = fakeGit({ [BASE_SHA]: { ".myrabbit.yaml": `# ${"x".repeat(5 * 1024 * 1024)}\n` } });
    const seen: (number | undefined)[] = [];
    const capped: GitReader = {
      listFiles: (sha, glob) => git.listFiles(sha, glob),
      showFile: async (sha, path, max) => {
        seen.push(max);
        const text = await git.showFile(sha, path, max);
        return text;
      },
    };
    const r = await loadConfig(capped, BASE_SHA);
    expect(seen).toEqual([256 * 1024 + 1]);
    expect(r.source).toBe("invalid");
    expect(r.warnings[1]).toMatch(/larger than 262144 bytes/);
  });

  it("uses defaults with no warning when the file is missing", async () => {
    const r = await loadConfig(fakeGit({ [BASE_SHA]: {} }), BASE_SHA);
    expect(r).toEqual({ config: defaultConfig(), source: "default", warnings: [] });
  });

  it("uses defaults with a warning when git fails", async () => {
    const broken: GitReader = {
      showFile: () => Promise.reject(new Error("fatal: bad object\nmore detail")),
      listFiles: () => Promise.resolve([]),
    };
    const r = await loadConfig(broken, BASE_SHA);
    expect(r.source).toBe("invalid");
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings[1]).toBe("- could not read .myrabbit.yaml at the base commit: fatal: bad object");
  });
});

describe("loadReviewConfig", () => {
  it("returns config, guides, filter and hash together", async () => {
    const git = fakeGit({
      [BASE_SHA]: {
        ".myrabbit.yaml": 'style_guide: { files: [docs/style.md, docs/missing.md] }\npath_filters: ["!docs/**"]\n',
        "AGENTS.md": "Be kind.\n",
        "docs/style.md": "Use tabs.\n",
      },
    });
    const r = await loadReviewConfig(git, BASE_SHA);
    expect(r.source).toBe("file");
    expect(r.styleGuide.guides.map((g) => g.path)).toEqual(["AGENTS.md", "docs/style.md"]);
    expect(r.warnings).toEqual(["style_guide.files: docs/missing.md not found at the base commit"]);
    expect(r.pathFilter.matches("docs/a.md")).toBe(false);
    expect(r.pathFilter.matches("src/a.ts")).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("keeps the config when reading style guides fails, with a warning", async () => {
    const git: GitReader = {
      showFile: (_sha, path) => Promise.resolve(path === ".myrabbit.yaml" ? "profile: quiet\n" : null),
      listFiles: () => Promise.reject(new Error("ls-tree failed")),
    };
    const r = await loadReviewConfig(git, BASE_SHA);
    expect(r.config.profile).toBe("quiet");
    expect(r.styleGuide.guides).toEqual([]);
    expect(r.warnings).toEqual(["could not read style guides at the base commit: ls-tree failed"]);
  });

  it("changes the hash when a style guide changes and not when YAML key order changes", async () => {
    const tree = (agents: string, yaml: string) => fakeGit({ [BASE_SHA]: { ".myrabbit.yaml": yaml, "AGENTS.md": agents } });
    const a = await loadReviewConfig(tree("one", "profile: quiet\nlanguage: es-ES\n"), BASE_SHA);
    const b = await loadReviewConfig(tree("one", "language: es-ES\nprofile: quiet\n"), BASE_SHA);
    const c = await loadReviewConfig(tree("two", "profile: quiet\nlanguage: es-ES\n"), BASE_SHA);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

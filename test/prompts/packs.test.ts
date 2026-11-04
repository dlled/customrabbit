import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, loadTemplates, promptVersion, type ReviewPromptInput } from "../../src/prompts/builder.js";
import {
  defaultPacksDir,
  loadRulePacks,
  matchesAny,
  MAX_RULE_PACK_CHARS,
  packsFor,
  packsFromTexts,
  RULE_PACK_GLOBS,
  rulePacks,
  type RulePack,
} from "../../src/prompts/packs/index.js";
import { RULE_PACK_NAMES, type RulePackName, type RulePacksConfig } from "../../src/types.js";
import { V1_CASES } from "../engines/v1-prompt-cases.js";

const ALL_ON = Object.fromEntries(RULE_PACK_NAMES.map((n) => [n, true])) as RulePacksConfig;
const ALL_OFF = Object.fromEntries(RULE_PACK_NAMES.map((n) => [n, false])) as RulePacksConfig;
const only = (...names: RulePackName[]): RulePacksConfig => ({ ...ALL_OFF, ...Object.fromEntries(names.map((n) => [n, true])) });
const names = (packs: readonly RulePack[]) => packs.map((p) => p.name);

describe("shipped packs", () => {
  it("ships one markdown file per pack name, in RULE_PACK_NAMES order", () => {
    expect(names(rulePacks())).toEqual([...RULE_PACK_NAMES]);
    const files = readdirSync(defaultPacksDir()).filter((f) => f.endsWith(".md")).sort();
    expect(files).toEqual(RULE_PACK_NAMES.map((n) => `${n}.md`).sort());
  });

  it.each(RULE_PACK_NAMES)("%s is within the size cap", (name) => {
    const pack = rulePacks().find((p) => p.name === name);
    expect(pack?.text.length).toBeGreaterThan(0);
    expect(pack?.text.length).toBeLessThanOrEqual(MAX_RULE_PACK_CHARS);
  });

  it.each(RULE_PACK_NAMES)("%s cites a source for every rule", (name) => {
    const text = rulePacks().find((p) => p.name === name)?.text ?? "";
    const [body = "", sources = ""] = text.split(/^Sources:$/m);
    const rules = body.split("\n").filter((l) => l.startsWith("- **"));
    expect(rules.length).toBeGreaterThanOrEqual(3);
    const defined = new Set([...sources.matchAll(/^\[(\d+)\] \S/gm)].map((m) => m[1]));
    for (const rule of rules) {
      const cited = [...rule.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
      expect(cited.length, rule).toBeGreaterThan(0);
      for (const n of cited) expect(defined.has(n), `[${n}] in ${name}`).toBe(true);
    }
  });

  it("packs carry no template syntax or untrusted-block tags", () => {
    for (const p of rulePacks()) {
      expect(p.text).not.toMatch(/\{\{[#/]?[a-z_]+\}\}/);
      expect(p.text).not.toMatch(/<\/?untrusted/i);
    }
  });

  it("each pack's globs are the index's globs", () => {
    for (const p of rulePacks()) expect(p.globs).toEqual(RULE_PACK_GLOBS[p.name]);
  });
});

describe("glob selection", () => {
  const cases: [string, RulePackName[]][] = [
    ["src/a.ts", ["typescript"]],
    ["web/App.tsx", ["typescript"]],
    ["scripts/x.mjs", ["typescript"]],
    ["lib/y.cjs", ["typescript"]],
    ["index.js", ["typescript"]],
    ["pkg/mod.py", ["python"]],
    ["stubs/mod.pyi", ["python"]],
    ["cmd/main.go", ["go"]],
    ["src/lib.rs", ["rust"]],
    ["scripts/deploy.sh", ["shell"]],
    ["bin/run.bash", ["shell"]],
    [".github/workflows/ci.yml", ["github_actions"]],
    [".github/workflows/release.yaml", ["github_actions"]],
    ["action.yml", ["github_actions"]],
    ["action/sub/action.yaml", ["github_actions"]],
    ["Dockerfile", ["dockerfile"]],
    ["docker/Dockerfile.dev", ["dockerfile"]],
    ["api.Dockerfile", ["dockerfile"]],
    ["build/app.dockerfile", ["dockerfile"]],
    ["Containerfile", ["dockerfile"]],
    ["db/schema.sql", ["sql"]],
    ["app/migrations/0001_init.py", ["python", "sql"]],
    ["README.md", []],
    ["package.json", []],
    [".github/dependabot.yml", []],
    ["config.yml", []],
    ["src/ts.txt", []],
    ["Makefile", []],
  ];

  it.each(cases)("%s → %j", (path, expected) => {
    const matched = RULE_PACK_NAMES.filter((n) => matchesAny(RULE_PACK_GLOBS[n], path));
    expect(matched).toEqual(expected);
  });

  it("selects only packs that are enabled and touched by the diff, in pack order", () => {
    const paths = ["Dockerfile", "src/a.ts", "README.md", "scripts/x.sh"];
    expect(names(packsFor(paths, ALL_ON))).toEqual(["typescript", "shell", "dockerfile"]);
    expect(names(packsFor(paths, only("shell", "go")))).toEqual(["shell"]);
  });

  it("selects nothing by default (all packs off) or for a diff with no matching file", () => {
    expect(packsFor(["src/a.ts", "Dockerfile"], ALL_OFF)).toEqual([]);
    expect(packsFor(["README.md", "docs/x.md"], ALL_ON)).toEqual([]);
    expect(packsFor([], ALL_ON)).toEqual([]);
  });

  it("returns each pack once however many files match", () => {
    expect(names(packsFor(["a.ts", "b.ts", "c/d.tsx"], ALL_ON))).toEqual(["typescript"]);
  });

  it("matches dot directories but is case-sensitive", () => {
    expect(matchesAny(RULE_PACK_GLOBS.typescript, ".config/x.ts")).toBe(true);
    expect(matchesAny(RULE_PACK_GLOBS.typescript, "src/A.TS")).toBe(false);
  });
});

describe("prompt integration", () => {
  it("prompt_version covers every pack: editing a pack changes it", () => {
    const templates = loadTemplates();
    const base = promptVersion(templates, rulePacks());
    expect(promptVersion(templates)).toBe(base);
    const edited = rulePacks().map((p, i) => (i === 3 ? { ...p, text: `${p.text}\n- extra` } : p));
    expect(promptVersion(templates, edited)).not.toBe(base);
    const reglobbed = rulePacks().map((p, i) => (i === 0 ? { ...p, globs: [...p.globs, "**/*.vue"] } : p));
    expect(promptVersion(templates, reglobbed)).not.toBe(base);
    expect(promptVersion(templates, [])).not.toBe(base);
  });

  it("a selected pack renders in the trusted style guide", () => {
    const [shell] = packsFor(["x.sh"], ALL_ON);
    if (shell === undefined) throw new Error("shell pack not selected");
    const b = buildReviewPrompt({
      ...(V1_CASES[0]?.input as ReviewPromptInput),
      rulePacks: [{ name: shell.name, text: shell.text }],
    });
    const guide = b.prompt.slice(b.prompt.indexOf("<style-guide>"), b.prompt.indexOf("</style-guide>"));
    expect(guide).toContain("[pack shell]\n# Shell");
    expect(guide).toContain("errexit-ignored");
  });

  it("reads nothing from disk at import; the first rulePacks() call loads and caches (PW-P2)", async () => {
    const reads: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      const readFileSync = ((path: string, ...rest: unknown[]) => {
        reads.push(path);
        return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync;
      return { ...fs, readFileSync, default: { ...fs, readFileSync } };
    });
    try {
      const mod = await import("../../src/prompts/packs/index.js");
      await import("../../src/prompts/builder.js");
      expect(reads.filter((p) => p.includes("packs"))).toEqual([]);
      const first = mod.rulePacks();
      expect(reads.filter((p) => p.includes("packs"))).toHaveLength(RULE_PACK_NAMES.length);
      expect(mod.rulePacks()).toBe(first);
      expect(reads.filter((p) => p.includes("packs"))).toHaveLength(RULE_PACK_NAMES.length);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("packsFromTexts (the bundle's embedded texts) keeps RULE_PACK_NAMES order and fails on a missing pack", () => {
    const texts = Object.fromEntries([...RULE_PACK_NAMES].reverse().map((n) => [n, `# ${n}`]));
    expect(names(packsFromTexts(texts))).toEqual([...RULE_PACK_NAMES]);
    expect(packsFromTexts(texts)[0]?.globs).toEqual(RULE_PACK_GLOBS[RULE_PACK_NAMES[0]]);
    const missing = Object.fromEntries(Object.entries(texts).filter(([n]) => n !== "sql"));
    expect(() => packsFromTexts(missing)).toThrow(/sql/);
  });

  it("loadRulePacks reads from a given directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "packs-"));
    try {
      for (const n of RULE_PACK_NAMES) writeFileSync(join(dir, `${n}.md`), `# ${n}\n`);
      const packs = loadRulePacks(dir);
      expect(packs.map((p) => p.text)).toEqual(RULE_PACK_NAMES.map((n) => `# ${n}\n`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

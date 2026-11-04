// design-v2 §7.4.1: each tool's real output (captured from the pinned linux-x64 binaries over a
// sample stage, see test/tools/fixtures) → { tool, rule, path, line, message }.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseToolOutput, ParseError, MAX_MESSAGE_CHARS } from "../../src/tools/normalise.js";
import type { ToolName } from "../../src/types.js";

const ctx = { stage: "/stage", cwd: "/empty" };
const fixture = (name: string): string => readFileSync(new URL(`fixtures/${name}.out`, import.meta.url), "utf8");
const brief = (tool: ToolName, name = tool) =>
  parseToolOutput(tool, fixture(name), ctx).map(({ rule, path, line, rank }) => ({ rule, path, line, rank }));

describe("normalise real tool output", () => {
  it("shellcheck json1: SC codes, 1-based lines, level rank", () => {
    expect(brief("shellcheck")).toEqual([
      { rule: "SC2034", path: "scripts/run.sh", line: 2, rank: 1 },
      { rule: "SC2086", path: "scripts/run.sh", line: 3, rank: 2 },
    ]);
  });

  it("actionlint: paths relative to the tool cwd map back to the stage", () => {
    expect(brief("actionlint")).toEqual([
      { rule: "expression", path: ".github/workflows/ci.yml", line: 9, rank: 1 },
      { rule: "shellcheck", path: ".github/workflows/ci.yml", line: 10, rank: 1 },
    ]);
  });

  it("hadolint: DL codes (the ignore pragma did not hide DL3008)", () => {
    expect(brief("hadolint").map((h) => h.rule)).toEqual(["DL3006", "DL3008", "DL3015", "DL3014"]);
  });

  it("zizmor json-v1: primary locations only, 0-based rows made 1-based", () => {
    const hits = brief("zizmor");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.path === ".github/workflows/ci.yml")).toBe(true);
    expect(hits).toContainEqual({ rule: "artipacked", path: ".github/workflows/ci.yml", line: 8, rank: 1 });
    expect(hits.some((h) => h.rule === "template-injection" && h.line === 9)).toBe(true);
  });

  it("ruff: codes and rows", () => {
    expect(brief("ruff").map((h) => `${h.rule}@${h.line}`).sort()).toEqual(["B006@4", "F401@1", "F821@5"]);
  });

  it("yamllint parsable: rule in parentheses, level rank", () => {
    expect(brief("yamllint")).toEqual([
      { rule: "key-duplicates", path: "conf.yaml", line: 2, rank: 1 },
      { rule: "truthy", path: "conf.yaml", line: 3, rank: 1 },
    ]);
  });

  it("squawk: 0-based lines made 1-based", () => {
    const hits = brief("squawk");
    expect(hits).toContainEqual({ rule: "adding-required-field", path: "db/001.sql", line: 1, rank: 1 });
    expect(hits.some((h) => h.line === 2)).toBe(true);
    expect(hits.every((h) => h.line >= 1)).toBe(true);
  });

  it("gitleaks: rule and location only, never the matched value", () => {
    const hits = parseToolOutput("gitleaks", fixture("gitleaks"), ctx);
    expect(hits).toEqual([
      { tool: "gitleaks", rule: "generic-api-key", path: "-dash/settings.py", line: 2, message: "Possible secret (generic-api-key)", rank: 0 },
    ]);
    expect(parseToolOutput("gitleaks", fixture("gitleaks-clean"), ctx)).toEqual([]);
  });

  it("gitleaks: a leak that cannot be placed fails closed (ParseError), never a silent drop", () => {
    expect(() => parseToolOutput("gitleaks", fixture("gitleaks-unmappable"), ctx)).toThrow(ParseError);
    const bad = (leak: Record<string, unknown>) => JSON.stringify([{ RuleID: "generic-api-key", File: "/stage/a.py", StartLine: 1, ...leak }]);
    expect(() => parseToolOutput("gitleaks", bad({ RuleID: "bad rule;" }), ctx)).toThrow(ParseError);
    expect(() => parseToolOutput("gitleaks", bad({ StartLine: 0 }), ctx)).toThrow(ParseError);
    expect(parseToolOutput("gitleaks", bad({ EndLine: 4 }), ctx)[0]?.endLine).toBe(4);
  });
});

describe("hostile or broken output", () => {
  it("drops paths outside the stage and invalid rules or lines", () => {
    const out = JSON.stringify({
      comments: [
        { file: "/etc/passwd", line: 1, code: 1000, message: "x" },
        { file: "/stage/../etc/passwd", line: 1, code: 1000, message: "x" },
        { file: "/stagex/a.sh", line: 1, code: 1000, message: "x" },
        { file: "/stage/a.sh", line: 0, code: 1000, message: "x" },
        { file: "/stage/a.sh", line: 1, code: "1000; rm", message: "x" },
        { file: "/stage/a.sh", line: 1, code: 2086, message: "ok" },
      ],
    });
    expect(parseToolOutput("shellcheck", out, ctx).map((h) => h.path)).toEqual(["a.sh"]);
  });

  it("redacts and caps messages", () => {
    const token = `ghp_${"x".repeat(36)}`;
    const out = JSON.stringify([{ code: "DL3006", file: "/stage/Dockerfile", line: 1, level: "warning", message: `${token} ${"y".repeat(900)}` }]);
    const [hit] = parseToolOutput("hadolint", out, ctx);
    expect(hit?.message).not.toContain(token);
    expect(hit?.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it.each(["shellcheck", "actionlint", "hadolint", "zizmor", "ruff", "squawk", "gitleaks"] as const)(
    "%s: non-JSON output is a ParseError",
    (tool) => {
      expect(() => parseToolOutput(tool, "Segmentation fault", ctx)).toThrow(ParseError);
    },
  );

  it("yamllint: an unexpected line is a ParseError; empty output is no hits", () => {
    expect(() => parseToolOutput("yamllint", "Traceback (most recent call last):", ctx)).toThrow(ParseError);
    expect(parseToolOutput("yamllint", "", ctx)).toEqual([]);
  });
});

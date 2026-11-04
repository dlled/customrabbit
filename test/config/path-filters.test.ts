import { describe, expect, it } from "vitest";

import { compilePathFilter, DEFAULT_PATH_FILTERS, partitionPaths } from "../../src/config/path-filters.js";
import {
  applicableRules,
  indexInstructions,
  instructionsFor,
} from "../../src/config/path-instructions.js";
import type { StyleGuide } from "../../src/config/style-guide.js";

describe("DEFAULT_PATH_FILTERS", () => {
  it("are all exclusions, unique, and include CodeRabbit's well-known entries", () => {
    expect(DEFAULT_PATH_FILTERS.every((p) => p.startsWith("!"))).toBe(true);
    expect(new Set(DEFAULT_PATH_FILTERS).size).toBe(DEFAULT_PATH_FILTERS.length);
    for (const p of ["!**/dist/**", "!**/node_modules/**", "!**/*.lock", "!**/package-lock.json", "!**/__generated__/**"]) {
      expect(DEFAULT_PATH_FILTERS).toContain(p);
    }
  });

  it("leave out generated/ and gen/ (lead decision: hand-edited code there must be reviewed)", () => {
    expect(DEFAULT_PATH_FILTERS).not.toContain("!**/generated/**");
    expect(DEFAULT_PATH_FILTERS).not.toContain("!**/gen/**");
    const f = compilePathFilter([]);
    expect(f.matches("src/generated/api.ts")).toBe(true);
    expect(f.matches("proto/gen/x.go")).toBe(true);
    const g = compilePathFilter(["!**/generated/**", "!**/gen/**"]);
    expect(g.matches("src/generated/api.ts")).toBe(false);
    expect(g.matches("proto/gen/x.go")).toBe(false);
  });
});

describe("compilePathFilter: defaults only", () => {
  const f = compilePathFilter([]);

  it.each([
    "dist/main.js",
    "packages/a/dist/index.js",
    "node_modules/x/index.js",
    "package-lock.json",
    "web/yarn.lock",
    "uv.lock",
    "Cargo.lock",
    "src/__generated__/api.ts",
    "src/foo.generated.ts",
    "api/v1/x.pb.go",
    "assets/logo.png",
    "public/app.min.js",
    "static/main.0a1b2c3d.chunk.js",
    "web/assets/index-abcd1234.js",
    ".github/dist/x.js",
    ".DS_Store",
    "docs/report.pdf",
    "data/rows.csv",
  ])("excludes %s", (p) => {
    expect(f.matches(p)).toBe(false);
  });

  it.each([
    "src/index.ts",
    "README.md",
    ".github/workflows/ci.yml",
    ".myrabbit.yaml",
    "distribution/notes.md",
    "src/generator.ts",
    "static/main.short.chunk.js",
    "package.json",
  ])("reviews %s", (p) => {
    expect(f.matches(p)).toBe(true);
  });

  it("accepts a leading ./", () => {
    expect(f.matches("./dist/a.js")).toBe(false);
    expect(f.matches("./src/a.ts")).toBe(true);
  });
});

describe("compilePathFilter: user filters", () => {
  it("adds user exclusions", () => {
    const f = compilePathFilter(["!**/fixtures/**"]);
    expect(f.matches("test/fixtures/a.json")).toBe(false);
    expect(f.matches("test/a.test.ts")).toBe(true);
    expect(f.includes).toEqual([]);
  });

  it("turns into an allowlist when any include is present", () => {
    const f = compilePathFilter(["src/**"]);
    expect(f.matches("src/a.ts")).toBe(true);
    expect(f.matches("README.md")).toBe(false);
  });

  it("lets exclusions win regardless of order", () => {
    for (const filters of [["src/**", "!src/legacy/**"], ["!src/legacy/**", "src/**"]]) {
      const f = compilePathFilter(filters);
      expect(f.matches("src/a.ts")).toBe(true);
      expect(f.matches("src/legacy/a.ts")).toBe(false);
    }
  });

  it("does not let a broad include override a default exclusion", () => {
    const f = compilePathFilter(["src/**"]);
    expect(f.matches("src/dist/a.js")).toBe(false);
  });

  it("re-enables one default by its exact pattern, without making an allowlist", () => {
    const f = compilePathFilter(["**/*.csv"]);
    expect(f.matches("data/rows.csv")).toBe(true);
    expect(f.matches("src/a.ts")).toBe(true);
    expect(f.matches("data/rows.tsv")).toBe(false);
    expect(f.includes).toEqual([]);
    expect(f.excludes).not.toContain("**/*.csv");
  });

  it("keeps a default excluded when it is both re-enabled and excluded", () => {
    const f = compilePathFilter(["**/*.csv", "!**/*.csv"]);
    expect(f.matches("data/rows.csv")).toBe(false);
  });

  it("re-enabling one lockfile pattern does not re-enable *.lock files", () => {
    const f = compilePathFilter(["**/yarn.lock"]);
    expect(f.matches("yarn.lock")).toBe(false);
    const g = compilePathFilter(["**/yarn.lock", "**/*.lock"]);
    expect(g.matches("yarn.lock")).toBe(true);
  });

  it("can review nothing, like CodeRabbit's documented pitfall", () => {
    const f = compilePathFilter(["!**/*.json", "**/package.json"]);
    expect(f.matches("package.json")).toBe(false);
    expect(f.matches("src/a.ts")).toBe(false);
  });

  it("treats '#' and '!' inside globs literally rather than as comments or double negation", () => {
    const f = compilePathFilter(["!#notes/**"]);
    expect(f.matches("#notes/a.md")).toBe(false);
    expect(f.matches("notes/a.md")).toBe(true);
  });
});

describe("partitionPaths", () => {
  it("splits paths in input order and names the exclusion that filtered each one", () => {
    const f = compilePathFilter(["!docs/**"]);
    expect(partitionPaths(["b.ts", "docs/x.md", "dist/y.js", "a.ts", "web/yarn.lock"], f)).toEqual({
      reviewed: ["b.ts", "a.ts"],
      filtered: [
        { path: "docs/x.md", reason: "excluded", pattern: "!docs/**" },
        { path: "dist/y.js", reason: "excluded", pattern: "!**/dist/**" },
        { path: "web/yarn.lock", reason: "excluded", pattern: "!**/yarn.lock" },
      ],
    });
  });

  it("reports allowlist misses as not_included, and exclusions first", () => {
    const f = compilePathFilter(["src/**"]);
    expect(partitionPaths(["src/a.ts", "README.md", "src/dist/x.js"], f)).toEqual({
      reviewed: ["src/a.ts"],
      filtered: [
        { path: "README.md", reason: "not_included", pattern: null },
        { path: "src/dist/x.js", reason: "excluded", pattern: "!**/dist/**" },
      ],
    });
  });

  it("uses the default filters when no filter is given", () => {
    expect(partitionPaths(["a.ts", "node_modules/x.js"])).toEqual({
      reviewed: ["a.ts"],
      filtered: [{ path: "node_modules/x.js", reason: "excluded", pattern: "!**/node_modules/**" }],
    });
  });

  it("agrees with matches() and excludedBy()", () => {
    const f = compilePathFilter(["src/**", "!src/legacy/**"]);
    const paths = ["src/a.ts", "src/legacy/b.ts", "README.md", "src/x.png"];
    const { reviewed } = f.partition(paths);
    expect(reviewed).toEqual(paths.filter((p) => f.matches(p)));
    expect(f.excludedBy("src/legacy/b.ts")).toBe("!src/legacy/**");
    expect(f.excludedBy("README.md")).toBeNull();
  });
});

describe("path_instructions", () => {
  const instructions = indexInstructions([
    { path: "src/**/*.ts", instructions: "ts rules" },
    { path: "**/*.yml", instructions: "yaml rules" },
    { path: "!**/*.test.ts", instructions: "non-test rules" },
  ]);

  it("assigns ids in config order", () => {
    expect(instructions.map((i) => i.id)).toEqual(["P1", "P2", "P3"]);
  });

  it("matches with minimatch, including dot directories and negation", () => {
    expect(instructionsFor("src/a/b.ts", instructions).map((i) => i.id)).toEqual(["P1", "P3"]);
    expect(instructionsFor("src/a/b.test.ts", instructions).map((i) => i.id)).toEqual(["P1"]);
    expect(instructionsFor(".github/workflows/ci.yml", instructions).map((i) => i.id)).toEqual(["P2", "P3"]);
    expect(instructionsFor("lib/a.ts", instructions).map((i) => i.id)).toEqual(["P3"]);
  });

  it("builds the per-file rule map for the prompt", () => {
    const guide = (id: string, scope: string[]): StyleGuide => ({
      id,
      path: `${id}.md`,
      origin: "auto",
      scope,
      content: "x",
      originalChars: 1,
      truncated: false,
    });
    const guides = [guide("G1", ["**"]), guide("G2", ["src/**"]), guide("G3", ["web/**/*.tsx"])];
    const rules = applicableRules(["src/a.ts", "web/c/d.tsx", "README.md"], guides, instructions);
    expect(rules.get("src/a.ts")).toEqual({ guides: ["G1", "G2"], instructions: ["P1", "P3"] });
    expect(rules.get("web/c/d.tsx")).toEqual({ guides: ["G1", "G3"], instructions: ["P3"] });
    expect(rules.get("README.md")).toEqual({ guides: ["G1"], instructions: ["P3"] });
  });
});

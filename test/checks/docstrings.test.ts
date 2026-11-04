// §5.1 docstring coverage over real fixture repositories (base + head commits, the v1 diff code,
// git blobs only), one per language convention. Offline.

import { afterEach, describe, expect, it } from "vitest";

import { docstringCoverage, docstringResult, fileDocstrings } from "../../src/checks/docstrings.js";
import { mergeBaseDiff } from "../../src/github/git.js";
import { fixtureRepo, type FileSpec, type FixtureRepo } from "../context/helpers.js";

let repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos) r.cleanup();
  repos = [];
});

async function coverage(base: Record<string, FileSpec>, head: Record<string, FileSpec>, threshold = 80) {
  const repo = fixtureRepo(base, head);
  repos.push(repo);
  const diff = await mergeBaseDiff(repo.git, repo.base, repo.head);
  return docstringCoverage({ git: repo.git, headSha: repo.head, files: diff.files, threshold });
}

/** Counts for one added file. */
async function counts(path: string, text: string) {
  const repo = fixtureRepo({}, { [path]: text });
  repos.push(repo);
  const diff = await mergeBaseDiff(repo.git, repo.base, repo.head);
  const file = diff.files[0];
  if (!file) throw new Error("no diff");
  return fileDocstrings(file, text);
}

describe("per-language conventions", () => {
  it("TS: /** */ before the function, its export or decorators; not // or a blank line", async () => {
    const text = [
      "/** Adds. */",
      "export function add(a: number, b: number) { return a + b; }",
      "",
      "// not a doc comment",
      "function sub(a: number, b: number) { return a - b; }",
      "",
      "/** Detached. */",
      "",
      "function mul(a: number, b: number) { return a * b; }",
      "",
      "export class K {",
      "  /** Documented method. */",
      "  run() {}",
      "  stop() {}",
      "}",
      "",
    ].join("\n");
    const r = await counts("src/a.ts", text);
    expect(r).toMatchObject({ total: 5, documented: 2 });
    expect(r?.missing.map((m) => m.name)).toEqual(["sub", "mul", "stop"]);
  });

  it("Python: a string as the first statement of the body", async () => {
    const text = [
      "def documented():",
      '    """Says hi."""',
      "    return 1",
      "",
      "def plain():",
      "    return 2",
      "",
      "@decorator",
      "def decorated():",
      "    # a comment first",
      "    'Single-quoted docstring.'",
      "    return 3",
      "",
      "class C:",
      "    def method(self):",
      "        x = 'not a docstring'",
      "        return x",
      "",
    ].join("\n");
    const r = await counts("pkg/m.py", text);
    expect(r).toMatchObject({ total: 4, documented: 2 });
    expect(r?.missing.map((m) => m.name).sort()).toEqual(["method", "plain"]);
  });

  it("Go: a comment right before the declaration", async () => {
    const text = [
      "package p",
      "",
      "// Add adds.",
      "func Add(a, b int) int { return a + b }",
      "",
      "func Sub(a, b int) int { return a - b }",
      "",
      "type T struct{}",
      "",
      "// Run runs.",
      "func (t T) Run() {}",
      "",
    ].join("\n");
    expect(await counts("p/p.go", text)).toMatchObject({ total: 3, documented: 2 });
  });

  it("Rust: /// or #[doc] before the item, attributes allowed in between; // and //// are not docs", async () => {
    const text = [
      "/// Adds.",
      "#[inline]",
      "pub fn add(a: i32, b: i32) -> i32 { a + b }",
      "",
      '#[doc = "Subtracts."]',
      "pub fn sub(a: i32, b: i32) -> i32 { a - b }",
      "",
      "// plain comment",
      "pub fn mul(a: i32, b: i32) -> i32 { a * b }",
      "",
      "//// four slashes",
      "pub fn div(a: i32, b: i32) -> i32 { a / b }",
      "",
    ].join("\n");
    const r = await counts("src/lib.rs", text);
    expect(r).toMatchObject({ total: 4, documented: 2 });
    expect(r?.missing.map((m) => m.name)).toEqual(["mul", "div"]);
  });

  it("unsupported languages are skipped (null)", async () => {
    expect(await counts("x.sh", "f() {\n  echo hi\n}\n")).toBeNull();
    expect(await counts("README.md", "# hi\n")).toBeNull();
  });
});

describe("denominator: functions the diff adds or whose signature it changes", () => {
  const base = [
    "export function keep(a: number) {",
    "  return a;",
    "}",
    "",
    "export function resign(a: number) {",
    "  return a;",
    "}",
    "",
  ].join("\n");

  it("a body-only change does not count; a signature change does", async () => {
    const head = [
      "export function keep(a: number) {",
      "  return a + 1;",
      "}",
      "",
      "export function resign(a: number, b: number) {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const r = await coverage({ "src/a.ts": base }, { "src/a.ts": head });
    expect(r).toMatchObject({ status: "fail", total: 1, documented: 0 });
    expect(r.explanation).toContain("resign (src/a.ts:5)");
  });

  it("nothing to count is inconclusive", async () => {
    const head = base.replace("return a;", "return a * 2;");
    expect(await coverage({ "src/a.ts": base }, { "src/a.ts": head })).toMatchObject({ status: "inconclusive", total: 0 });
    expect(await coverage({}, { "run.sh": "f() { :; }\n", "README.md": "x\n" })).toMatchObject({ status: "inconclusive" });
  });

  it("deleted files and unchanged files are not read", async () => {
    const r = await coverage({ "src/a.ts": base, "src/b.py": "def f():\n    return 1\n" }, { "src/b.py": null });
    expect(r).toMatchObject({ status: "inconclusive", total: 0 });
  });
});

describe("threshold", () => {
  const f = (total: number, documented: number) => ({ total, documented, missing: [] });

  it("passes at or above the threshold, fails below", () => {
    expect(docstringResult([f(5, 4)], 80).status).toBe("pass");
    expect(docstringResult([f(3, 2)], 67).status).toBe("fail");
    expect(docstringResult([f(3, 2)], 66).status).toBe("pass");
    expect(docstringResult([f(1, 0)], 0).status).toBe("pass");
    expect(docstringResult([f(4, 4)], 100).status).toBe("pass");
  });

  it("sums across files and lists at most 5 undocumented names", () => {
    const missing = Array.from({ length: 7 }, (_, i) => ({ path: "a.ts", name: `f${i}`, line: i + 1 }));
    const r = docstringResult([{ total: 7, documented: 0, missing }, f(3, 3)], 80);
    expect(r).toMatchObject({ status: "fail", total: 10, documented: 3 });
    expect(r.explanation).toBe(
      "Docstring coverage 30% (3 of 10 added or changed functions), threshold 80%. " +
        "Undocumented: f0 (a.ts:1), f1 (a.ts:2), f2 (a.ts:3), f3 (a.ts:4), f4 (a.ts:5), and 2 more.",
    );
  });
});

describe("blob-only reads", () => {
  it("a symlink at head is not followed", async () => {
    const r = await coverage({}, { "src/link.ts": { link: "/etc/passwd" }, "src/real.ts": "export function x() {}\n" });
    expect(r).toMatchObject({ total: 1, documented: 0 });
  });
});

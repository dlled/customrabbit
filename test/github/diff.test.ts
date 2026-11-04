import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AnchorMap, DiffParseError, parseUnifiedDiff, unquoteGitPath } from "../../src/github/diff.js";

const fixture = readFileSync(new URL("./fixtures/pr.diff", import.meta.url), "utf8");

describe("parseUnifiedDiff (real git output fixture)", () => {
  const files = parseUnifiedDiff(fixture);
  const byPath = new Map(files.map((f) => [f.path, f]));

  it("finds every file with its status", () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["gone.txt", "deleted", false],
      ["img.bin", "modified", true],
      ["moved-to.md", "renamed", false],
      ["new.ts", "added", false],
      ["nonl.txt", "added", false],
      ["src.ts", "modified", false],
      ["with space.txt", "modified", false],
      ["ünï.txt", "added", false],
    ]);
    expect(byPath.get("moved-to.md")?.oldPath).toBe("moved-from.md");
  });

  it("numbers hunk lines on both sides", () => {
    const src = byPath.get("src.ts");
    expect(src?.hunks).toHaveLength(2);
    expect(src?.hunks[1]?.lines.find((l) => l.kind === "add")).toEqual({
      kind: "add",
      oldLine: null,
      newLine: 19,
      text: "added after 18",
    });
    expect(src?.additions).toBe(2);
    expect(src?.deletions).toBe(1);
    expect(src?.bytes).toBe(Buffer.byteLength(src?.patch ?? "", "utf8"));
  });

  it("handles '\\ No newline at end of file'", () => {
    expect(byPath.get("nonl.txt")?.hunks[0]?.lines).toEqual([
      { kind: "add", oldLine: null, newLine: 1, text: "no newline" },
    ]);
  });

  it("concatenated patches reproduce the input", () => {
    expect(files.map((f) => f.patch).join("")).toBe(fixture);
  });

  it("returns [] for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("rejects malformed input", () => {
    expect(() => parseUnifiedDiff("garbage\n")).toThrow(DiffParseError);
    const truncated = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n";
    expect(() => parseUnifiedDiff(truncated)).toThrow(/truncated hunk/);
    const extra = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n";
    expect(() => parseUnifiedDiff(extra)).toThrow(DiffParseError);
  });

  it("treats a blank line inside a hunk as context (diff.suppressBlankEmpty)", () => {
    const d = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n\n+n\n a\n";
    expect(parseUnifiedDiff(d)[0]?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["context", "add", "context"]);
  });

  it("gets the path of a pure rename without hunks", () => {
    const d = "diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\n";
    expect(parseUnifiedDiff(d)[0]).toMatchObject({ path: "new name", oldPath: "old name", status: "renamed", hunks: [] });
  });

  it("gets the path of a mode-only change", () => {
    const d = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n";
    expect(parseUnifiedDiff(d)[0]).toMatchObject({ path: "run.sh", status: "modified" });
  });
});

describe("unquoteGitPath", () => {
  it("decodes C-style quoting", () => {
    expect(unquoteGitPath('"b/\\303\\274n\\303\\257.txt"')).toBe("b/ünï.txt");
    expect(unquoteGitPath('"a/tab\\there \\"q\\""')).toBe('a/tab\there "q"');
    expect(unquoteGitPath("plain")).toBe("plain");
    expect(() => unquoteGitPath('"a/\\q"')).toThrow(DiffParseError);
  });
});

describe("AnchorMap", () => {
  const anchors = new AnchorMap(parseUnifiedDiff(fixture));

  it("RIGHT = added + context, LEFT = deleted", () => {
    expect(anchors.lines("src.ts", "RIGHT")).toEqual([1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21]);
    expect(anchors.lines("src.ts", "LEFT")).toEqual([2]);
    expect(anchors.has("gone.txt", "LEFT", 1)).toBe(true);
    expect(anchors.has("gone.txt", "RIGHT", 1)).toBe(false);
    expect(anchors.has("src.ts", "RIGHT", 10)).toBe(false);
  });

  it("validates single lines and ranges", () => {
    expect(anchors.check({ path: "src.ts", side: "RIGHT", startLine: 2, endLine: 2 })).toEqual({ ok: true, hunk: 0 });
    expect(anchors.check({ path: "src.ts", side: "RIGHT", startLine: 16, endLine: 21 })).toEqual({ ok: true, hunk: 1 });
    expect(anchors.check({ path: "src.ts", side: "RIGHT", startLine: 4, endLine: 17 })).toEqual({
      ok: false,
      reason: "crosses_hunks",
    });
    expect(anchors.check({ path: "src.ts", side: "RIGHT", startLine: 9, endLine: 9 })).toEqual({
      ok: false,
      reason: "not_in_diff",
    });
    expect(anchors.check({ path: "src.ts", side: "LEFT", startLine: 3, endLine: 3 })).toEqual({
      ok: false,
      reason: "not_in_diff",
    });
    expect(anchors.check({ path: "src.ts", side: "RIGHT", startLine: 5, endLine: 4 })).toEqual({
      ok: false,
      reason: "bad_range",
    });
    expect(anchors.check({ path: "img.bin", side: "RIGHT", startLine: 1, endLine: 1 })).toEqual({
      ok: false,
      reason: "binary",
    });
    expect(anchors.check({ path: "nope.ts", side: "RIGHT", startLine: 1, endLine: 1 })).toEqual({
      ok: false,
      reason: "unknown_path",
    });
  });

  it("lists text files only", () => {
    expect(anchors.paths()).not.toContain("img.bin");
    expect(anchors.hasPath("with space.txt")).toBe(true);
    expect(anchors.hasPath("ünï.txt")).toBe(true);
  });

  it("tuples() lists every anchor as { path, side, line, hunk } (src/merge AnchorTuple)", () => {
    const t = anchors.tuples();
    expect(t).toContainEqual({ path: "src.ts", side: "RIGHT", line: 19, hunk: 1 });
    expect(t).toContainEqual({ path: "src.ts", side: "LEFT", line: 2, hunk: 0 });
    expect(t.filter((x) => x.path === "src.ts")).toHaveLength(12);
    expect(t.some((x) => x.path === "img.bin")).toBe(false);
  });

  it("isAnchored(path, side, line, endLine) mirrors check() (src/merge AnchorMap)", () => {
    expect(anchors.isAnchored("src.ts", "RIGHT", 16, 21)).toBe(true);
    expect(anchors.isAnchored("src.ts", "RIGHT", 2, null)).toBe(true);
    expect(anchors.isAnchored("src.ts", "RIGHT", 4, 17)).toBe(false);
    expect(anchors.isAnchored("img.bin", "RIGHT", 1, null)).toBe(false);
  });
});

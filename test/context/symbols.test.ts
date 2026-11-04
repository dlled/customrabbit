import { describe, expect, it } from "vitest";

import { inCommentOrString, languageFor, loadLanguage, type LanguageId } from "../../src/context/languages.js";
import { changedLines, changedSymbols, definitions, isFollowable } from "../../src/context/symbols.js";
import { importsFile, isTestPath } from "../../src/context/usages.js";
import { parseUnifiedDiff } from "../../src/github/diff.js";

async function defsOf(id: LanguageId, text: string) {
  const lang = await loadLanguage(id);
  if (!lang) throw new Error(`grammar ${id} did not load`);
  const tree = lang.parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return definitions(lang, tree.rootNode);
  } finally {
    tree.delete();
  }
}

describe("languages", () => {
  it("maps extensions to grammars, else the text fallback", () => {
    expect(languageFor("a/b.ts")).toBe("typescript");
    expect(languageFor("a/b.tsx")).toBe("tsx");
    expect(languageFor("b.mjs")).toBe("javascript");
    expect(languageFor("b.py")).toBe("python");
    expect(languageFor("b.go")).toBe("go");
    expect(languageFor("b.rs")).toBe("rust");
    expect(languageFor("b.sh")).toBe("bash");
    expect(languageFor("b.yml")).toBeNull();
    expect(languageFor(".bashrc")).toBeNull();
    expect(languageFor("Makefile")).toBeNull();
  });

  it("loads every grammar from the lockfile", async () => {
    for (const id of ["typescript", "tsx", "javascript", "python", "go", "rust", "bash"] as const) {
      const lang = await loadLanguage(id);
      expect(lang?.queries.length, id).toBeGreaterThan(0);
    }
  });

  it("finds comments and strings by JS index, also after non-ASCII text", async () => {
    const lang = await loadLanguage("typescript");
    const text = 'const é = "naïve foo"; // ünïcode foo\nfoo(é);\nconst t = `${foo}`;\n';
    const tree = lang?.parser.parse(text);
    if (!tree) throw new Error("parse failed");
    const at = (needle: string, from = 0) => text.indexOf(needle, from);
    expect(inCommentOrString(tree.rootNode, at("foo"))).toBe(true); // in the string
    expect(inCommentOrString(tree.rootNode, at("foo", at("//")))).toBe(true); // in the comment
    expect(inCommentOrString(tree.rootNode, at("foo(é)"))).toBe(false);
    expect(inCommentOrString(tree.rootNode, at("${foo}") + 2)).toBe(false); // template substitution
    tree.delete();
  });
});

describe("definitions", () => {
  it("TypeScript: functions, classes, methods, types, exported constants", async () => {
    const defs = await defsOf(
      "typescript",
      "export function f(a: number) {\n  return a;\n}\nclass K {\n  m() {}\n}\nexport type T = number;\nexport const LIMIT = 3;\nexport const g = () => 1;\ninterface I {}\n",
    );
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(by.f).toMatchObject({ kind: "function", exported: true, startLine: 1, endLine: 3, signatureEnd: 1 });
    expect(by.K).toMatchObject({ kind: "class", exported: false });
    expect(by.m).toMatchObject({ kind: "method" });
    expect(by.T).toMatchObject({ kind: "type", exported: true });
    expect(by.LIMIT).toMatchObject({ kind: "constant", exported: true });
    expect(by.g).toMatchObject({ kind: "function", exported: true });
    expect(by.I).toMatchObject({ kind: "interface" });
  });

  it("export rules per language", async () => {
    const py = await defsOf("python", "def public():\n    def inner():\n        pass\n\ndef _private():\n    pass\n");
    expect(py.map((d) => [d.name, d.exported])).toEqual([["public", true], ["inner", false], ["_private", false]]);
    const go = await defsOf("go", "package m\nfunc Pub() {}\nfunc priv() {}\nconst Max = 1\n");
    expect(go.map((d) => [d.name, d.exported])).toEqual([["Pub", true], ["priv", false], ["Max", true]]);
    const rs = await defsOf("rust", "pub fn a() {}\nfn b() {}\npub const C: u8 = 1;\n");
    expect(rs.map((d) => [d.name, d.exported])).toEqual([["a", true], ["b", false], ["C", true]]);
  });
});

describe("changedSymbols", () => {
  const diff = (patch: string) => {
    const f = parseUnifiedDiff(patch)[0];
    if (!f) throw new Error("no file");
    return f;
  };

  it("removing a whole function does not mark the next one", async () => {
    const base = "def gone():\n    return 1\n\n\ndef stay():\n    return 0\n";
    const head = "def stay():\n    return 0\n";
    const file = diff(
      "diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,6 +1,2 @@\n-def gone():\n-    return 1\n-\n-\n def stay():\n     return 0\n",
    );
    expect(changedLines(file).gaps).toEqual([]);
    const syms = changedSymbols(file, "python", await defsOf("python", head), await defsOf("python", base));
    expect(syms.map((s) => [s.name, s.deleted])).toEqual([["gone", true]]);
  });

  it("a deletion inside a body marks the enclosing definition", async () => {
    const head = "def work():\n    a = 1\n    return a\n";
    const base = "def work():\n    a = 1\n    log(a)\n    return a\n";
    const file = diff(
      "diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,4 +1,3 @@\n def work():\n     a = 1\n-    log(a)\n     return a\n",
    );
    const syms = changedSymbols(file, "python", await defsOf("python", head), await defsOf("python", base));
    expect(syms.map((s) => [s.name, s.signatureChanged, s.deleted])).toEqual([["work", false, false]]);
  });

  it("skips generic names", () => {
    expect(isFollowable("formatPrice")).toBe(true);
    expect(isFollowable("id")).toBe(false);
    expect(isFollowable("constructor")).toBe(false);
    expect(isFollowable("has space")).toBe(false);
  });
});

describe("ranking helpers", () => {
  it("detects importers of the changed file", () => {
    expect(importsFile('import { a } from "./lib";\n', "src/lib.ts")).toBe(true);
    expect(importsFile("from app.billing import x\n", "app/billing.py")).toBe(true);
    expect(importsFile('import "example.com/m/pkg/calc"\n', "pkg/calc/calc.go")).toBe(true);
    expect(importsFile('import { a } from "./library";\n', "src/lib.ts")).toBe(false);
    expect(importsFile("const lib = 1;\n", "src/lib.ts")).toBe(false);
  });

  it("detects test paths", () => {
    for (const p of ["test/a.ts", "src/__tests__/a.ts", "a.test.ts", "a_test.go", "tests/test_a.py", "a.spec.js"]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src/testing.ts", "latest/a.ts"]) expect(isTestPath(p), p).toBe(false);
  });
});

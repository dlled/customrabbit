// §5.1 docstring coverage, computed in code from the §3 parse (src/context, imported only). No model
// call.
//
// Denominator: the functions and methods the diff adds or whose signature it changes, i.e. head
// definitions of kind function/method with an added line between their first line and the end of
// their signature. Files are read as git blobs only (§1.1). A definition counts as documented when
// the grammar's convention attaches a doc comment to it:
// - TS/JS: a `/** … */` comment right before it (or its `export`), decorators allowed in between;
// - Python: a string literal as the first statement of the body (PEP 257);
// - Go: a comment right before the declaration (Go doc comments);
// - Rust: `///` / `/** … */` outer doc comments or `#[doc = …]` right before the item, attributes
//   allowed in between.
// Other languages (bash, text) are skipped. With nothing to count the result is `inconclusive`.

import type * as TreeSitter from "web-tree-sitter";

import { listTree } from "../context/git.js";
import { languageFor, loadLanguage, type LanguageId } from "../context/languages.js";
import { changedLines, definitions, type Definition } from "../context/symbols.js";
import type { DiffFile } from "../github/diff.js";
import type { GitRunner } from "../github/git.js";
import type { CheckStatus } from "../types.js";

/** Languages with a doc-comment convention the check knows. */
export const DOCSTRING_LANGUAGES: readonly LanguageId[] = ["typescript", "tsx", "javascript", "python", "go", "rust"];
/** At most this many undocumented names are listed in the explanation. */
export const MAX_LISTED_MISSING = 5;

const COUNTED_KINDS = new Set(["function", "method"]);

export interface MissingDoc {
  path: string;
  name: string;
  line: number;
}

export interface FileDocstrings {
  total: number;
  documented: number;
  missing: MissingDoc[];
}

export interface DocstringResult {
  status: CheckStatus;
  explanation: string;
  total: number;
  documented: number;
}

/** Wrappers that sit between a definition and the comment documenting it. */
const WRAPPERS = new Set(["export_statement", "decorated_definition"]);
/** Siblings that may sit between a doc comment and the item. */
const SKIPPABLE = new Set(["decorator", "attribute_item"]);

function defNode(root: TreeSitter.Node, d: Definition): TreeSitter.Node | null {
  let n: TreeSitter.Node | null = root.descendantForIndex(d.nameIndex);
  let found: TreeSitter.Node | null = null;
  for (; n; n = n.parent) {
    if (n.startPosition.row + 1 === d.startLine && n.endPosition.row + 1 === d.endLine) found = n;
    else if (found) break;
  }
  if (!found) return null;
  while (found.parent && WRAPPERS.has(found.parent.type)) found = found.parent;
  return found;
}

function isDocComment(lang: LanguageId, c: TreeSitter.Node): boolean {
  const t = c.text;
  switch (lang) {
    case "typescript":
    case "tsx":
    case "javascript":
      return c.type === "comment" && t.startsWith("/**") && !t.startsWith("/**/");
    case "go":
      return c.type === "comment";
    case "rust":
      if (c.type === "attribute_item") return /^#\[\s*doc\b/.test(t);
      if (c.type === "line_comment") return t.startsWith("///") && !t.startsWith("////");
      return c.type === "block_comment" && t.startsWith("/**") && !t.startsWith("/**/");
    default:
      return false;
  }
}

function hasLeadingDoc(lang: LanguageId, node: TreeSitter.Node): boolean {
  let top = node.startPosition.row;
  for (let s = node.previousSibling; s; s = s.previousSibling) {
    // Attached means no blank line between the comment (or skipped attribute) and the item.
    if (s.endPosition.row < top - 1) return false;
    if (isDocComment(lang, s)) return true;
    if (!SKIPPABLE.has(s.type)) return false;
    top = s.startPosition.row;
  }
  return false;
}

function hasPythonDocstring(node: TreeSitter.Node): boolean {
  const fn = node.type === "decorated_definition" ? node.childForFieldName("definition") : node;
  const body = fn?.childForFieldName("body");
  if (!body) return false;
  for (const stmt of body.namedChildren) {
    if (stmt.type === "comment") continue;
    return stmt.type === "expression_statement" && stmt.firstNamedChild?.type === "string";
  }
  return false;
}

function documented(lang: LanguageId, root: TreeSitter.Node, d: Definition): boolean {
  const node = defNode(root, d);
  if (!node) return false;
  return lang === "python" ? hasPythonDocstring(node) : hasLeadingDoc(lang, node);
}

/**
 * Coverage of one file from its head text, or null when its language is not supported or the
 * grammar cannot be loaded.
 */
export async function fileDocstrings(file: DiffFile, text: string): Promise<FileDocstrings | null> {
  const id = languageFor(file.path);
  if (!id || !DOCSTRING_LANGUAGES.includes(id)) return null;
  const lang = await loadLanguage(id);
  if (!lang) return null;
  const tree = lang.parser.parse(text);
  if (!tree) return null;
  try {
    const { added } = changedLines(file);
    const out: FileDocstrings = { total: 0, documented: 0, missing: [] };
    for (const d of definitions(lang, tree.rootNode)) {
      if (!COUNTED_KINDS.has(d.kind)) continue;
      let touched = false;
      for (let l = d.startLine; l <= d.signatureEnd && !touched; l++) touched = added.has(l);
      if (!touched) continue;
      out.total++;
      if (documented(id, tree.rootNode, d)) out.documented++;
      else out.missing.push({ path: file.path, name: d.name, line: d.nameLine });
    }
    return out;
  } finally {
    tree.delete();
  }
}

/** The check result from per-file counts against `threshold` (percent). */
export function docstringResult(files: readonly FileDocstrings[], threshold: number): DocstringResult {
  const total = files.reduce((n, f) => n + f.total, 0);
  const doc = files.reduce((n, f) => n + f.documented, 0);
  if (total === 0) {
    return {
      status: "inconclusive",
      explanation: "No added or changed functions in a supported language (TS/JS, Python, Go, Rust).",
      total,
      documented: doc,
    };
  }
  const pct = Math.floor((doc * 100) / total);
  const pass = doc * 100 >= threshold * total;
  const missing = files.flatMap((f) => f.missing);
  const listed = missing.slice(0, MAX_LISTED_MISSING).map((m) => `${m.name} (${m.path}:${m.line})`);
  const more = missing.length > listed.length ? `, and ${missing.length - listed.length} more` : "";
  const head = `Docstring coverage ${pct}% (${doc} of ${total} added or changed functions), threshold ${threshold}%.`;
  return {
    status: pass ? "pass" : "fail",
    explanation: missing.length === 0 ? head : `${head} Undocumented: ${listed.join(", ")}${more}.`,
    total,
    documented: doc,
  };
}

export interface DocstringInput {
  git: GitRunner;
  headSha: string;
  /** Reviewed (filtered) files of the diff. */
  files: readonly DiffFile[];
  threshold: number;
}

/** §5.1 docstrings over the reviewed files, from head blobs. Never throws: a failure is inconclusive. */
export async function docstringCoverage(input: DocstringInput): Promise<DocstringResult> {
  try {
    const head = await listTree(input.git, input.headSha);
    const counts: FileDocstrings[] = [];
    for (const file of input.files) {
      if (file.binary || file.status === "deleted" || !head.has(file.path)) continue;
      if (!languageFor(file.path)) continue;
      const text = await head.read(file.path);
      if (text === null) continue;
      const c = await fileDocstrings(file, text);
      if (c) counts.push(c);
    }
    return docstringResult(counts, input.threshold);
  } catch {
    return { status: "inconclusive", explanation: "Docstring coverage could not be computed.", total: 0, documented: 0 };
  }
}

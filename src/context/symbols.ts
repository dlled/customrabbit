// Changed symbols (design-v2 §3.1 step 2): the enclosing definition of each hunk, plus definitions
// whose name or signature is on a changed line, from each grammar's tags query (`@definition.*`).
// Deleted definitions come from the base blob. YAML/JSON/TOML keys on changed lines are the text
// fallback.

import type * as TreeSitter from "web-tree-sitter";

import type { DiffFile } from "../github/diff.js";
import { isSafeName } from "./git.js";
import type { LanguageId, LoadedLanguage } from "./languages.js";

export interface Definition {
  name: string;
  /** From `@definition.<kind>`: function, method, class, interface, type, constant, … */
  kind: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  nameLine: number;
  /** JS string index of the name. */
  nameIndex: number;
  /** Last line of the signature (the line where the body starts, else the whole node). */
  signatureEnd: number;
  exported: boolean;
}

export type SymbolSide = "head" | "base";

export interface ChangedSymbol {
  name: string;
  kind: string;
  /** File the definition is in (head path, or the base path of a deleted definition). */
  path: string;
  side: SymbolSide;
  lang: LanguageId | null;
  def: Definition;
  exported: boolean;
  signatureChanged: boolean;
  /** Removed at head: every remaining usage is a broken caller. */
  deleted: boolean;
}

/** Names too generic to follow with a word search. */
const STOP_NAMES = new Set([
  "constructor", "init", "__init__", "main", "new", "default", "get", "set", "run", "test", "setup",
  "render", "toString", "value", "name", "type", "data", "error", "config", "options", "self", "this",
  "props", "state", "index", "key", "id", "args", "result", "description", "version", "true", "false",
]);

export function isFollowable(name: string): boolean {
  return name.length >= 3 && isSafeName(name) && !STOP_NAMES.has(name) && !/\s/.test(name);
}

function isExported(lang: LanguageId, def: TreeSitter.Node, name: string): boolean {
  switch (lang) {
    case "typescript":
    case "tsx":
    case "javascript": {
      for (let n: TreeSitter.Node | null = def; n; n = n.parent) if (n.type === "export_statement") return true;
      return false;
    }
    case "python": {
      if (name.startsWith("_")) return false;
      for (let n = def.parent; n; n = n.parent) if (n.type === "function_definition") return false;
      return true;
    }
    case "go":
      return /^\p{Lu}/u.test(name);
    case "rust":
      return def.children.some((c) => c.type === "visibility_modifier");
    case "bash":
      return true;
  }
}

/** All definitions in a parsed file, deduplicated by name position. */
export function definitions(lang: LoadedLanguage, root: TreeSitter.Node): Definition[] {
  const byName = new Map<number, Definition>();
  for (const q of lang.queries) {
    let matches: TreeSitter.QueryMatch[];
    try {
      matches = q.matches(root);
    } catch {
      continue;
    }
    for (const m of matches) {
      const defCap = m.captures.find((c) => c.name.startsWith("definition."));
      const nameCap = m.captures.find((c) => c.name === "name");
      if (!defCap || !nameCap) continue;
      const node = defCap.node;
      const nameNode = nameCap.node;
      const name = nameNode.text;
      if (!isSafeName(name) || byName.has(nameNode.startIndex)) continue;
      const body = node.childForFieldName("body");
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      byName.set(nameNode.startIndex, {
        name,
        kind: defCap.name.slice("definition.".length),
        startLine,
        endLine,
        nameLine: nameNode.startPosition.row + 1,
        nameIndex: nameNode.startIndex,
        signatureEnd: body ? Math.max(startLine, body.startPosition.row + 1) : endLine,
        exported: isExported(lang.id, node, name),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.startLine - b.startLine || a.nameIndex - b.nameIndex);
}

export interface ChangedLines {
  /** Head line numbers of added lines. */
  added: Set<number>;
  /** Base line numbers of deleted lines. */
  deleted: Set<number>;
  /**
   * Pure deletions as the head lines just before and just after them. The enclosing definition
   * counts as changed only when it contains both, so removing a whole function does not mark the
   * next one.
   */
  gaps: [before: number, after: number][];
}

export function changedLines(file: DiffFile): ChangedLines {
  const added = new Set<number>();
  const deleted = new Set<number>();
  const gaps: [number, number][] = [];
  for (const h of file.hunks) {
    let lastNew = 0;
    let pendingDel = false;
    let sawAdd = false;
    for (const l of h.lines) {
      if (l.kind === "add" && l.newLine !== null) {
        added.add(l.newLine);
        lastNew = l.newLine;
        sawAdd = true;
      } else if (l.kind === "del" && l.oldLine !== null) {
        deleted.add(l.oldLine);
        pendingDel = true;
      } else if (l.kind === "context" && l.newLine !== null) {
        if (pendingDel && !sawAdd && lastNew > 0) gaps.push([lastNew, l.newLine]);
        pendingDel = false;
        sawAdd = false;
        lastNew = l.newLine;
      }
    }
  }
  return { added, deleted, gaps };
}

function within(lines: Iterable<number>, from: number, to: number): boolean {
  for (const l of lines) if (l >= from && l <= to) return true;
  return false;
}

/** Innermost definition containing `line`. */
function innermost(defs: readonly Definition[], line: number): Definition | null {
  let best: Definition | null = null;
  for (const d of defs) {
    if (line < d.startLine || line > d.endLine) continue;
    if (!best || d.endLine - d.startLine < best.endLine - best.startLine) best = d;
  }
  return best;
}

/**
 * Changed symbols of one file from its head definitions (and base definitions, for removed names).
 * `headDefs` is empty for a deleted file; `baseDefs` is empty for an added file.
 */
export function changedSymbols(
  file: DiffFile,
  lang: LanguageId,
  headDefs: readonly Definition[],
  baseDefs: readonly Definition[],
  lines: ChangedLines = changedLines(file),
): ChangedSymbol[] {
  const out = new Map<string, ChangedSymbol>();
  const add = (s: ChangedSymbol) => {
    if (!isFollowable(s.name)) return;
    const prev = out.get(s.name);
    if (!prev || (s.signatureChanged && !prev.signatureChanged)) out.set(s.name, s);
  };

  for (const d of headDefs) {
    if (within(lines.added, d.startLine, d.signatureEnd)) {
      add({ name: d.name, kind: d.kind, path: file.path, side: "head", lang, def: d, exported: d.exported, signatureChanged: true, deleted: false });
    }
  }
  const enclosing: Definition[] = [];
  for (const line of lines.added) {
    const d = innermost(headDefs, line);
    if (d) enclosing.push(d);
  }
  for (const [before, after] of lines.gaps) {
    const d = innermost(headDefs, after);
    if (d && before >= d.startLine) enclosing.push(d);
  }
  for (const d of enclosing) {
    if (!out.has(d.name)) {
      add({ name: d.name, kind: d.kind, path: file.path, side: "head", lang, def: d, exported: d.exported, signatureChanged: false, deleted: false });
    }
  }
  const headNames = new Set(headDefs.map((d) => d.name));
  for (const d of baseDefs) {
    if (headNames.has(d.name)) continue;
    if (within(lines.deleted, d.startLine, d.signatureEnd)) {
      add({ name: d.name, kind: d.kind, path: file.oldPath, side: "base", lang, def: d, exported: d.exported, signatureChanged: true, deleted: true });
    }
  }
  return [...out.values()];
}

const CONFIG_EXT = /\.(?:ya?ml|json|jsonc|toml)$/i;
const KEY_LINE = /^\s*(?:-\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]/;

/** Text fallback: keys of YAML/JSON/TOML config on changed lines. */
export function changedConfigKeys(file: DiffFile): ChangedSymbol[] {
  if (!CONFIG_EXT.test(file.path)) return [];
  const out = new Map<string, ChangedSymbol>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "context") continue;
      const m = KEY_LINE.exec(l.text);
      const name = m?.[1];
      if (!name || !isFollowable(name) || out.has(name)) continue;
      const line = (l.kind === "add" ? l.newLine : l.oldLine) ?? 1;
      const side: SymbolSide = l.kind === "add" ? "head" : "base";
      out.set(name, {
        name,
        kind: "config-key",
        path: side === "head" ? file.path : file.oldPath,
        side,
        lang: null,
        def: { name, kind: "config-key", startLine: line, endLine: line, nameLine: line, nameIndex: -1, signatureEnd: line, exported: true },
        exported: true,
        signatureChanged: true,
        deleted: false,
      });
    }
  }
  return [...out.values()];
}

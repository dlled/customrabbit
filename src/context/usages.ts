// Definitions and usages (design-v2 §3.1 step 3): `git grep` hits over the head tree, without hits
// in comments and strings, ranked same directory > files importing the changed file > tests > others.

import { posix } from "node:path";

import type * as TreeSitter from "web-tree-sitter";

import { grepWord, type GrepHit, type TreeIndex } from "./git.js";
import { inCommentOrString, isTsLike, languageFor, loadLanguage } from "./languages.js";
import type { ChangedSymbol } from "./symbols.js";

export interface Usage {
  path: string;
  /** 1-based. */
  line: number;
  /** 0 same directory, 1 imports the changed file, 2 test, 3 other. */
  rank: number;
  /** The hit is on an import/use line: shown after call sites of the same rank. */
  importLine: boolean;
}

/** Most head files parsed for the comment/string filter in one run. */
export const MAX_PARSED_FILES = 300;

export class ParseCache {
  private readonly trees = new Map<string, Promise<TreeSitter.Tree | null>>();
  private parsed = 0;

  constructor(private readonly head: TreeIndex) {}

  /** The parse tree of a head file, or null (no grammar, unreadable, or over the parse cap). */
  tree(path: string): Promise<TreeSitter.Tree | null> {
    let p = this.trees.get(path);
    if (!p) {
      p = this.load(path);
      this.trees.set(path, p);
    }
    return p;
  }

  private async load(path: string): Promise<TreeSitter.Tree | null> {
    const id = languageFor(path);
    if (!id || this.parsed >= MAX_PARSED_FILES) return null;
    this.parsed++;
    const [lang, text] = await Promise.all([loadLanguage(id), this.head.read(path)]);
    if (!lang || text === null) return null;
    try {
      return lang.parser.parse(text);
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const p of this.trees.values()) void p.then((t) => t?.delete());
    this.trees.clear();
  }
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs|testdata|fixtures)\/|[._-](?:test|spec)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

const IMPORT_LINE = /^\s*(?:import\b|from\b|export\b.*\bfrom\b|.*\brequire\s*\(|use\b|source\b|\.\s|mod\b)/;

/** Module names a file is imported by: the file stem, or its directory for index/mod/Go files. */
function moduleNames(changedPath: string): string[] {
  const dir = posix.dirname(changedPath);
  const base = posix.basename(changedPath);
  const stem = base.replace(/\.[^.]+$/, "");
  const names = new Set<string>();
  // Entry files are imported by their directory (Rust lib.rs/mod.rs, JS index, Python __init__).
  const entry = /^(?:index|__init__|main)$/.test(stem) || (base.endsWith(".rs") && /^(?:lib|mod)$/.test(stem));
  if (stem && !entry) names.add(stem);
  if (dir !== "." && (entry || base.endsWith(".go"))) names.add(posix.basename(dir));
  return [...names].filter((n) => n.length >= 2);
}

/** True when `text` has an import-like line naming the changed file's module. */
export function importsFile(text: string, changedPath: string): boolean {
  const names = moduleNames(changedPath);
  if (names.length === 0) return false;
  const res = names.map((n) => new RegExp(`(?:^|[^\\w-])${escapeRegex(n)}(?:$|[^\\w-])`));
  for (const line of text.split("\n")) {
    if (line.length > 500 || !IMPORT_LINE.test(line)) continue;
    if (res.some((re) => re.test(line))) return true;
  }
  return false;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JS string index of each line start. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

const WORD = /[\p{L}\p{N}_$]/u;

/** Columns of `name` as a whole word in `line`. */
function wordColumns(line: string, name: string): number[] {
  const cols: number[] = [];
  for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
    const before = line.charAt(i - 1);
    const after = line.charAt(i + name.length);
    if ((before === "" || !WORD.test(before)) && (after === "" || !WORD.test(after))) cols.push(i);
  }
  return cols;
}

export interface UsageContext {
  git: Parameters<typeof grepWord>[0];
  head: TreeIndex;
  baseSha: string;
  parses: ParseCache;
  /** v1 path_filters: a hit outside the reviewed scope is dropped. */
  includePath: (path: string) => boolean;
  /** Head lines added by the diff, per path: hits there are already in the diff. */
  addedLines: ReadonlyMap<string, ReadonlySet<number>>;
  /** Paths of the reviewed diff (for the "outside the changed files" count). */
  changedPaths: ReadonlySet<string>;
}

export interface SymbolUsages {
  usages: Usage[];
  /** Usages found, before the per-symbol cap. */
  total: number;
  /** Usages outside the changed files (ordering key, §3.2). */
  outside: number;
}

/**
 * Hits of `sym` that are code, outside the diff's added lines and outside its own definition.
 * With `tsRefs` (TypeScript refinement finished for this symbol), grep hits in TS/JS files are
 * replaced by those references; grep still covers every other file type.
 */
export async function findUsages(
  ctx: UsageContext,
  sym: ChangedSymbol,
  tsRefs?: readonly { path: string; line: number }[],
): Promise<Usage[]> {
  let hits: { path: string; line: number; checked: boolean }[] = (
    await grepWord(ctx.git, ctx.head, sym.name, { attrSource: ctx.baseSha })
  ).map((h: GrepHit) => ({ path: h.path, line: h.line, checked: false }));
  if (tsRefs) {
    hits = [
      ...tsRefs.map((r) => ({ ...r, checked: true })),
      ...hits.filter((h) => !isTsLike(languageFor(h.path))),
    ];
  }
  const out: Usage[] = [];
  const seen = new Set<string>();
  const importCache = new Map<string, boolean>();
  for (const h of hits) {
    const key = `${h.path}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ctx.head.has(h.path) || !ctx.includePath(h.path)) continue;
    if (ctx.addedLines.get(h.path)?.has(h.line)) continue;
    if (sym.side === "head" && h.path === sym.path && h.line >= sym.def.startLine && h.line <= sym.def.endLine) continue;
    if (!h.checked && !(await isCodeHit(ctx, h, sym.name))) continue;
    const text = await ctx.head.read(h.path);
    const lineText = text === null ? "" : (text.split("\n", h.line)[h.line - 1] ?? "");
    out.push({
      path: h.path,
      line: h.line,
      rank: await rankOf(ctx, h.path, sym.path, importCache),
      importLine: IMPORT_LINE.test(lineText),
    });
  }
  return out;
}

async function isCodeHit(ctx: UsageContext, h: { path: string; line: number }, name: string): Promise<boolean> {
  const tree = await ctx.parses.tree(h.path);
  if (!tree) return true; // text fallback: every hit counts
  const text = await ctx.head.read(h.path);
  if (text === null) return false;
  const starts = lineStarts(text);
  const start = starts[h.line - 1];
  if (start === undefined) return false;
  const end = starts[h.line] ?? text.length;
  const line = text.slice(start, end);
  const cols = wordColumns(line, name);
  return cols.some((c) => !inCommentOrString(tree.rootNode, start + c));
}

async function rankOf(ctx: UsageContext, path: string, changedPath: string, cache: Map<string, boolean>): Promise<number> {
  if (posix.dirname(path) === posix.dirname(changedPath)) return 0;
  let imports = cache.get(path);
  if (imports === undefined) {
    const text = await ctx.head.read(path);
    imports = text !== null && importsFile(text, changedPath);
    cache.set(path, imports);
  }
  if (imports) return 1;
  if (isTestPath(path)) return 2;
  return 3;
}

/** Ranks, caps and counts the usages of one symbol. */
export function selectUsages(usages: readonly Usage[], max: number, changedPaths: ReadonlySet<string>): SymbolUsages {
  const sorted = [...usages].sort(
    (a, b) =>
      a.rank - b.rank || Number(a.importLine) - Number(b.importLine) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return {
    usages: sorted.slice(0, Math.max(0, max)),
    total: sorted.length,
    outside: sorted.filter((u) => !changedPaths.has(u.path)).length,
  };
}

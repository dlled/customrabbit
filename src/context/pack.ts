// Pack text and budget (design-v2 §3.1 step 5, §3.2). Symbols are ordered signature changed >
// exported > usages outside the changed files, and the pack is filled in that order up to
// min(diff chars, context.max_chars). Truncation is not incomplete coverage: the diff itself is
// always reviewed in full.

import type { ChangedSymbol } from "./symbols.js";
import { lineStarts } from "./usages.js";

/** Lines of context around a signature or usage. */
export const SNIPPET_RADIUS = 3;
/** A definition snippet never shows more than this many lines. */
export const MAX_DEFINITION_LINES = 24;
/** Characters kept of one source line (minified files). */
export const MAX_LINE_CHARS = 240;

export interface PackEntry {
  symbol: ChangedSymbol;
  /** Usages outside the changed files (ordering). */
  outside: number;
  /** Usages found before the per-symbol cap. */
  total: number;
  header: string;
  definition: string;
  /** Rendered usage snippets, best first; overlapping usages of one file share a snippet. */
  usages: UsageSnippet[];
}

export interface UsageSnippet {
  text: string;
  /** Usages marked in this snippet. */
  count: number;
}

/**
 * `path:from-to` (or `path:l1,l2` for marked lines) followed by numbered lines `from..to` of
 * `text` (1-based, clipped). Marked lines start with ">".
 */
export function snippet(text: string, path: string, from: number, to: number, marks: readonly number[] = []): string {
  const starts = lineStarts(text);
  const last = text.endsWith("\n") ? starts.length - 1 : starts.length;
  const a = Math.max(1, from);
  const b = Math.min(last, to);
  const label = marks.length > 0 ? marks.join(",") : `${a}${b > a ? `-${b}` : ""}`;
  if (b < a) return `${path}:${label}\n`;
  const width = String(b).length;
  const marked = new Set(marks);
  const rows: string[] = [`${path}:${label}`];
  for (let n = a; n <= b; n++) {
    const s = starts[n - 1] ?? 0;
    const e = starts[n] ?? text.length;
    let line = text.slice(s, e).replace(/\r?\n$/, "");
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`;
    rows.push(`${marked.has(n) ? ">" : " "}${String(n).padStart(width)} | ${line}`);
  }
  return `${rows.join("\n")}\n`;
}

export function definitionSnippet(text: string, sym: ChangedSymbol): string {
  const from = sym.def.startLine - SNIPPET_RADIUS;
  const to = Math.min(sym.def.signatureEnd + SNIPPET_RADIUS, sym.def.startLine + MAX_DEFINITION_LINES - 1);
  return snippet(text, sym.path, from, to);
}

/**
 * Snippets for the usages of one symbol, in the given (ranked) order. Usages of one file whose
 * ±{@link SNIPPET_RADIUS} windows overlap share one snippet, placed at the first one's rank.
 */
export function usageSnippets(
  usages: readonly { path: string; line: number }[],
  textOf: (path: string) => string | null,
): UsageSnippet[] {
  interface Group {
    path: string;
    from: number;
    to: number;
    marks: number[];
  }
  const groups: Group[] = [];
  for (const u of usages) {
    const from = u.line - SNIPPET_RADIUS;
    const to = u.line + SNIPPET_RADIUS;
    const g = groups.find((x) => x.path === u.path && from <= x.to + 1 && to >= x.from - 1);
    if (g) {
      g.from = Math.min(g.from, from);
      g.to = Math.max(g.to, to);
      g.marks.push(u.line);
    } else {
      groups.push({ path: u.path, from, to, marks: [u.line] });
    }
  }
  const out: UsageSnippet[] = [];
  for (const g of groups) {
    const text = textOf(g.path);
    if (text === null) continue;
    const marks = [...new Set(g.marks)].sort((a, b) => a - b);
    out.push({ text: snippet(text, g.path, g.from, g.to, marks), count: marks.length });
  }
  return out;
}

export function headerOf(sym: ChangedSymbol): string {
  const traits = [sym.kind];
  if (sym.exported) traits.push("exported");
  if (sym.deleted) traits.push("removed at head");
  else if (sym.signatureChanged) traits.push("signature changed");
  else traits.push("body changed");
  const where = `${sym.side === "base" ? "base " : ""}${sym.path}:${sym.def.nameLine}`;
  return `### ${sym.name} (${traits.join(", ")}) — ${where}\n`;
}

/** §3.2 order: signature changed > exported > usages outside the changed files. */
export function compareEntries(a: PackEntry, b: PackEntry): number {
  return (
    Number(b.symbol.signatureChanged) - Number(a.symbol.signatureChanged) ||
    Number(b.symbol.exported) - Number(a.symbol.exported) ||
    b.outside - a.outside ||
    a.symbol.path.localeCompare(b.symbol.path) ||
    a.symbol.def.nameLine - b.symbol.def.nameLine ||
    a.symbol.name.localeCompare(b.symbol.name)
  );
}

export interface RenderedPack {
  text: string;
  symbols: number;
  usages: number;
  dropped: number;
}

/**
 * Fills the pack in §3.2 order within `cap` characters. A symbol goes in with its header and
 * definition, then as many usages as fit; a symbol whose header and definition do not fit is
 * dropped (later, smaller symbols may still fit). `pending` counts symbols never collected
 * (step budget), which are dropped too.
 */
export function renderPack(entries: readonly PackEntry[], cap: number, pending = 0): RenderedPack {
  const sorted = [...entries].sort(compareEntries);
  let text = "";
  let symbols = 0;
  let usages = 0;
  let dropped = pending;
  for (const e of sorted) {
    const head = `${e.header}definition:\n${e.definition}`;
    if (text.length + head.length > cap) {
      dropped++;
      continue;
    }
    let section = head;
    let shown = 0;
    for (const u of e.usages) {
      const label = shown === 0 ? `usages (${e.total} found):\n` : "";
      if (text.length + section.length + label.length + u.text.length > cap) break;
      section += label + u.text;
      shown += u.count;
    }
    if (shown === 0 && e.total === 0) {
      const none = "usages: none found\n";
      if (text.length + section.length + none.length <= cap) section += none;
    }
    const sep = text === "" ? "" : "\n";
    if (text.length + sep.length + section.length > cap) {
      dropped++;
      continue;
    }
    text += sep + section;
    symbols++;
    usages += shown;
  }
  return { text, symbols, usages, dropped };
}

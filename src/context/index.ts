// Code-graph context pack (design-v2 §3).
//
// Computed once in the orchestrator, from git blobs only (§1.1), and given to both engines as the
// untrusted `<related-code>` block (src/prompts/builder.ts `relatedCode`). Never fails the run:
// on any error the pack is null, and after the 60 s budget it is whatever was collected.
//
// Steps (§3.1): parse head/base blobs with web-tree-sitter → changed symbols from tags queries →
// usages by `git grep -F -e` over the head tree (comments/strings dropped, ranked) → optional
// TypeScript `findReferences` refinement (20 s) → snippets → budget min(diff chars, max_chars).

import type { DiffFile } from "../github/diff.js";
import type { GitRunner } from "../github/git.js";
import type { ContextConfig, RunContextInfo } from "../types.js";
import { listTree, type TreeIndex } from "./git.js";
import { isTsLike, languageFor, loadLanguage } from "./languages.js";
import { definitionSnippet, headerOf, renderPack, usageSnippets, type PackEntry } from "./pack.js";
import { changedConfigKeys, changedLines, changedSymbols, definitions, type ChangedSymbol, type Definition } from "./symbols.js";
import { refineWithTypeScript, TS_BUDGET_MS, type TsReference } from "./typescript.js";
import { findUsages, ParseCache, selectUsages, type UsageContext } from "./usages.js";

/** §3.4 wall-clock budget of the step. */
export const CONTEXT_BUDGET_MS = 60_000;
/** Most changed symbols followed in one run (the budget usually cuts earlier). */
export const MAX_SYMBOLS = 60;
/** Most changed files parsed for symbols. */
export const MAX_CHANGED_FILES = 200;

export interface ContextPackInput {
  /** Runs git in the full-history checkout; only blob, tree and grep commands are issued. */
  git: GitRunner;
  baseSha: string;
  headSha: string;
  /** Reviewed (filtered) files of the diff, with hunks. */
  files: readonly DiffFile[];
  /** v1 `path_filters` (`PathFilter.matches`): usages outside the reviewed scope are dropped. */
  includePath?: (path: string) => boolean;
  /** Characters of the reviewed diff; the pack cap is min(diffChars, config.max_chars). */
  diffChars: number;
  config: ContextConfig;
  signal?: AbortSignal;
  /** Test hooks. */
  budgetMs?: number;
  tsBudgetMs?: number;
  now?: () => number;
}

export interface ContextPack {
  /** Text for `<related-code>`; escaped by the builder. */
  text: string;
  /** For the run document `context` field and the body's "Review info" line. */
  info: RunContextInfo;
  /**
   * Names of every changed symbol found (§3.1 step 2), signature changes and exported names first,
   * including symbols the budget left out of `text`. Used as search keywords (§4.6).
   */
  symbols: string[];
}

interface State {
  entries: PackEntry[];
  /** Symbols found but not collected yet. */
  pending: number;
  usedTs: boolean;
  /** Changed symbol names in §3.2 priority order, set once step 2 finishes. */
  names: string[];
}

/**
 * Builds the pack, or null when the feature is off or nothing could be computed. Never throws.
 * An empty pack (no followable symbol) still reports its `info`.
 */
export async function buildContextPack(input: ContextPackInput): Promise<ContextPack | null> {
  if (!input.config.enabled) return null;
  // An already-aborted signal never fires its `abort` event, so it is checked here.
  if (input.signal?.aborted === true) return null;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? CONTEXT_BUDGET_MS);
  const state: State = { entries: [], pending: 0, usedTs: false, names: [] };
  const cap = Math.max(0, Math.min(input.diffChars, input.config.max_chars));

  let timer: NodeJS.Timeout | undefined;
  const stop = new AbortController();
  const onAbort = () => {
    stop.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve("timeout");
    }, Math.max(0, deadline - now()));
  });
  // A failure after the timeout must not surface as an unhandled rejection.
  const work = collect(input, state, deadline, stop.signal, now).catch(() => "failed" as const);
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === "failed" && state.entries.length === 0) return null;
  } finally {
    clearTimeout(timer);
    stop.abort();
    input.signal?.removeEventListener("abort", onAbort);
  }
  const r = renderPack(state.entries, cap, state.pending);
  return {
    text: r.text,
    symbols: state.names,
    info: { symbols: r.symbols, usages: r.usages, resolver: state.usedTs ? "tree-sitter+ts" : "tree-sitter", dropped: r.dropped },
  };
}

async function parseDefs(tree: TreeIndex, path: string): Promise<Definition[]> {
  const id = languageFor(path);
  if (!id) return [];
  const [lang, text] = await Promise.all([loadLanguage(id), tree.read(path)]);
  if (!lang || text === null) return [];
  const parsed = lang.parser.parse(text);
  if (!parsed) return [];
  try {
    return definitions(lang, parsed.rootNode);
  } finally {
    parsed.delete();
  }
}

async function collect(
  input: ContextPackInput,
  state: State,
  deadline: number,
  signal: AbortSignal,
  now: () => number,
): Promise<"ok" | "failed"> {
  const expired = () => signal.aborted || now() > deadline;
  const head = await listTree(input.git, input.headSha);
  if (head.files.size === 0) return "failed";
  let base: Promise<TreeIndex> | null = null;
  const baseTree = () => (base ??= listTree(input.git, input.baseSha));

  // Step 2: changed symbols, first definition of a name wins (signature change preferred).
  const symbols = new Map<string, ChangedSymbol>();
  const addedLines = new Map<string, Set<number>>();
  for (const file of input.files.slice(0, MAX_CHANGED_FILES)) {
    if (expired()) break;
    if (file.binary) continue;
    // A symlink, submodule or oversized entry at head is not a regular file of the tree: skipped.
    if (file.status !== "deleted" && !head.has(file.path)) continue;
    const lines = changedLines(file);
    addedLines.set(file.path, lines.added);
    const id = languageFor(file.path);
    let found: ChangedSymbol[];
    if (id) {
      const headDefs = file.status !== "deleted" && head.has(file.path) ? await parseDefs(head, file.path) : [];
      const bt = file.status !== "added" && lines.deleted.size > 0 ? await baseTree() : null;
      const baseDefs = bt && bt.has(file.oldPath) ? await parseDefs(bt, file.oldPath) : [];
      found = changedSymbols(file, id, headDefs, baseDefs, lines);
    } else {
      found = changedConfigKeys(file);
    }
    for (const s of found) {
      const prev = symbols.get(s.name);
      if (!prev || (s.signatureChanged && !prev.signatureChanged)) symbols.set(s.name, s);
    }
  }
  const all = [...symbols.values()];
  // Signature changes and exported names first, so the step budget cuts the least useful ones.
  all.sort((a, b) => Number(b.signatureChanged) - Number(a.signatureChanged) || Number(b.exported) - Number(a.exported));
  const chosen = all.slice(0, MAX_SYMBOLS);
  state.pending = all.length;
  state.names = all.map((s) => s.name);

  // Step 4: TypeScript refinement for exported TS/JS symbols defined at head.
  let tsRefs = new Map<string, TsReference[]>();
  if (input.config.typescript && !expired()) {
    const bt = await baseTree();
    const targets = chosen
      .filter((s) => s.side === "head" && s.exported && isTsLike(s.lang) && s.def.nameIndex >= 0)
      .map((s) => ({ key: s.name, path: s.path, index: s.def.nameIndex }));
    if (bt.has("tsconfig.json") && targets.length > 0) {
      const r = await refineWithTypeScript(bt, head, targets, {
        budgetMs: input.tsBudgetMs ?? TS_BUDGET_MS,
        deadline,
        signal,
        now,
      });
      if (r && r.refs.size > 0) {
        tsRefs = r.refs;
        state.usedTs = true;
      }
    }
  }

  // Step 3 + 5: usages and snippets, one symbol at a time so a timeout keeps what is done.
  const parses = new ParseCache(head);
  const changedPaths = new Set(input.files.map((f) => f.path));
  const ctx: UsageContext = {
    git: input.git,
    head,
    baseSha: input.baseSha,
    parses,
    includePath: input.includePath ?? (() => true),
    addedLines,
    changedPaths,
  };
  try {
    for (const sym of chosen) {
      if (expired()) break;
      const found = await findUsages(ctx, sym, tsRefs.get(sym.name));
      const sel = selectUsages(found, input.config.max_usages_per_symbol, changedPaths);
      const defTree = sym.side === "head" ? head : await baseTree();
      const defText = await defTree.read(sym.path);
      if (defText === null) {
        state.pending--;
        continue;
      }
      const texts = new Map<string, string | null>();
      for (const u of sel.usages) if (!texts.has(u.path)) texts.set(u.path, await head.read(u.path));
      const snippets = usageSnippets(sel.usages, (p) => texts.get(p) ?? null);
      if (expired()) break;
      state.entries.push({
        symbol: sym,
        outside: sel.outside,
        total: sel.total,
        header: headerOf(sym),
        definition: definitionSnippet(defText, sym),
        usages: snippets,
      });
      state.pending--;
    }
  } finally {
    parses.dispose();
  }
  return "ok";
}

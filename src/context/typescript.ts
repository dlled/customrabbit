// TypeScript refinement (design-v2 §3.1 step 4): `findReferences` for exported TS/JS symbols.
//
// - `tsconfig.json` comes from the BASE commit, as data. `extends`, `include`, `files`, `paths`,
//   `references`, `typeRoots` (and the other path options) are kept only when they stay inside the
//   repo: no absolute paths, no `..` escape, no `node_modules`. Compiler options are an allowlist, so
//   `compilerOptions.plugins` is never loaded.
// - The LanguageService host serves the regular files of `git ls-tree -r <head>` (blobs, §1.1) under a
//   virtual root and nothing else: no real filesystem path, no lib files (`noLib`), no `@types`
//   (`types: []`). Types from node_modules stay unresolved, because the PR is never installed.
// - Everything runs inside a budget (20 s by default) through the host's cancellation token; on
//   timeout the caller keeps what finished and falls back to `git grep` for the rest.

import { createRequire } from "node:module";
import { posix } from "node:path";

import { Minimatch } from "minimatch";
import type * as TS from "typescript";

import type { TreeIndex } from "./git.js";

export const TS_BUDGET_MS = 20_000;
/** Most script files given to the LanguageService. */
export const MAX_TS_FILES = 3000;
/** Most bytes of script text prefetched for the LanguageService. */
export const MAX_TS_BYTES = 40 * 1024 * 1024;
const MAX_EXTENDS_DEPTH = 5;

/** Virtual root: TS sees `/repo/<path>` for each tree path. Never a real directory. */
const ROOT = "/repo";

const nodeRequire = createRequire(import.meta.url);
let tsModule: typeof TS | null | undefined;

function loadTs(): typeof TS | null {
  if (tsModule === undefined) {
    try {
      // A computed name keeps the bundler from inlining typescript (≈ 9 MB); it is a runtime dependency.
      const name = ["type", "script"].join("");
      tsModule = nodeRequire(name) as typeof TS;
    } catch {
      tsModule = null;
    }
  }
  return tsModule;
}

/** Repo-relative path from `rel` resolved against repo dir `dir`, or null when it leaves the repo. */
export function confine(dir: string, rel: string): string | null {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return null;
  const joined = posix.normalize(posix.join(dir === "" ? "." : dir, rel));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
  if (joined.split("/").includes("node_modules")) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

/** Compiler options kept from the base tsconfig; everything else (plugins, emit paths, …) is dropped. */
const ALLOWED_OPTIONS = new Set([
  "target", "module", "moduleResolution", "jsx", "allowJs", "checkJs", "esModuleInterop",
  "allowSyntheticDefaultImports", "resolveJsonModule", "moduleSuffixes", "customConditions",
  "allowImportingTsExtensions", "experimentalDecorators", "emitDecoratorMetadata", "strict",
  "verbatimModuleSyntax", "allowArbitraryExtensions", "resolvePackageJsonExports",
  "resolvePackageJsonImports", "preserveSymlinks", "useDefineForClassFields", "isolatedModules",
  "moduleDetection", "jsxFactory", "jsxFragmentFactory",
]);
/** Path-valued options: kept only when confined (relative to the declaring config's directory). */
const PATH_OPTIONS = new Set(["baseUrl", "rootDir"]);
const PATH_LIST_OPTIONS = new Set(["rootDirs", "typeRoots"]);

export interface SanitizedConfig {
  /** Repo-relative directory of the root tsconfig. */
  dir: string;
  /** compilerOptions JSON with repo-relative paths made virtual-absolute. */
  compilerOptions: Record<string, unknown>;
  include: string[] | null;
  files: string[] | null;
  exclude: string[] | null;
  /** Kept for the record only (no build mode runs). */
  references: string[];
  /** Entries dropped by confinement or the allowlist, for tests and logs. */
  dropped: string[];
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

function virtual(p: string): string {
  return p === "" ? ROOT : `${ROOT}/${p}`;
}

function confinedList(dir: string, v: unknown, what: string, dropped: string[]): string[] | null {
  const xs = asStringArray(v);
  if (xs === null) return null;
  const out: string[] = [];
  for (const x of xs) {
    const c = confine(dir, x);
    if (c === null) dropped.push(`${what}:${x.slice(0, 100)}`);
    else out.push(c);
  }
  return out;
}

/** One config file's own (not inherited) sanitized content. Paths become repo-relative. */
function sanitizeOwn(dir: string, raw: Record<string, unknown>, dropped: string[]) {
  const opts: Record<string, unknown> = {};
  const co = raw.compilerOptions;
  if (co && typeof co === "object" && !Array.isArray(co)) {
    // baseUrl first: `paths` targets resolve against it.
    const entries = Object.entries(co as Record<string, unknown>).sort(
      ([a], [b]) => Number(b === "baseUrl") - Number(a === "baseUrl"),
    );
    for (const [k, v] of entries) {
      if (ALLOWED_OPTIONS.has(k)) {
        if (typeof v === "string" || typeof v === "boolean" || typeof v === "number" || Array.isArray(v)) {
          opts[k] = Array.isArray(v) ? v.filter((x) => typeof x === "string") : v;
        }
      } else if (PATH_OPTIONS.has(k)) {
        const c = typeof v === "string" ? confine(dir, v) : null;
        if (c === null) dropped.push(`compilerOptions.${k}`);
        else opts[k] = virtual(c);
      } else if (PATH_LIST_OPTIONS.has(k)) {
        const list = confinedList(dir, v, `compilerOptions.${k}`, dropped);
        if (list) opts[k] = list.map(virtual);
      } else if (k === "paths") {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          // Targets resolve against baseUrl, else against this config's directory (TS ≥ 4.1).
          const baseDir = typeof opts.baseUrl === "string" ? opts.baseUrl.slice(ROOT.length + 1) : dir;
          const paths: Record<string, string[]> = {};
          for (const [key, targets] of Object.entries(v as Record<string, unknown>)) {
            const kept = (asStringArray(targets) ?? []).flatMap((t) => {
              const c = confine(baseDir, t);
              if (c === null) {
                dropped.push(`compilerOptions.paths:${key.slice(0, 50)}`);
                return [];
              }
              return [virtual(c)];
            });
            if (kept.length > 0) paths[key] = kept;
          }
          opts.paths = paths;
        }
      } else {
        dropped.push(`compilerOptions.${k}`);
      }
    }
  }
  return {
    compilerOptions: opts,
    include: confinedList(dir, raw.include, "include", dropped),
    files: confinedList(dir, raw.files, "files", dropped),
    exclude: confinedList(dir, raw.exclude, "exclude", dropped),
    references: Array.isArray(raw.references)
      ? raw.references.flatMap((r: unknown) => {
          const p = r && typeof r === "object" ? (r as { path?: unknown }).path : undefined;
          const c = typeof p === "string" ? confine(dir, p) : null;
          if (c === null) dropped.push("references");
          return c === null ? [] : [c];
        })
      : [],
  };
}

type OwnConfig = ReturnType<typeof sanitizeOwn>;

/** `top` over `under`: TS extends semantics (options merge, file lists replace). */
function overlay(under: OwnConfig, top: OwnConfig): OwnConfig {
  return {
    compilerOptions: { ...under.compilerOptions, ...top.compilerOptions },
    include: top.include ?? under.include,
    files: top.files ?? under.files,
    exclude: top.exclude ?? under.exclude,
    references: top.references,
  };
}

function parseJsonc(ts: typeof TS, path: string, text: string): Record<string, unknown> | null {
  const r = ts.parseConfigFileTextToJson(path, text);
  if (r.error || !r.config || typeof r.config !== "object" || Array.isArray(r.config)) return null;
  return r.config as Record<string, unknown>;
}

/**
 * Reads `<dir>/tsconfig.json` and its relative `extends` chain from the base tree and confines every
 * path in it. Returns null when there is no usable tsconfig at base.
 */
export async function loadBaseTsconfig(base: TreeIndex, path = "tsconfig.json"): Promise<SanitizedConfig | null> {
  const ts = loadTs();
  if (!ts) return null;
  const dropped: string[] = [];

  const load = async (file: string, depth: number): Promise<OwnConfig | null> => {
    const text = await base.read(file);
    if (text === null) return null;
    const raw = parseJsonc(ts, file, text);
    if (!raw) return null;
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const own = sanitizeOwn(dir, raw, dropped);
    const ext = typeof raw.extends === "string" ? [raw.extends] : (asStringArray(raw.extends) ?? []);
    let merged: OwnConfig | null = null;
    for (const e of ext) {
      // Package extends ("@tsconfig/node20") would resolve into node_modules: dropped.
      const rel = e.startsWith("./") || e.startsWith("../") ? confine(dir, e.endsWith(".json") ? e : `${e}.json`) : null;
      if (rel === null || depth >= MAX_EXTENDS_DEPTH) {
        dropped.push(`extends:${e.slice(0, 100)}`);
        continue;
      }
      const parent = await load(rel, depth + 1);
      if (!parent) {
        dropped.push(`extends:${e.slice(0, 100)}`);
        continue;
      }
      // Later entries of an `extends` array override earlier ones.
      merged = merged ? overlay(merged, parent) : parent;
    }
    return merged ? overlay(merged, own) : own;
  };

  const cfg = await load(path, 0);
  if (!cfg) return null;
  return { dir: posix.dirname(path) === "." ? "" : posix.dirname(path), ...cfg, dropped };
}

const TS_EXT = /\.(?:ts|tsx|mts|cts)$/;
const JS_EXT = /\.(?:js|jsx|mjs|cjs)$/;

function includeMatchers(patterns: readonly string[]): Minimatch[] {
  return patterns.map((p) => {
    // A pattern without a wildcard and without an extension names a directory.
    const last = p.slice(p.lastIndexOf("/") + 1);
    const glob = /[*?]/.test(p) || last.includes(".") ? p : `${p === "" ? "" : `${p}/`}**/*`;
    return new Minimatch(glob === "" ? "**/*" : glob, { dot: false });
  });
}

/** The script files of the program: the config's files/include/exclude over the head tree. */
export function programFiles(cfg: SanitizedConfig, head: TreeIndex, mustInclude: readonly string[]): string[] {
  const allowJs = cfg.compilerOptions.allowJs === true || cfg.compilerOptions.checkJs === true;
  const isScript = (p: string) => TS_EXT.test(p) || (allowJs && JS_EXT.test(p));
  const files = new Set<string>();
  for (const f of cfg.files ?? []) if (head.has(f) && isScript(f)) files.add(f);
  const include = cfg.include ?? (cfg.files ? [] : [cfg.dir === "" ? "**/*" : `${cfg.dir}/**/*`]);
  const inc = includeMatchers(include);
  const exc = includeMatchers(cfg.exclude ?? []);
  if (inc.length > 0) {
    for (const p of head.files.keys()) {
      if (files.size >= MAX_TS_FILES) break;
      if (!isScript(p) || p.split("/").includes("node_modules")) continue;
      if (inc.some((m) => m.match(p)) && !exc.some((m) => m.match(p))) files.add(p);
    }
  }
  for (const p of mustInclude) if (head.has(p) && (TS_EXT.test(p) || JS_EXT.test(p))) files.add(p);
  return [...files];
}

export interface TsTarget {
  /** Key the caller uses to match results. */
  key: string;
  path: string;
  /** JS string index of the symbol's name in the head text. */
  index: number;
}

export interface TsReference {
  path: string;
  /** 1-based. */
  line: number;
}

export interface TsRefineResult {
  /** Only targets that finished; a missing key falls back to grep. */
  refs: Map<string, TsReference[]>;
  timedOut: boolean;
}

export interface TsRefineOptions {
  budgetMs?: number;
  signal?: AbortSignal;
  /** Overall deadline (epoch ms) of the context step; the earlier of the two wins. */
  deadline?: number;
  now?: () => number;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Runs `findReferences` for each target. Returns null when TypeScript or the base tsconfig is not
 * available; otherwise the targets that finished within the budget.
 */
export async function refineWithTypeScript(
  base: TreeIndex,
  head: TreeIndex,
  targets: readonly TsTarget[],
  options: TsRefineOptions = {},
): Promise<TsRefineResult | null> {
  const ts = loadTs();
  if (!ts || targets.length === 0) return null;
  const now = options.now ?? Date.now;
  const deadline = Math.min(now() + (options.budgetMs ?? TS_BUDGET_MS), options.deadline ?? Infinity);
  const cancelled = () => now() > deadline || options.signal?.aborted === true;

  const cfg = await loadBaseTsconfig(base);
  if (!cfg) return null;
  const { options: compilerOptions } = ts.convertCompilerOptionsFromJson(
    cfg.compilerOptions,
    virtual(cfg.dir),
    virtual(cfg.dir === "" ? "tsconfig.json" : `${cfg.dir}/tsconfig.json`),
  );
  Object.assign(compilerOptions, { noLib: true, types: [], noEmit: true, skipLibCheck: true, allowJs: true });
  delete compilerOptions.plugins;

  // Prefetch every script blob: the host is synchronous and serves only these texts.
  const names = programFiles(cfg, head, targets.map((t) => t.path));
  const texts = new Map<string, string>();
  let bytes = 0;
  for (let i = 0; i < names.length; i += 16) {
    if (cancelled()) return { refs: new Map(), timedOut: true };
    const batch = names.slice(i, i + 16);
    const got = await Promise.all(batch.map((p) => head.read(p)));
    for (const [j, text] of got.entries()) {
      const p = batch[j];
      if (p === undefined || text === null) continue;
      if (bytes + text.length > MAX_TS_BYTES) break;
      bytes += text.length;
      texts.set(p, text);
    }
  }

  const toRepo = (f: string): string | null => {
    if (!f.startsWith(`${ROOT}/`)) return null;
    const p = posix.normalize(f.slice(ROOT.length + 1));
    return p.startsWith("../") || p.split("/").includes("node_modules") ? null : p;
  };
  const host: TS.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [...texts.keys()].map(virtual),
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      const p = toRepo(f);
      const t = p === null ? undefined : texts.get(p);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => ROOT,
    getDefaultLibFileName: () => `${ROOT}/__no_lib__.d.ts`,
    fileExists: (f) => {
      const p = toRepo(f);
      return p !== null && texts.has(p);
    },
    readFile: (f) => {
      const p = toRepo(f);
      return p === null ? undefined : texts.get(p);
    },
    directoryExists: (d) => {
      if (d === ROOT) return true;
      const p = toRepo(d);
      return p !== null && head.hasDirectory(p);
    },
    getDirectories: () => [],
    realpath: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getCancellationToken: () => ({ isCancellationRequested: cancelled }),
  };

  const refs = new Map<string, TsReference[]>();
  let timedOut = false;
  const service = ts.createLanguageService(host, ts.createDocumentRegistry(true, ROOT));
  try {
    for (const t of targets) {
      if (cancelled()) {
        timedOut = true;
        break;
      }
      if (!texts.has(t.path)) continue;
      try {
        const found = service.findReferences(virtual(t.path), t.index) ?? [];
        const out: TsReference[] = [];
        const seen = new Set<string>();
        for (const sym of found) {
          for (const r of sym.references) {
            if (r.isDefinition) continue;
            const p = toRepo(r.fileName);
            const text = p === null ? undefined : texts.get(p);
            if (p === null || text === undefined) continue;
            const line = lineAt(text, r.textSpan.start);
            const k = `${p}:${line}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ path: p, line });
          }
        }
        refs.set(t.key, out);
      } catch (e) {
        if (e instanceof ts.OperationCanceledException || cancelled()) {
          timedOut = true;
          break;
        }
        // Any other LanguageService failure: this target falls back to grep.
      }
    }
  } finally {
    service.dispose();
  }
  return { refs, timedOut };
}

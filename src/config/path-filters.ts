// path_filters with CodeRabbit semantics (design.md §4, docs/research/coderabbit.md §3):
// - a leading "!" excludes; exclusions always win, whatever their order;
// - any pattern without "!" turns the list into an allowlist;
// - DEFAULT_PATH_FILTERS (CodeRabbit's default ignore list) are always prepended. Lead decision:
//   "**/generated/**" and "**/gen/**" are NOT in it, because hand-edited code under those names
//   would slip past the merge gate. A repo excludes them explicitly if it wants to;
// - one default is re-enabled by listing its exact pattern without the "!" (e.g. "**/*.csv").
//   Such a re-enable only removes that default; it does not turn the list into an allowlist.
//   A broad include such as "src/**" does not override a default.

import { Minimatch } from "minimatch";

import { GLOB_OPTIONS } from "./glob.js";

/** CodeRabbit's default ignored paths (docs.coderabbit.ai/configuration/path-instructions), minus generated/ and gen/. */
export const DEFAULT_PATH_FILTERS: readonly string[] = [
  "!**/dist/**",
  "!**/node_modules/**",
  "!**/.svelte-kit/**",
  "!**/.webpack/**",
  "!**/.yarn/**",
  "!**/.docusaurus/**",
  "!**/.temp/**",
  "!**/.cache/**",
  "!**/.next/**",
  "!**/.nuxt/**",
  "!**/package-lock.json",
  "!**/yarn.lock",
  "!**/pnpm-lock.yaml",
  "!**/bun.lockb",
  "!**/*.lock",
  "!**/@generated/**",
  "!**/__generated__/**",
  "!**/__generated/**",
  "!**/_generated/**",
  "!**/@gen/**",
  "!**/__gen__/**",
  "!**/__gen/**",
  "!**/_gen/**",
  "!**/*.generated.*",
  "!**/*.tsbuildinfo",
  "!**/*.app",
  "!**/*.bin",
  "!**/*.class",
  "!**/*.dll",
  "!**/*.dylib",
  "!**/*.exe",
  "!**/*.o",
  "!**/*.so",
  "!**/*.wasm",
  "!**/*.bz2",
  "!**/*.gz",
  "!**/*.xz",
  "!**/*.zip",
  "!**/*.7z",
  "!**/*.rar",
  "!**/*.zst",
  "!**/*.tar",
  "!**/*.jar",
  "!**/*.war",
  "!**/*.nar",
  "!**/*.mp3",
  "!**/*.wav",
  "!**/*.wma",
  "!**/*.mp4",
  "!**/*.avi",
  "!**/*.mkv",
  "!**/*.wmv",
  "!**/*.m4a",
  "!**/*.m4v",
  "!**/*.3gp",
  "!**/*.3g2",
  "!**/*.rm",
  "!**/*.mov",
  "!**/*.flv",
  "!**/*.swf",
  "!**/*.flac",
  "!**/*.ogg",
  "!**/*.ico",
  "!**/*.svg",
  "!**/*.jpeg",
  "!**/*.jpg",
  "!**/*.png",
  "!**/*.gif",
  "!**/*.bmp",
  "!**/*.tiff",
  "!**/*.webm",
  "!**/*.ttf",
  "!**/*.otf",
  "!**/*.woff",
  "!**/*.woff2",
  "!**/*.eot",
  "!**/*.pdf",
  "!**/*.doc",
  "!**/*.docx",
  "!**/*.xls",
  "!**/*.xlsx",
  "!**/*.ppt",
  "!**/*.pptx",
  "!**/*.csv",
  "!**/*.tsv",
  "!**/*.dat",
  "!**/*.db",
  "!**/*.parquet",
  "!**/tags",
  "!**/.tags",
  "!**/TAGS",
  "!**/.TAGS",
  "!**/.DS_Store",
  "!**/.cscope.files",
  "!**/.cscope.out",
  "!**/.cscope.in.out",
  "!**/.cscope.po.out",
  "!**/*.log",
  "!**/*.map",
  "!**/*.out",
  "!**/*.sum",
  "!**/*.work",
  "!**/*.md5sum",
  "!**/*.tga",
  "!**/*.dds",
  "!**/*.psd",
  "!**/*.fbx",
  "!**/*.obj",
  "!**/*.blend",
  "!**/*.dae",
  "!**/*.gltf",
  "!**/*.hlsl",
  "!**/*.glsl",
  "!**/*.unity",
  "!**/*.umap",
  "!**/*.prefab",
  "!**/*.mat",
  "!**/*.shader",
  "!**/*.shadergraph",
  "!**/*.sav",
  "!**/*.scene",
  "!**/*.asset",
  "!**/*.pyc",
  "!**/*.pyd",
  "!**/*.pyo",
  "!**/*.pkl",
  "!**/*.pickle",
  "!**/*.pb.go",
  "!**/*.pb.gw.go",
  "!**/*.tfstate",
  "!**/*.tfstate.backup",
  "!**/*.xcworkspace/contents.xcworkspacedata",
  "!**/Package.resolved",
  "!**/*.min.js",
  "!**/*.min.js.map",
  "!**/*.min.css",
  "!**/*.[0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-].chunk.js",
  "!**/*.[0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-].chunk.css",
  "!**/assets/index-[0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-].js",
  "!**/assets/index-[0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-][0-9a-z_-].css",
];

/** Why a path is not reviewed. */
export interface FilteredPath {
  path: string;
  /** "excluded": an exclusion matched (`pattern` is it, with its "!"); "not_included": outside the allowlist (`pattern` is null). */
  reason: "excluded" | "not_included";
  pattern: string | null;
}

export interface PathPartition {
  reviewed: string[];
  filtered: FilteredPath[];
}

export interface PathFilter {
  /** Exclusion globs in effect (defaults minus re-enabled ones, plus the user's "!" patterns), without "!". */
  readonly excludes: readonly string[];
  /** Allowlist globs; empty means every non-excluded path is reviewed. */
  readonly includes: readonly string[];
  /** True when `path` (repo-relative, "/" separators) is reviewed. */
  matches(path: string): boolean;
  /** The first exclusion (as "!glob") that matches `path`, or null. Ignores the allowlist. */
  excludedBy(path: string): string | null;
  /** Splits paths into reviewed and filtered (with the reason), keeping input order. */
  partition(paths: readonly string[]): PathPartition;
}

/** Builds the effective filter from the user's `path_filters` (defaults are always prepended). */
export function compilePathFilter(userFilters: readonly string[]): PathFilter {
  const defaultExcludes = new Set(DEFAULT_PATH_FILTERS.map((p) => p.slice(1)));
  const userExcludes: string[] = [];
  const includes: string[] = [];
  const reenabled = new Set<string>();

  for (const raw of userFilters) {
    const pattern = raw.trim();
    if (pattern.startsWith("!")) {
      const glob = pattern.slice(1).trim();
      if (glob) userExcludes.push(glob);
    } else if (defaultExcludes.has(pattern)) {
      reenabled.add(pattern);
    } else if (pattern) {
      includes.push(pattern);
    }
  }

  // Exclusions win: a pattern both re-enabled and explicitly excluded stays excluded.
  const excludes = unique([
    ...[...defaultExcludes].filter((p) => !reenabled.has(p)),
    ...userExcludes,
  ]);
  const uniqueIncludes = unique(includes);
  const excludeMatchers = excludes.map((p) => ({ pattern: `!${p}`, m: new Minimatch(p, GLOB_OPTIONS) }));
  const includeMatchers = uniqueIncludes.map((p) => new Minimatch(p, GLOB_OPTIONS));

  const excludedBy = (path: string): string | null => {
    const p = normalizePath(path);
    return excludeMatchers.find(({ m }) => m.match(p))?.pattern ?? null;
  };
  const classify = (path: string): FilteredPath | null => {
    const pattern = excludedBy(path);
    if (pattern !== null) return { path, reason: "excluded", pattern };
    const p = normalizePath(path);
    if (includeMatchers.length === 0 || includeMatchers.some((m) => m.match(p))) return null;
    return { path, reason: "not_included", pattern: null };
  };

  return {
    excludes,
    includes: uniqueIncludes,
    matches: (path) => classify(path) === null,
    excludedBy,
    partition(paths) {
      const reviewed: string[] = [];
      const filtered: FilteredPath[] = [];
      for (const path of paths) {
        const f = classify(path);
        if (f === null) reviewed.push(path);
        else filtered.push(f);
      }
      return { reviewed, filtered };
    },
  };
}

/**
 * Splits paths into reviewed and filtered, keeping input order. Each filtered path says why
 * (the matching exclusion, or "not_included" for an allowlist miss), so the body can list them.
 * Without a filter, the default path_filters alone are used.
 */
export function partitionPaths(
  paths: readonly string[],
  filter: PathFilter = compilePathFilter([]),
): PathPartition {
  return filter.partition(paths);
}

export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

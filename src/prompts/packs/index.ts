// Rule packs (design-v2 §4.4).
//
// Each pack is ≤ 3,000 chars of trusted guidance for one language or file type, in
// src/prompts/packs/<name>.md. Every rule names a concrete failure and cites a primary source, and
// leaves to the §7 linters what they already catch (docs/research/parity.md §7). A pack goes into the
// trusted `<style-guide>` section only when the diff touches a file matching its globs and only if it
// is enabled in `rule_packs`. Every pack (name, globs and text) is part of `prompt_version`
// (src/prompts/builder.ts), so editing one changes the `prompt=` marker.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Minimatch } from "minimatch";
import { GLOB_OPTIONS } from "../../config/glob.js";
import { RULE_PACK_NAMES, type RulePackName, type RulePacksConfig } from "../../types.js";

export const MAX_RULE_PACK_CHARS = 3_000;

export interface RulePack {
  name: RulePackName;
  /** minimatch globs (repo-relative) of the files the pack applies to. */
  globs: string[];
  text: string;
}

/** Globs per pack. Matching is case-sensitive with dot files included (src/config/glob.ts). */
export const RULE_PACK_GLOBS: Readonly<Record<RulePackName, readonly string[]>> = {
  typescript: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  python: ["**/*.{py,pyi}"],
  go: ["**/*.go"],
  rust: ["**/*.rs"],
  shell: ["**/*.{sh,bash}"],
  github_actions: [".github/workflows/*.{yml,yaml}", "**/action.{yml,yaml}"],
  dockerfile: [
    "**/Dockerfile",
    "**/Dockerfile.*",
    "**/*.Dockerfile",
    "**/*.dockerfile",
    "**/Containerfile",
    "**/Containerfile.*",
  ],
  sql: ["**/*.{sql,psql,pgsql}", "**/migrations/**"],
};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Directory holding the pack markdown: this directory when running from src/ (tests), or
 * ../src/prompts/packs when running from the dist/ bundle (the action ships the whole repo, as for
 * the templates in src/prompts/builder.ts).
 */
export function defaultPacksDir(): string {
  for (const dir of [HERE, join(HERE, "..", "src", "prompts", "packs")]) {
    if (existsSync(join(dir, `${RULE_PACK_NAMES[0]}.md`))) return dir;
  }
  throw new Error("rule packs not found");
}

/** Reads every pack from `dir`, in RULE_PACK_NAMES order. */
export function loadRulePacks(dir: string = defaultPacksDir()): RulePack[] {
  return RULE_PACK_NAMES.map((name) => ({
    name,
    globs: [...RULE_PACK_GLOBS[name]],
    text: readFileSync(join(dir, `${name}.md`), "utf8"),
  }));
}

/** Pack texts embedded in the dist bundle (esbuild `define` in esbuild.config.mjs). */
declare const __MYRABBIT_RULE_PACKS__: Readonly<Partial<Record<string, string>>> | undefined;

/** Packs from the embedded texts, in RULE_PACK_NAMES order; a missing pack is an error. */
export function packsFromTexts(texts: Readonly<Partial<Record<string, string>>>): RulePack[] {
  return RULE_PACK_NAMES.map((name) => {
    const text = texts[name];
    if (text === undefined) throw new Error(`rule pack ${name} is not embedded`);
    return { name, globs: [...RULE_PACK_GLOBS[name]], text };
  });
}

let cachedPacks: readonly RulePack[] | null = null;

/**
 * Every shipped pack, in prompt order: the bundle's embedded texts, else src/prompts/packs/*.md.
 * Loaded on first use, not at import, so a missing directory can only fail the call that needs
 * the packs (which then fails the run closed), never the module graph at startup.
 */
export function rulePacks(): readonly RulePack[] {
  if (cachedPacks === null) {
    const embedded = typeof __MYRABBIT_RULE_PACKS__ !== "undefined" ? __MYRABBIT_RULE_PACKS__ : null;
    cachedPacks = embedded === null ? loadRulePacks() : packsFromTexts(embedded);
  }
  return cachedPacks;
}

const MATCHERS = new Map<string, Minimatch>();

/** True when `path` (repo-relative, "/"-separated) matches one of `globs`. */
export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => {
    let m = MATCHERS.get(glob);
    if (m === undefined) {
      m = new Minimatch(glob, GLOB_OPTIONS);
      MATCHERS.set(glob, m);
    }
    return m.match(path);
  });
}

/**
 * The enabled packs whose globs match some path, in RULE_PACKS order. `paths` are the files the
 * diff touches and that are under review (after path_filters); a pack that is off, or that no path
 * matches, is left out, so a diff with no matching file adds nothing to the prompt.
 */
export function packsFor(
  paths: readonly string[],
  enabled: RulePacksConfig,
  packs: readonly RulePack[] = rulePacks(),
): RulePack[] {
  return packs.filter((p) => enabled[p.name] && paths.some((path) => matchesAny(p.globs, path)));
}

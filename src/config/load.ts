// Loads `.myrabbit.yaml` from the PR's BASE SHA (design.md §2 step 3, §4).
//
// - Missing file (or an empty one): defaults, no warning.
// - Any problem (unreadable, too large, malformed YAML, not a mapping, unknown key, wrong type,
//   failed rule): the WHOLE file is ignored, defaults apply, and the reasons are returned as
//   warnings for the "config warnings" section of the body. Nothing is partially applied.
// - The head's copy is never read: a PR cannot change the settings of its own review.

import { parseDocument } from "yaml";
import type { z } from "zod";

import type { Config } from "../types.js";
import type { GitReader } from "./git.js";
import { configHash } from "./hash.js";
import { compilePathFilter, type PathFilter } from "./path-filters.js";
import { configSchema, defaultConfig } from "./schema.js";
import { collectStyleGuides, type StyleGuideCollection } from "./style-guide.js";

export const CONFIG_PATH = ".myrabbit.yaml";
export const MAX_CONFIG_BYTES = 256 * 1024;
/** At most this many validation issues are listed; the rest are counted. */
export const MAX_LISTED_ISSUES = 20;

export type ConfigSource = "default" | "file" | "invalid";

export interface LoadedConfig {
  config: Config;
  /** default = no file; file = valid file applied; invalid = file ignored, defaults applied. */
  source: ConfigSource;
  warnings: string[];
}

export interface ReviewConfig extends LoadedConfig {
  styleGuide: StyleGuideCollection;
  pathFilter: PathFilter;
  /** sha1-12 of the effective config and style guides (§8.3). */
  hash: string;
}

/** Reads and validates `.myrabbit.yaml` at `baseSha`. Never throws. */
export async function loadConfig(git: GitReader, baseSha: string): Promise<LoadedConfig> {
  let text: string | null;
  try {
    // One byte over the limit is enough to reject an oversized file without reading all of it.
    text = await git.showFile(baseSha, CONFIG_PATH, MAX_CONFIG_BYTES + 1);
  } catch (err) {
    return invalid([`could not read ${CONFIG_PATH} at the base commit: ${errorMessage(err)}`]);
  }
  if (text === null) return { config: defaultConfig(), source: "default", warnings: [] };
  return parseConfigText(text);
}

/** Validates config text. Never throws. */
export function parseConfigText(text: string): LoadedConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    return invalid([`${CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES} bytes`]);
  }
  const doc = parseDocument(text.replace(/^\uFEFF/, ""), { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return invalid(doc.errors.slice(0, MAX_LISTED_ISSUES).map((e) => `YAML: ${firstLine(e.message)}`));
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    return invalid([`YAML: ${firstLine(errorMessage(err))}`]);
  }
  // An empty file (or one with only comments) means defaults.
  if (data === null || data === undefined) return { config: defaultConfig(), source: "default", warnings: [] };
  if (typeof data !== "object" || Array.isArray(data)) {
    return invalid([`${CONFIG_PATH} must be a mapping of keys to values`]);
  }

  const result = configSchema.safeParse(data);
  if (!result.success) return invalid(formatIssues(result.error.issues));
  return { config: result.data, source: "file", warnings: [] };
}

/**
 * Config, style guides, path filter and hash: everything the pipeline needs from the base SHA.
 * Never throws; a failure reading style guides becomes a warning with no guides.
 */
export async function loadReviewConfig(git: GitReader, baseSha: string): Promise<ReviewConfig> {
  const loaded = await loadConfig(git, baseSha);
  let styleGuide: StyleGuideCollection;
  try {
    styleGuide = await collectStyleGuides(git, baseSha, loaded.config);
  } catch (err) {
    // With no guides to read this makes no git calls; it only indexes and caps path_instructions.
    styleGuide = await collectStyleGuides(git, baseSha, {
      ...loaded.config,
      style_guide: { auto: false, files: [] },
      learnings: { ...loaded.config.learnings, enabled: false },
    });
    styleGuide.warnings.unshift(`could not read style guides at the base commit: ${errorMessage(err)}`);
  }
  return {
    ...loaded,
    warnings: [...loaded.warnings, ...styleGuide.warnings],
    styleGuide,
    pathFilter: compilePathFilter(loaded.config.path_filters),
    hash: configHash(loaded.config, styleGuide.guides),
  };
}

// ---------------------------------------------------------------------------

function invalid(reasons: string[]): LoadedConfig {
  return {
    config: defaultConfig(),
    source: "invalid",
    warnings: [`${CONFIG_PATH} ignored, defaults used:`, ...reasons.map((r) => `- ${r}`)],
  };
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const lines = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${where}: ${firstLine(issue.message)}`;
  });
  if (issues.length > MAX_LISTED_ISSUES) lines.push(`…and ${issues.length - MAX_LISTED_ISSUES} more`);
  return lines;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

function errorMessage(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err));
}

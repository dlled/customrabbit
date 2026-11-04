// Style guide collection (design.md §4.1), always from the BASE SHA.
//
// 1. With `style_guide.auto`, collect **/AGENTS.md, **/CLAUDE.md and **/.claude/rules/**/*.md.
//    AGENTS.md / CLAUDE.md apply to their own directory. A `.claude/rules` file belongs to the
//    directory that holds `.claude/`: without frontmatter it applies to that whole directory; with
//    `paths:` frontmatter it applies to those globs, read relative to that directory.
// 2. `style_guide.files` are added with repo-wide scope (a file listed there that was also
//    auto-collected becomes repo-wide).
//    Auto-collected guides whose path an exclusion in path_filters matches (defaults included:
//    node_modules/, dist/, vendored trees…) are skipped: third-party text never reaches the
//    trusted prompt section. Files listed explicitly in `style_guide.files` are always used.
// 3. Matching per reviewed file is in path-instructions.ts (`applicableRules`).
// 4. Guides and path_instructions share a 60,000-character cap. When over it, the budget is
//    water-filled: short texts stay whole and the longest are truncated to an equal share, each
//    with a note for the review body. Each file is read with a byte cap (GUIDE_READ_LIMIT_BYTES)
//    and failures are per file, so one huge or unreadable guide never drops the others.

import { escape, Minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";

import type { Config } from "../types.js";
import type { GitReader } from "./git.js";
import { GLOB_OPTIONS } from "./glob.js";
import { compilePathFilter } from "./path-filters.js";
import { LEARNINGS_PATH, parseLearnings } from "./learnings.js";
import { indexInstructions, type IndexedInstruction } from "./path-instructions.js";

export const STYLE_GUIDE_CHAR_CAP = 60_000;
/**
 * Bytes read per guide file. Far above what the cap can keep of one file (60,000 UTF-16 units
 * need at most 240,000 bytes), so the cap, not the read, decides the truncation.
 */
export const GUIDE_READ_LIMIT_BYTES = 1024 * 1024;

export const AUTO_GUIDE_GLOBS = ["**/AGENTS.md", "**/CLAUDE.md", "**/.claude/rules/**/*.md"] as const;

export interface StyleGuide {
  /** Stable id in prompt order: "G1", "G2", … */
  id: string;
  /** Repo-relative source file. */
  path: string;
  /** `learnings`: one section of `.myrabbit/learnings.md` (design-v2 §6.1). */
  origin: "auto" | "files" | "learnings";
  /** Section title, for `learnings` guides only (cited as `rule: "learning:<title>"`). */
  title?: string;
  /** Globs (repo-relative) of the files this guide applies to. */
  scope: string[];
  /** Guide text without frontmatter; truncated when `truncated`. */
  content: string;
  /** Length of the text before truncation. */
  originalChars: number;
  truncated: boolean;
}

export interface StyleGuideCollection {
  guides: StyleGuide[];
  /** path_instructions with ids, truncated by the shared cap if needed. */
  instructions: IndexedInstruction[];
  /** Truncation notes for the review body. */
  notes: string[];
  /** Problems reading guides (missing file, bad frontmatter) for "config warnings". */
  warnings: string[];
  /** Auto-collected guides skipped because path_filters exclude them. */
  skipped: string[];
  /** Characters of guide + instruction text after the cap. */
  totalChars: number;
}

const RULES_SEGMENT = ".claude/rules/";

export async function collectStyleGuides(
  git: GitReader,
  sha: string,
  config: Pick<Config, "style_guide" | "path_instructions" | "path_filters"> & Partial<Pick<Config, "learnings">>,
  cap: number = STYLE_GUIDE_CHAR_CAP,
): Promise<StyleGuideCollection> {
  const warnings: string[] = [];
  const skipped: string[] = [];
  type Draft = Omit<StyleGuide, "id" | "originalChars" | "truncated"> & {
    depth: number;
    /** The read hit GUIDE_READ_LIMIT_BYTES, so the file is longer than `content`. */
    readCapped: boolean;
  };
  const drafts: Draft[] = [];

  /** Reads one guide; a failure becomes a warning and skips only this file. */
  const read = async (path: string): Promise<{ raw: string; readCapped: boolean } | null> => {
    try {
      const raw = await git.showFile(sha, path, GUIDE_READ_LIMIT_BYTES);
      if (raw === null) return null;
      // utf8Prefix may stop up to 3 bytes short of the limit to keep a character whole.
      return { raw, readCapped: Buffer.byteLength(raw, "utf8") > GUIDE_READ_LIMIT_BYTES - 4 };
    } catch (err) {
      warnings.push(`style guide ${path}: could not read it at the base commit (${errorMessage(err)})`);
      return null;
    }
  };

  if (config.style_guide.auto) {
    const filter = compilePathFilter(config.path_filters);
    const listed = new Set<string>();
    for (const glob of AUTO_GUIDE_GLOBS) {
      for (const p of await git.listFiles(sha, glob)) listed.add(p);
    }
    for (const path of [...listed].sort()) {
      // Only exclusions count here: an allowlist (e.g. "src/**") must not hide the root AGENTS.md.
      if (filter.excludedBy(path) !== null && !config.style_guide.files.includes(path)) {
        skipped.push(path);
        continue;
      }
      const file = await read(path);
      if (file === null) continue;
      const { raw, readCapped } = file;
      const parsed = parseGuide(path, raw);
      if (parsed.warning) warnings.push(parsed.warning);
      if (!parsed.body.trim()) continue;
      const root = guideRoot(path);
      drafts.push({
        path,
        origin: "auto",
        scope: parsed.paths ? parsed.paths.map((g) => joinGlob(root, g)) : [dirScope(root)],
        content: parsed.body,
        depth: root === "" ? 0 : root.split("/").length,
        readCapped,
      });
    }
    // Repo-wide and shallow guides first, so the prompt reads general → specific.
    drafts.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (skipped.length > 0) {
      const example = skipped.slice(0, 3).join(", ");
      const more = skipped.length > 3 ? `, …` : "";
      warnings.push(
        `${String(skipped.length)} style guide file(s) skipped because path_filters exclude them (${example}${more}); list one in style_guide.files to use it`,
      );
    }
  }

  for (const path of config.style_guide.files) {
    const existing = drafts.find((d) => d.path === path);
    if (existing) {
      existing.scope = ["**"];
      existing.origin = "files";
      continue;
    }
    const warningsBefore = warnings.length;
    const file = await read(path);
    if (file === null) {
      if (warnings.length === warningsBefore) {
        warnings.push(`style_guide.files: ${path} not found at the base commit`);
      }
      continue;
    }
    const parsed = parseGuide(path, file.raw);
    if (parsed.warning) warnings.push(parsed.warning);
    if (!parsed.body.trim()) continue;
    drafts.push({ path, origin: "files", scope: ["**"], content: parsed.body, depth: 0, readCapped: file.readCapped });
  }

  // design-v2 §6.1 learnings hook: each section of the base-SHA learnings file is one guide, after
  // the others, sharing the same cap. Off by default; a missing file is not a warning.
  if (config.learnings?.enabled === true) {
    if (drafts.some((d) => d.path === LEARNINGS_PATH)) {
      warnings.push(`${LEARNINGS_PATH} is listed in style_guide.files, so it is used as one guide, not as learnings`);
    } else {
      const file = await read(LEARNINGS_PATH);
      for (const l of file === null ? [] : parseLearnings(file.raw)) {
        if (!l.content.trim()) continue;
        drafts.push({
          path: LEARNINGS_PATH,
          origin: "learnings",
          title: l.title,
          scope: l.paths.length > 0 ? l.paths.map((g) => joinGlob("", g)) : ["**"],
          content: l.content,
          depth: 0,
          readCapped: file?.readCapped ?? false,
        });
      }
    }
  }

  const instructions = indexInstructions(config.path_instructions);
  const lengths = [...drafts.map((d) => d.content.length), ...instructions.map((i) => i.instructions.length)];
  const allowance = waterFill(lengths, cap);
  const notes: string[] = [];

  const guides = drafts.map((d, i): StyleGuide => {
    const limit = allowance[i] ?? 0;
    const truncated = d.readCapped || d.content.length > limit;
    if (truncated) {
      notes.push(truncationNote(`style guide ${d.path}`, d.content.length, limit, cap, d.readCapped));
    }
    return {
      id: `G${i + 1}`,
      path: d.path,
      origin: d.origin,
      ...(d.title === undefined ? {} : { title: d.title }),
      scope: d.scope,
      content: d.content.length > limit ? cut(d.content, limit) : d.content,
      originalChars: d.content.length,
      truncated,
    };
  });
  const cappedInstructions = instructions.map((pi, j) => {
    const limit = allowance[drafts.length + j] ?? 0;
    if (pi.instructions.length <= limit) return pi;
    notes.push(truncationNote(`path_instructions ${pi.id} (${pi.path})`, pi.instructions.length, limit, cap));
    return { ...pi, instructions: cut(pi.instructions, limit) };
  });

  const totalChars =
    guides.reduce((n, g) => n + g.content.length, 0) +
    cappedInstructions.reduce((n, pi) => n + pi.instructions.length, 0);
  return { guides, instructions: cappedInstructions, notes, warnings, skipped, totalChars };
}

/** True when the guide's scope covers `path`. */
export function guideApplies(guide: Pick<StyleGuide, "scope">, path: string): boolean {
  return guide.scope.some((g) => new Minimatch(g, GLOB_OPTIONS).match(path));
}

/** The guides that apply to `path`, in prompt order. */
export function guidesFor(path: string, guides: readonly StyleGuide[]): StyleGuide[] {
  return guides.filter((g) => guideApplies(g, path));
}

// ---------------------------------------------------------------------------

/** Directory a guide belongs to: its own dir, or the dir holding `.claude/` for rules files. */
export function guideRoot(path: string): string {
  if (path.startsWith(RULES_SEGMENT)) return "";
  const idx = path.indexOf(`/${RULES_SEGMENT}`);
  if (idx !== -1) return path.slice(0, idx);
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function isRulesFile(path: string): boolean {
  return path.startsWith(RULES_SEGMENT) || path.includes(`/${RULES_SEGMENT}`);
}

function dirScope(root: string): string {
  return root === "" ? "**" : `${escape(root)}/**`;
}

function joinGlob(root: string, glob: string): string {
  const g = glob.replace(/^\.?\//, "");
  return root === "" ? g : `${escape(root)}/${g}`;
}

interface ParsedGuide {
  body: string;
  /** `paths:` globs from frontmatter (rules files only); undefined = directory scope. */
  paths?: string[];
  warning?: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Strips YAML frontmatter; for `.claude/rules` files reads its `paths:` (string or list). */
export function parseGuide(path: string, raw: string): ParsedGuide {
  const text = raw.replace(/^\uFEFF/, "");
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { body: text };
  const body = text.slice(m[0].length);
  if (!isRulesFile(path)) return { body };

  let data: unknown;
  try {
    data = parseYaml(m[1] ?? "", { maxAliasCount: 0 });
  } catch {
    return { body, warning: `style guide ${path}: invalid frontmatter, applied to its whole directory` };
  }
  if (data === null || typeof data !== "object" || !("paths" in data)) return { body };
  const value: unknown = data.paths;
  const list =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value
        : null;
  const globs = list?.map((g) => g.trim()).filter((g) => g !== "");
  if (!globs || globs.length === 0) {
    return { body, warning: `style guide ${path}: "paths" must be a glob or a list of globs, applied to its whole directory` };
  }
  return { body, paths: globs };
}

/** Per-item allowances summing to at most `cap`: items under the fair share keep their length. */
export function waterFill(lengths: readonly number[], cap: number): number[] {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= cap) return [...lengths];
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  const out = new Array<number>(lengths.length).fill(0);
  let remaining = cap;
  let left = lengths.length;
  for (const { len, i } of order) {
    const share = Math.floor(remaining / left);
    const take = Math.min(len, share);
    out[i] = take;
    remaining -= take;
    left -= 1;
  }
  return out;
}

/** Cuts to `limit` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, limit: number): string {
  let out = s.slice(0, Math.max(0, limit));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function truncationNote(what: string, from: number, to: number, cap: number, readCapped = false): string {
  const n = (x: number): string => x.toLocaleString("en-US");
  const source = readCapped ? `more than ${n(from)}` : n(from);
  return `${what} truncated from ${source} to ${n(Math.min(from, to))} characters (style guide cap ${n(cap)})`;
}

function errorMessage(err: unknown): string {
  return ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim();
}

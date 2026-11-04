// Learnings file parser (design-v2 §6.1).
//
// `.myrabbit/learnings.md` is read from the BASE SHA only (src/config/style-guide.ts calls this
// when `learnings.enabled`), so a PR can never add a learning for its own review. A learning is
// trusted only because a human merged it.
//
// Format:
//   ## <title>                      one learning per `## ` section (not inside a code fence)
//   paths: <glob>[, <glob>]         optional; must be the section's first non-blank line
//   <text>                          the rule; anything before the first `## ` is ignored
//
// A section without `paths:` applies repo-wide. Sections with an empty body are dropped. The 60k
// style-guide cap is applied by the caller (each learning is one guide in the water-fill).

export const LEARNINGS_PATH = ".myrabbit/learnings.md";
/** Titles longer than this are cut; findings cite the title (`rule: "learning:<title>"`). */
export const MAX_LEARNING_TITLE_CHARS = 120;
/** At most this many globs per `paths:` line; the rest are ignored. */
export const MAX_LEARNING_GLOBS = 20;

export interface Learning {
  /** The `## ` section title; findings cite it as `rule: "learning:<title>"`. */
  title: string;
  /** Repo-relative globs from the `paths:` line; empty = repo-wide. */
  paths: string[];
  /** Section text without the heading and the `paths:` line. */
  content: string;
}

/** ATX h2; an optional closing `#` run needs a space before it (CommonMark), so "C#" stays. */
const HEADING = /^## +(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const PATHS_LINE = /^paths:(.*)$/i;

/** Parses the learnings file. Never throws. */
export function parseLearnings(text: string): Learning[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  let fence: string | null = null;

  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f?.[1] !== undefined) {
      const marker = f[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    }
    const h = fence === null && f === null ? HEADING.exec(line) : null;
    if (h) {
      current = { title: cleanTitle(h[1] ?? ""), body: [] };
      sections.push(current);
      continue;
    }
    current?.body.push(line);
  }

  const out: Learning[] = [];
  for (const s of sections) {
    if (s.title === "") continue;
    const body = [...s.body];
    while (body.length > 0 && (body[0] ?? "").trim() === "") body.shift();
    let paths: string[] = [];
    const m = PATHS_LINE.exec((body[0] ?? "").trim());
    if (m) {
      paths = parseGlobs(m[1] ?? "");
      body.shift();
    }
    const content = body.join("\n").trim();
    if (content === "") continue;
    out.push({ title: s.title, paths, content });
  }
  return out;
}

/** One line, inline markup and surrounding quotes kept as typed, length-capped. */
function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t.length <= MAX_LEARNING_TITLE_CHARS ? t : t.slice(0, MAX_LEARNING_TITLE_CHARS).trimEnd();
}

/**
 * `a, b` or `"a", \`b\``: comma-separated globs, quotes and backticks stripped. Absolute paths and
 * globs with a `..` segment can never match a repo-relative path, so they are dropped.
 */
export function parseGlobs(raw: string): string[] {
  return splitTopLevel(raw)
    .map((g) => g.trim().replace(/^(["'`])(.*)\1$/, "$2").trim().replace(/^\.\//, ""))
    .filter((g) => g !== "" && !g.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(g))
    .slice(0, MAX_LEARNING_GLOBS);
}

/** Splits on commas outside `{…}`, so a brace glob like `src/{a,b}/**` stays whole. */
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of raw) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(part);
      part = "";
    } else part += ch;
  }
  out.push(part);
  return out;
}

/**
 * A learning as a section to append to the learnings file (the §6.2 proposal snippet). It parses
 * back to the same learning with {@link parseLearnings}.
 */
export function formatLearning(l: Pick<Learning, "title" | "paths"> & { rule: string }): string {
  const title = cleanTitle(l.title).replace(/^#+\s*/, "") || "Learning";
  const paths = l.paths.length > 0 ? `paths: ${l.paths.join(", ")}\n` : "";
  // One line: a rule can never start a new `## ` section or a code fence.
  return `## ${title}\n${paths}\n${l.rule.replace(/\s+/g, " ").trim()}\n`;
}

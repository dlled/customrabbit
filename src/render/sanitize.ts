// Sanitizer for everything myrabbit posts (design §8.3, §9.3, §11).
//
// Model-written and PR-derived text is untrusted. Before it goes into a review body, an inline
// comment or the job summary it is:
//   1. passed through redact() from src/env.ts (known secret values + token shapes → ***);
//   2. stripped of anything that starts a myrabbit marker (`<!-- myrabbit`, any case/spacing),
//      repeated until none is left, so a model cannot forge state or finding markers;
//   3. in prose (outside code spans and fenced blocks): `&` and `<` become entities, so no raw
//      HTML (tags, comments, <details>, <img>) survives; `@mention` gets a zero-width space
//      (`@` + U+200B + `name`) so nobody is pinged; `![` becomes `!\[` so no remote image is loaded.
// Code (inline spans, fenced blocks, suggestion bodies) keeps its text: mentions and HTML do not
// render there, and escaping would corrupt the code. Unclosed fences are closed so model text
// cannot swallow the rest of a comment.
//
// The code/prose split is deliberately conservative: when in doubt a region is treated as prose
// (escaped), which can only cost cosmetics, never let HTML or a mention through.

import { redact } from "../env.js";
import { FORGED_MARKER_RE } from "./markers.js";

export const ZWSP = "​";

const FORGED_MARKER_FULL = /<!--\s*myrabbit[\s\S]*?-->/gi;
const FORGED_MARKER_OPEN = /<!--\s*myrabbit/gi;
/** Fence opener: up to 3 spaces, then ≥3 backticks or tildes. */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Removes every myrabbit marker (complete or just the opener) until none is left. */
export function stripMarkers(text: string): string {
  let out = text;
  while (FORGED_MARKER_RE.test(out)) {
    out = out.replace(FORGED_MARKER_FULL, "").replace(FORGED_MARKER_OPEN, "");
  }
  return out;
}

/** Escapes prose that is not inside any code: HTML, mentions, images. */
function escapeProse(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/(^|[^A-Za-z0-9_`])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`)
    .replace(/!\[/g, "!\\[");
}

/** Number of consecutive backslashes just before index i. */
function backslashesBefore(text: string, i: number): number {
  let n = 0;
  while (i - 1 - n >= 0 && text[i - 1 - n] === "\\") n++;
  return n;
}

/**
 * Escapes one line of prose, leaving inline code spans untouched. A span opens at an unescaped
 * backtick run and closes at the next run of exactly the same length on the same line; a run with
 * no closer is literal text and is treated as prose.
 */
function escapeLine(line: string): string {
  let out = "";
  let proseStart = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`" || backslashesBefore(line, i) % 2 === 1) {
      i++;
      continue;
    }
    let runEnd = i;
    while (line[runEnd] === "`") runEnd++;
    const run = runEnd - i;
    // Find a closing run of exactly `run` backticks.
    let j = runEnd;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let k = j;
      while (line[k] === "`") k++;
      if (k - j === run) {
        close = j;
        break;
      }
      j = k;
    }
    if (close === -1) {
      i = runEnd;
      continue;
    }
    out += escapeProse(line.slice(proseStart, i)) + line.slice(i, close + run);
    i = close + run;
    proseStart = i;
  }
  return out + escapeProse(line.slice(proseStart));
}

interface FenceState {
  char: string;
  len: number;
}

/** Fence-aware pass over block text: escapes prose lines, keeps fenced code, closes open fences. */
function escapeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: FenceState | null = null;
  for (const line of lines) {
    if (fence === null) {
      const m = FENCE_OPEN.exec(line);
      const marker = m?.[2];
      // A backtick fence's info string may not contain backticks (CommonMark).
      if (m && marker && !(marker.startsWith("`") && (m[3] ?? "").includes("`"))) {
        fence = { char: marker.charAt(0), len: marker.length };
        out.push(line);
        continue;
      }
      out.push(escapeLine(line));
      continue;
    }
    out.push(line);
    const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
    if (close.test(line)) fence = null;
  }
  if (fence !== null) out.push(fence.char.repeat(fence.len));
  return out.join("\n");
}

/** Closes a fence left open at the end of already-sanitized block text. */
function closeOpenFence(text: string): string {
  let fence: FenceState | null = null;
  for (const line of text.split("\n")) {
    if (fence === null) {
      const m = FENCE_OPEN.exec(line);
      const marker = m?.[2];
      if (m && marker && !(marker.startsWith("`") && (m[3] ?? "").includes("`"))) {
        fence = { char: marker.charAt(0), len: marker.length };
      }
      continue;
    }
    const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
    if (close.test(line)) fence = null;
  }
  return fence === null ? text : `${text}\n${fence.char.repeat(fence.len)}`;
}

/** Cuts a string to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Truncates single-line text to `max` chars, ending in "…" when cut. */
export function truncateInline(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${cut(text, max - 1)}…`;
}

/**
 * Truncates sanitized block markdown to `max` chars, ending in "…" and closing any fence the cut
 * left open. The result is always ≤ max.
 */
export function truncateBlock(text: string, max: number): string {
  if (text.length <= max) return text;
  let limit = max - 1;
  for (;;) {
    const candidate = closeOpenFence(`${cut(text, limit)}…`);
    if (candidate.length <= max || limit <= 0) return candidate.length <= max ? candidate : "…";
    limit -= candidate.length - max;
  }
}

/** Smallest backtick fence that cannot be closed by anything inside `content` (≥ 3). */
export function fenceFor(content: string, char = "`"): string {
  let longest = 0;
  const runs = content.match(char === "`" ? /`+/g : /~+/g) ?? [];
  for (const r of runs) longest = Math.max(longest, r.length);
  return char.repeat(Math.max(3, longest + 1));
}

/**
 * Renders `text` as an inline code span, choosing a backtick run longer than any inside it.
 * Input must already be sanitized as code (see Sanitizer.code).
 */
export function inlineCode(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ");
  let longest = 0;
  for (const r of flat.match(/`+/g) ?? []) longest = Math.max(longest, r.length);
  const ticks = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") || flat === "" ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/**
 * Per-render sanitizer. Every string that came from a model, the PR or the repository goes
 * through one of its methods; it counts how many strings needed redaction (§9.3: a non-zero
 * count is a prompt-injection signal).
 */
export class Sanitizer {
  #redactions = 0;

  get redactions(): number {
    return this.#redactions;
  }

  /** redact() and count. */
  redact(text: string): string {
    const out = redact(text);
    if (out !== text) this.#redactions++;
    return out;
  }

  /** True when `text` contains something redact() would replace. Does not count. */
  needsRedaction(text: string): boolean {
    return redact(text) !== text;
  }

  /** Block markdown (bodies, failure scenarios, summaries): fences kept and balanced. */
  block(text: string): string {
    return escapeBlocks(stripMarkers(this.redact(text.replace(/\r\n?/g, "\n"))));
  }

  /** Single-line markdown (titles, list items, notes): whitespace collapsed, spans kept. */
  inline(text: string): string {
    return escapeLine(stripMarkers(this.redact(text.replace(/\s+/g, " ").trim())));
  }

  /** A GFM table cell: inline() plus escaped pipes. */
  cell(text: string): string {
    return this.inline(text).replace(/\|/g, "\\|");
  }

  /** Code (suggestion bodies, paths shown as code): redacted and marker-free, otherwise verbatim. */
  code(text: string): string {
    return stripMarkers(this.redact(text.replace(/\r\n?/g, "\n")));
  }

  /** A value shown as inline code, e.g. a file path. */
  codeSpan(text: string): string {
    return inlineCode(this.code(text));
  }
}

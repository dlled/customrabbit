// Unified diff parser and anchor map (design §8.2).
//
// Input is `git diff` output produced by src/github/git.ts (fixed a/ b/ prefixes, no color,
// rename detection on). The anchor map is the set of (path, side, line) tuples GitHub accepts
// for inline review comments: added and context lines are RIGHT, deleted lines are LEFT.
// A multi-line range must lie in one hunk on one side.

import type { Side } from "../types.js";

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffLine {
  kind: "add" | "del" | "context";
  /** Old-file line number (deleted and context lines). */
  oldLine: number | null;
  /** New-file line number (added and context lines). */
  newLine: number | null;
  text: string;
}

export interface Hunk {
  /** Index within the file, 0-based. */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@ ... @@` header line, verbatim. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** New path (old path for deletions). Repo-relative, unquoted. */
  path: string;
  /** Old path; differs from `path` only for renames. */
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** The file's section of the diff, verbatim (for prompts). */
  patch: string;
  /** UTF-8 byte length of `patch` (for limits.max_diff_bytes). */
  bytes: number;
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decode a git C-style quoted path (`"a/x\tb"`, octal escapes for non-ASCII bytes). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) throw new DiffParseError("malformed quoted path");
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body.charAt(i + 1);
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next] ?? 0);
      i += 1;
    } else {
      throw new DiffParseError("malformed escape in quoted path");
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Path from a `--- a/x` / `+++ b/x` line; null for /dev/null. */
function pathFromMarkerLine(rest: string, prefix: "a/" | "b/"): string | null {
  // git appends a TAB after names that contain a space.
  let raw = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  if (raw === "/dev/null") return null;
  raw = unquoteGitPath(raw);
  if (!raw.startsWith(prefix)) throw new DiffParseError(`unexpected path prefix in diff: ${prefix}`);
  return raw.slice(prefix.length);
}

/** `diff --git a/x b/x` → path, used only when ---/+++ lines are absent (binary, mode-only, pure rename). */
function pathsFromGitHeader(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(rest);
    if (!m?.[1] || !m[2]) return null;
    const a = unquoteGitPath(m[1]);
    const b = unquoteGitPath(m[2]);
    return a.startsWith("a/") && b.startsWith("b/") ? { oldPath: a.slice(2), newPath: b.slice(2) } : null;
  }
  if (rest.endsWith('"')) {
    const m = /^(a\/.*) ("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (!m?.[1] || !m[2]) return null;
    const b = unquoteGitPath(m[2]);
    return b.startsWith("b/") ? { oldPath: m[1].slice(2), newPath: b.slice(2) } : null;
  }
  // Unquoted: "a/<p> b/<p>". Without a rename both halves are equal, so split in the middle.
  if (!rest.startsWith("a/")) return null;
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.charAt(half) === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (b.startsWith("b/") && a.slice(2) === b.slice(2)) return { oldPath: a.slice(2), newPath: b.slice(2) };
  }
  const idx = rest.indexOf(" b/");
  if (idx < 0) return null;
  return { oldPath: rest.slice(2, idx), newPath: rest.slice(idx + 3) };
}

interface FileBuilder {
  headerLine: string;
  lines: string[];
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  hunks: Hunk[];
}

/** Parse `git diff` output into files. Throws DiffParseError on malformed input. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (text.trim() === "") return files;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  let cur: FileBuilder | null = null;
  let hunk: Hunk | null = null;
  let oldNext = 0;
  let newNext = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = (): void => {
    if (!cur) return;
    if (hunk && (oldLeft > 0 || newLeft > 0)) throw new DiffParseError("truncated hunk");
    files.push(buildFile(cur));
    cur = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      cur = {
        headerLine: line,
        lines: [line],
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDeleted: false,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!cur) {
      throw new DiffParseError("diff does not start with a 'diff --git' header");
    }
    const file: FileBuilder = cur;
    file.lines.push(line);

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line.charAt(0);
      const body = line.slice(1);
      if (tag === "+") {
        if (newLeft <= 0) throw new DiffParseError("hunk has more added lines than its header");
        hunk.lines.push({ kind: "add", oldLine: null, newLine: newNext, text: body });
        newNext++;
        newLeft--;
      } else if (tag === "-") {
        if (oldLeft <= 0) throw new DiffParseError("hunk has more deleted lines than its header");
        hunk.lines.push({ kind: "del", oldLine: oldNext, newLine: null, text: body });
        oldNext++;
        oldLeft--;
      } else if (tag === " " || line === "") {
        if (oldLeft <= 0 || newLeft <= 0) throw new DiffParseError("hunk has more context lines than its header");
        hunk.lines.push({ kind: "context", oldLine: oldNext, newLine: newNext, text: body });
        oldNext++;
        newNext++;
        oldLeft--;
        newLeft--;
      } else if (tag === "\\") {
        // "\ No newline at end of file"
      } else {
        throw new DiffParseError("unexpected line inside hunk");
      }
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline" right after the last hunk line

    const m = HUNK_HEADER.exec(line);
    if (m) {
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { index: file.hunks.length, oldStart, oldLines, newStart, newLines, header: line, lines: [] };
      file.hunks.push(hunk);
      oldNext = oldStart;
      newNext = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }
    if (file.hunks.length > 0) {
      throw new DiffParseError("unexpected line after hunk");
    }
    if (line.startsWith("--- ")) file.oldPath = pathFromMarkerLine(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) file.newPath = pathFromMarkerLine(line.slice(4), "b/");
    else if (line.startsWith("rename from ")) file.renameFrom = unquoteGitPath(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) file.renameTo = unquoteGitPath(line.slice("rename to ".length));
    else if (line.startsWith("new file mode ")) file.isNew = true;
    else if (line.startsWith("deleted file mode ")) file.isDeleted = true;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
    // index, mode, similarity, copy lines: ignored
  }
  finish();
  return files;
}

function buildFile(b: FileBuilder): DiffFile {
  const header = pathsFromGitHeader(b.headerLine);
  const oldPath = b.renameFrom ?? b.oldPath ?? header?.oldPath ?? b.newPath;
  const newPath = b.renameTo ?? b.newPath ?? header?.newPath ?? b.oldPath;
  if (oldPath == null || newPath == null) throw new DiffParseError("cannot determine file path");
  const isDeleted = b.isDeleted || (b.newPath === null && b.oldPath !== null && b.lines.some((l) => l === "+++ /dev/null"));
  const isNew = b.isNew || b.lines.some((l) => l === "--- /dev/null");
  const status: FileStatus = isNew
    ? "added"
    : isDeleted
      ? "deleted"
      : b.renameFrom !== null || oldPath !== newPath
        ? "renamed"
        : "modified";
  let additions = 0;
  let deletions = 0;
  for (const h of b.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }
  const patch = b.lines.join("\n") + "\n";
  return {
    path: status === "deleted" ? oldPath : newPath,
    oldPath,
    status,
    binary: b.binary,
    hunks: b.hunks,
    additions,
    deletions,
    patch,
    bytes: Buffer.byteLength(patch, "utf8"),
  };
}

// ---------------------------------------------------------------------------
// Anchor map
// ---------------------------------------------------------------------------

export interface AnchorRange {
  path: string;
  side: Side;
  /** First line (GitHub `start_line`, or `line` for a single-line comment). */
  startLine: number;
  /** Last line (GitHub `line`), >= startLine. */
  endLine: number;
}

/** One commentable line; field names match src/merge's `AnchorTuple`. */
export interface AnchorTuple {
  path: string;
  side: Side;
  line: number;
  /** Hunk index within the file. */
  hunk: number;
}

export type AnchorCheck =
  | { ok: true; hunk: number }
  | { ok: false; reason: "unknown_path" | "binary" | "not_in_diff" | "bad_range" | "crosses_hunks" };

/**
 * Set of commentable (path, side, line) tuples. Built from the merge-base diff (§8.2), so it
 * covers the whole PR, also in incremental mode.
 */
export class AnchorMap {
  /** path → side → line → hunk index */
  readonly #anchors = new Map<string, Record<Side, Map<number, number>>>();
  readonly #binary = new Set<string>();

  constructor(files: readonly DiffFile[]) {
    for (const f of files) {
      if (f.binary) {
        this.#binary.add(f.path);
        continue;
      }
      const sides: Record<Side, Map<number, number>> = { RIGHT: new Map(), LEFT: new Map() };
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.kind === "del" && l.oldLine !== null) sides.LEFT.set(l.oldLine, h.index);
          else if (l.newLine !== null) sides.RIGHT.set(l.newLine, h.index);
        }
      }
      this.#anchors.set(f.path, sides);
    }
  }

  /** Paths of text files in the diff. */
  paths(): string[] {
    return [...this.#anchors.keys()];
  }

  hasPath(path: string): boolean {
    return this.#anchors.has(path);
  }

  /** Every anchor as `{ path, side, line, hunk }` (the shape src/merge's `AnchorTuple` uses). */
  tuples(): AnchorTuple[] {
    const out: AnchorTuple[] = [];
    for (const [path, sides] of this.#anchors) {
      for (const side of ["RIGHT", "LEFT"] as const) {
        for (const [line, hunk] of sides[side]) out.push({ path, side, line, hunk });
      }
    }
    return out;
  }

  /**
   * `check()` as a boolean, with src/merge's `AnchorMap.isAnchored(path, side, line, endLine)`
   * signature, so this class can be passed to the merge step directly.
   */
  isAnchored(path: string, side: Side, line: number, endLine: number | null): boolean {
    return this.check({ path, side, startLine: line, endLine: endLine ?? line }).ok;
  }

  has(path: string, side: Side, line: number): boolean {
    return this.#anchors.get(path)?.[side].has(line) ?? false;
  }

  /** Lines on `side` of `path` that can carry a comment, ascending. */
  lines(path: string, side: Side): number[] {
    const m = this.#anchors.get(path)?.[side];
    return m ? [...m.keys()].sort((a, b) => a - b) : [];
  }

  /** Validate a single line or a multi-line range: both ends anchored, same side, same hunk. */
  check(range: AnchorRange): AnchorCheck {
    const sides = this.#anchors.get(range.path);
    if (!sides) return { ok: false, reason: this.#binary.has(range.path) ? "binary" : "unknown_path" };
    const { startLine, endLine } = range;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      return { ok: false, reason: "bad_range" };
    }
    const lines = sides[range.side];
    const a = lines.get(startLine);
    const b = lines.get(endLine);
    if (a === undefined || b === undefined) return { ok: false, reason: "not_in_diff" };
    if (a !== b) return { ok: false, reason: "crosses_hunks" };
    return { ok: true, hunk: a };
  }
}

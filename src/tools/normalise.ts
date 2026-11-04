// design-v2 §7.4 step 1: each tool's output → { tool, rule, path, line, message }, with a severity
// rank for ordering (0 = most severe). Paths are mapped back from absolute staging paths to
// repo-relative ones; a path outside the staging dir is dropped. Messages are redacted and capped.
// gitleaks never yields its matched value (it runs with --redact, and only RuleID and the location
// are read here).

import { posix } from "node:path";

import { redact } from "../env.js";
import type { ToolName } from "../types.js";

export interface RawHit {
  tool: ToolName;
  rule: string;
  /** Repo-relative. */
  path: string;
  /** 1-based head line. */
  line: number;
  message: string;
  /** 0 = most severe. */
  rank: number;
  /** gitleaks only: last line of a multi-line leak. */
  endLine?: number;
}

export class ParseError extends Error {
  override readonly name = "ParseError";
}

export const MAX_MESSAGE_CHARS = 500;
const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

export interface PathContext {
  stage: string;
  /** The tools' working directory (actionlint prints paths relative to it). */
  cwd: string;
}

function repoPath(p: unknown, ctx: PathContext): string | null {
  if (typeof p !== "string" || p === "") return null;
  const abs = posix.isAbsolute(p) ? posix.normalize(p) : posix.resolve(ctx.cwd, p);
  const prefix = ctx.stage.endsWith("/") ? ctx.stage : `${ctx.stage}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

function message(text: unknown): string {
  const flat = (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
  const out = redact(flat);
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…` : out;
}

function rule(r: unknown): string | null {
  const s = typeof r === "number" ? String(r) : typeof r === "string" ? r : "";
  return RULE_RE.test(s) ? s : null;
}

const posInt = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null);

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ParseError("output is not JSON");
  }
}

function array(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(`${what} is not an array`);
  return v;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});

const LEVEL_RANK: Record<string, number> = { error: 0, high: 0, warning: 1, medium: 1, info: 2, low: 2, style: 3, informational: 3 };
const rankOf = (level: unknown, dflt = 1): number => (typeof level === "string" ? (LEVEL_RANK[level.toLowerCase()] ?? dflt) : dflt);

function push(out: RawHit[], tool: ToolName, r: unknown, path: string | null, line: number | null, msg: unknown, rank: number): void {
  const id = rule(r);
  if (id === null || path === null || line === null) return;
  out.push({ tool, rule: tool === "shellcheck" ? `SC${id}` : id, path, line, message: message(msg), rank });
}

/** Parses one tool's stdout. Throws {@link ParseError} on output the tool would never produce. */
export function parseToolOutput(tool: ToolName, stdout: string, ctx: PathContext): RawHit[] {
  const out: RawHit[] = [];
  switch (tool) {
    case "shellcheck": {
      for (const c of array(obj(json(stdout)).comments, "comments")) {
        const o = obj(c);
        push(out, tool, o.code, repoPath(o.file, ctx), posInt(o.line), o.message, rankOf(o.level));
      }
      return out;
    }
    case "actionlint": {
      for (const e of array(json(stdout), "errors")) {
        const o = obj(e);
        push(out, tool, o.kind, repoPath(o.filepath, ctx), posInt(o.line), o.message, 1);
      }
      return out;
    }
    case "hadolint": {
      for (const e of array(json(stdout), "results")) {
        const o = obj(e);
        push(out, tool, o.code, repoPath(o.file, ctx), posInt(o.line), o.message, rankOf(o.level));
      }
      return out;
    }
    case "zizmor": {
      for (const f of array(json(stdout), "findings")) {
        const o = obj(f);
        const rank = rankOf(obj(o.determinations).severity, 2);
        for (const l of Array.isArray(o.locations) ? o.locations : []) {
          const sym = obj(obj(l).symbolic);
          if (sym.kind !== "Primary") continue;
          const path = repoPath(obj(obj(sym.key).Local).verbatim_path, ctx);
          // json-v1 rows are 0-based.
          const row = obj(obj(obj(obj(l).concrete).location).start_point).row;
          const line = typeof row === "number" && Number.isInteger(row) && row >= 0 ? row + 1 : null;
          push(out, tool, o.ident, path, line, o.desc, rank);
        }
      }
      return out;
    }
    case "ruff": {
      for (const d of array(json(stdout), "diagnostics")) {
        const o = obj(d);
        push(out, tool, o.code, repoPath(o.filename, ctx), posInt(obj(o.location).row), o.message, 1);
      }
      return out;
    }
    case "yamllint": {
      // parsable: <path>:<line>:<col>: [<level>] <message> (<rule>)
      const re = /^(.+?):(\d+):(\d+): \[(error|warning)\] (.*?)(?: \(([A-Za-z0-9-]+)\))?$/;
      for (const row of stdout.split("\n")) {
        if (row.trim() === "") continue;
        const m = re.exec(row);
        if (!m) throw new ParseError("unexpected yamllint line");
        push(out, tool, m[6] ?? "syntax", repoPath(m[1], ctx), posInt(Number(m[2])), m[5], m[4] === "error" ? 1 : 2);
      }
      return out;
    }
    case "squawk": {
      if (stdout.trim() === "") return out;
      for (const v of array(json(stdout), "violations")) {
        const o = obj(v);
        // squawk's JSON lines are 0-based.
        const line = typeof o.line === "number" && Number.isInteger(o.line) && o.line >= 0 ? o.line + 1 : null;
        push(out, tool, o.rule_name, repoPath(o.file, ctx), line, o.message, rankOf(o.level));
      }
      return out;
    }
    case "gitleaks": {
      for (const l of array(json(stdout), "leaks")) {
        const o = obj(l);
        // A leak that cannot be placed is a missed secret, not a dropped hit: fail closed (§7.5).
        const id = rule(o.RuleID);
        const path = repoPath(o.File, ctx);
        const line = posInt(o.StartLine);
        if (id === null || path === null || line === null) throw new ParseError("gitleaks leak without a valid rule or location");
        const end = posInt(o.EndLine);
        // Only the rule and location: never Match, Secret or the description of the value.
        out.push({
          tool,
          rule: id,
          path,
          line,
          message: `Possible secret (${id})`,
          rank: 0,
          ...(end !== null && end > line ? { endLine: end } : {}),
        });
      }
      return out;
    }
  }
}

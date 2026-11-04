// CODEOWNERS (§4.7 step 1), read from the BASE commit as a git blob (design-v2 §1.1). GitHub uses the
// first of `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`; for each file the LAST matching
// pattern wins. Patterns follow GitHub's gitignore subset: no `!` negation and no `[]` ranges
// (such lines are ignored, as GitHub does).

import { Minimatch } from "minimatch";

import type { TreeIndex } from "../context/git.js";

export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
/** GitHub ignores a CODEOWNERS file over 3 MB. */
const MAX_CODEOWNERS_CHARS = 3 * 1024 * 1024;

export interface CodeownersRule {
  pattern: string;
  /** `user` or `org/team` (without "@"); email owners are dropped. */
  owners: string[];
  matchers: Minimatch[];
}

const OWNER = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?)$/;
const OPTS = { dot: true, nocomment: true, nonegate: true } as const;

/** gitignore-style pattern → minimatch globs (the path itself, and everything under it). */
function globsFor(pattern: string): string[] {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  if (p === "") return [];
  if (p === "*" && !anchored) return ["**"];
  const base = anchored ? p : `**/${p}`;
  if (dirOnly) return [`${base}/**`];
  // `docs/*` owns docs/a.md but not docs/sub/b.md (GitHub docs); a plain name also owns its subtree.
  const last = p.slice(p.lastIndexOf("/") + 1);
  return last.includes("*") ? [base] : [base, `${base}/**`];
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.slice(0, MAX_CODEOWNERS_CHARS).split(/\r?\n/)) {
    // `#` starts a comment unless escaped.
    const line = raw.replace(/(^|[^\\])#.*$/, "$1").trim();
    if (line === "") continue;
    const [pattern, ...rest] = line.split(/\s+/);
    if (!pattern || pattern.startsWith("!") || /[[\]]/.test(pattern)) continue;
    const owners = rest.flatMap((o) => {
      const m = OWNER.exec(o);
      return m?.[1] ? [m[1]] : [];
    });
    const unescaped = pattern.replace(/\\(.)/g, "$1");
    rules.push({ pattern: unescaped, owners, matchers: globsFor(unescaped).map((g) => new Minimatch(g, OPTS)) });
  }
  return rules;
}

/** Owners of one path: the last matching rule's (possibly empty) owner list. */
export function ownersOf(rules: readonly CodeownersRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r?.matchers.some((m) => m.match(path))) return r.owners;
  }
  return [];
}

/** The first CODEOWNERS file of the base tree, parsed; empty when there is none. */
export async function loadCodeowners(base: TreeIndex): Promise<CodeownersRule[]> {
  for (const p of CODEOWNERS_PATHS) {
    if (!base.has(p)) continue;
    const text = await base.read(p);
    return text === null ? [] : parseCodeowners(text);
  }
  return [];
}

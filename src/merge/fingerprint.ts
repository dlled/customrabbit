// §7.1 fingerprint: sha1(path \0 category \0 normalize(title))[:12]. No line number, so it survives
// code moving.

import { createHash } from "node:crypto";
import type { Category } from "../types.js";

/**
 * Lowercase; strip backticked identifiers, punctuation and digits; collapse whitespace.
 * Stripped characters become spaces so adjacent words never glue together.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/`[^`]*`/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(path: string, category: Category, title: string): string {
  return createHash("sha1")
    .update(`${path}\0${category}\0${normalizeTitle(title)}`)
    .digest("hex")
    .slice(0, 12);
}

/** Title tokens for the clustering Jaccard (§7.2 step 3). */
export function titleTokens(title: string): Set<string> {
  const n = normalizeTitle(title);
  return new Set(n === "" ? [] : n.split(" "));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

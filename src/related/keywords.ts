// §4.6 search keywords. Only tokens matching `[A-Za-z0-9_]{2,40}` survive, so no `:`, quote,
// qualifier or operator from a PR title (untrusted) can reach the search query; each kept token is
// double-quoted.

/** A token that may appear (quoted) in a search query. */
export const SAFE_TOKEN = /^[A-Za-z0-9_]{2,40}$/;

/** Title tokens taken (the §4.6 "5 most distinctive"). */
export const MAX_TITLE_TOKENS = 5;
/**
 * Terms in one query. The terms are joined with OR (an implicit AND of ten terms would match almost
 * nothing), and GitHub search allows at most five AND/OR/NOT operators, hence six terms.
 */
export const MAX_QUERY_TERMS = 6;
/** GitHub rejects longer `q` values. */
export const MAX_QUERY_CHARS = 256;

/** Common words and conventional-commit verbs: never distinctive. */
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on",
  "or", "the", "to", "with", "without", "when", "not", "no", "use", "uses", "using", "via", "this", "that",
  "add", "adds", "added", "fix", "fixes", "fixed", "update", "updates", "updated", "remove", "removes",
  "removed", "change", "changes", "changed", "make", "makes", "improve", "improves", "support", "allow",
  "feat", "chore", "docs", "doc", "refactor", "test", "tests", "ci", "build", "perf", "style", "revert",
  "wip", "draft", "bump", "deps", "dep", "new", "more", "some", "all", "only", "also", "then", "should",
]);

/** Splits untrusted text into safe tokens (every `:` and other non-word char is a separator). */
export function safeTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_]+/).filter((t) => SAFE_TOKEN.test(t));
}

/**
 * The most distinctive title tokens: stopwords and pure numbers dropped, longer tokens first,
 * then earlier ones. Case-insensitive dedupe.
 */
export function titleKeywords(title: string, max = MAX_TITLE_TOKENS): string[] {
  const seen = new Set<string>();
  const kept: { t: string; i: number }[] = [];
  for (const [i, t] of safeTokens(title).entries()) {
    const k = t.toLowerCase();
    if (STOP.has(k) || /^\d+$/.test(t) || seen.has(k)) continue;
    seen.add(k);
    kept.push({ t, i });
  }
  kept.sort((a, b) => b.t.length - a.t.length || a.i - b.i);
  return kept.slice(0, max).map((x) => x.t);
}

/**
 * The issue search query: `repo:<o>/<r> is:issue ("t1" OR "t2" …)`, or null without any term.
 * `owner`/`repo` come from the runner (GITHUB_REPOSITORY), not from the PR.
 */
export function issueQuery(owner: string, repo: string, title: string, symbols: readonly string[]): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const t of [...titleKeywords(title), ...symbols.filter((s) => SAFE_TOKEN.test(s))]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    terms.push(t);
  }
  if (terms.length === 0) return null;
  const prefix = `repo:${owner}/${repo} is:issue `;
  let q = "";
  let n = 0;
  for (const t of terms) {
    if (n >= MAX_QUERY_TERMS) break;
    const next = n === 0 ? `"${t}"` : `${q} OR "${t}"`;
    if (prefix.length + next.length + 2 > MAX_QUERY_CHARS) break;
    q = next;
    n++;
  }
  return n === 1 ? `${prefix}${q}` : `${prefix}(${q})`;
}

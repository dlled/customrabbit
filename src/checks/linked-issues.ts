// §5.5 linked issues: closing keywords in the PR body, same repository only, at most 5.
//
// The keywords and forms are GitHub's ("close", "closes", "closed", "fix", "fixes", "fixed",
// "resolve", "resolves", "resolved", optionally followed by a colon, any case; `#N`,
// `OWNER/REPO#N` or the issue URL):
// https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
// Another repository's issue is ignored. Fenced and inline code is ignored, so an example in a code
// block links nothing. The issues are fetched with the App token (Issues read) and are **data
// only**: their title and body go into the untrusted `<linked-issues>` block.

import type { GitHub, RepoRef } from "../github/client.js";
import type { LinkedIssue } from "../prompts/builder.js";

/** §5.5: at most this many linked issues. */
export const MAX_LINKED_ISSUES = 5;
/** Each issue body is cut to this many characters before it reaches the prompt. */
export const LINKED_ISSUE_BODY_CHARS = 4_000;

const KEYWORD = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const NAME = "[A-Za-z0-9](?:[A-Za-z0-9-]*)";
const REPO = "[A-Za-z0-9._-]+";
// `#12`, `owner/repo#12`, or `https://github.com/owner/repo/issues/12`.
const REF = `(?:(${NAME})/(${REPO}))?#(\\d+)|https://github\\.com/(${NAME})/(${REPO})/issues/(\\d+)`;
const CLOSING = new RegExp(`(?<![\\w/-])${KEYWORD}:?[ \\t]+(?:${REF})(?![\\w-])`, "gi");

function stripCode(body: string): string {
  return body
    // A fence runs to its closing fence, or to the end of the body when it is never closed
    // (as GitHub renders it). A closing fence is bare: only trailing spaces or tabs, no info string.
    .replace(/^(```|~~~)[^\n]*(?:\n[\s\S]*?^\1[ \t]*$|[\s\S]*)/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Issue numbers the PR body closes in `repo`, in order of first mention, deduplicated, ≤ 5. */
export function closingIssueNumbers(body: string | null | undefined, repo: RepoRef): number[] {
  const out: number[] = [];
  for (const m of stripCode(body ?? "").matchAll(CLOSING)) {
    const owner = m[1] ?? m[4];
    const name = m[2] ?? m[5];
    const n = Number(m[3] ?? m[6]);
    if (owner !== undefined && name !== undefined && !(same(owner, repo.owner) && same(name, repo.repo))) continue;
    if (!Number.isSafeInteger(n) || n < 1 || out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_LINKED_ISSUES) break;
  }
  return out;
}

/**
 * Fetches the linked issues. A number that is a pull request, missing or not readable is skipped:
 * the check then sees fewer (or no) issues. Never throws.
 */
export async function fetchLinkedIssues(gh: GitHub, repo: RepoRef, numbers: readonly number[]): Promise<LinkedIssue[]> {
  const out: LinkedIssue[] = [];
  for (const n of numbers.slice(0, MAX_LINKED_ISSUES)) {
    try {
      const { data } = await gh.rest.issues.get({ ...repo, issue_number: n });
      if (data.pull_request) continue;
      out.push({ number: n, title: data.title, body: cut(data.body ?? "", LINKED_ISSUE_BODY_CHARS) });
    } catch {
      // 404, 410 (deleted), 403: not linkable.
    }
  }
  return out;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// PR fetch and the eligibility check of design §10.1.

import type { GitHub, RepoRef } from "./client.js";

export interface PullRequestInfo {
  number: number;
  /** "open" | "closed" as GitHub reports it. */
  state: string;
  merged: boolean;
  draft: boolean;
  title: string;
  /** PR description; "" when empty. Untrusted (§6.2 pr-meta). */
  body: string;
  labels: string[];
  /** PR author login (REST form, e.g. `dlled` or `foo[bot]`). */
  author: string;
  htmlUrl: string;
  head: { sha: string; ref: string; /** null when the head repository was deleted. */ repoFullName: string | null };
  base: { sha: string; ref: string; repoFullName: string };
}

export async function fetchPullRequest(gh: GitHub, repo: RepoRef, pullNumber: number): Promise<PullRequestInfo> {
  const { data } = await gh.rest.pulls.get({ ...repo, pull_number: pullNumber });
  return {
    number: data.number,
    state: data.state,
    merged: data.merged,
    draft: data.draft ?? false,
    title: data.title,
    body: data.body ?? "",
    labels: data.labels.map((l) => l.name),
    author: data.user.login,
    htmlUrl: data.html_url,
    head: { sha: data.head.sha, ref: data.head.ref, repoFullName: (data.head.repo as { full_name: string } | null)?.full_name ?? null },
    base: { sha: data.base.sha, ref: data.base.ref, repoFullName: data.base.repo.full_name },
  };
}

export type IneligibleReason = "not_open" | "fork" | "untrusted_author" | "head_mismatch";

export type Eligibility = { ok: true } | { ok: false; reasons: IneligibleReason[]; message: string };

export interface EligibilityInput {
  /** Logins allowed to have their PRs reviewed (MYRABBIT_TRUSTED_AUTHORS, §10.1). */
  trustedAuthors: readonly string[];
  /** `git rev-parse HEAD` of the checkout. */
  checkedOutHead: string;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * §10.1: eligible only if the PR is open, not from a fork, authored by a trusted login
 * (case-insensitive, as GitHub logins are), and the checkout is the PR head. Runs on both
 * workflow_dispatch and pull_request events. The orchestrator refuses (exit 1, no model call) on any
 * failed check, except when `not_open` is the only reason: a PR merged or closed while queued is a
 * neutral skip (exit 0).
 */
export function checkEligibility(pr: PullRequestInfo, input: EligibilityInput): Eligibility {
  const reasons: IneligibleReason[] = [];
  const details: string[] = [];
  if (pr.state !== "open" || pr.merged) {
    reasons.push("not_open");
    details.push(`PR #${pr.number} is not open`);
  }
  if (pr.head.repoFullName === null || lower(pr.head.repoFullName) !== lower(pr.base.repoFullName)) {
    reasons.push("fork");
    details.push("head repository differs from base repository (fork or deleted)");
  }
  const trusted = new Set(input.trustedAuthors.map(lower));
  if (!trusted.has(lower(pr.author))) {
    reasons.push("untrusted_author");
    details.push(`author ${pr.author} is not in trusted authors`);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.checkedOutHead) || lower(input.checkedOutHead) !== lower(pr.head.sha)) {
    reasons.push("head_mismatch");
    details.push("checked-out HEAD does not match the PR head SHA");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons, message: details.join("; ") };
}

// Auto-review skip conditions (design §4 `auto_review`): the run exits 0 with no review and the job
// summary says why. They apply to pull_request events only: a workflow_dispatch is an explicit
// request for a full review (§10.1).

import type { AutoReviewConfig } from "../types.js";

export interface AutoReviewPr {
  draft: boolean;
  title: string;
  labels: readonly string[];
}

/** Why the PR is skipped, or null when it is reviewed. */
export function autoReviewSkipReason(config: AutoReviewConfig, pr: AutoReviewPr): string | null {
  if (!config.enabled) return "auto_review.enabled is false";
  if (pr.draft && !config.drafts) return "draft PR (auto_review.drafts is false)";
  const title = pr.title.toLowerCase();
  const keyword = config.ignore_title_keywords.find((k) => k.trim() !== "" && title.includes(k.trim().toLowerCase()));
  if (keyword !== undefined) return `title contains "${keyword}"`;

  const present = new Set(pr.labels.map((l) => l.toLowerCase()));
  const excluded: string[] = [];
  const required: string[] = [];
  for (const raw of config.labels) {
    const label = raw.trim();
    if (label.startsWith("!")) {
      const name = label.slice(1).trim();
      if (name !== "") excluded.push(name);
    } else if (label !== "") {
      required.push(label);
    }
  }
  const hit = excluded.find((l) => present.has(l.toLowerCase()));
  if (hit !== undefined) return `label "${hit}" is present`;
  if (required.length > 0 && !required.some((l) => present.has(l.toLowerCase()))) {
    return `none of the labels ${required.map((l) => `"${l}"`).join(", ")} is present`;
  }
  return null;
}

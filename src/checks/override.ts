// §5.4 override (Q18 = yes): the label `myrabbit:ignore-checks` drops the pre-merge check
// blockers, and only them. It counts only when the sender that applied it is in
// `trusted_authors`, as read from the PR's timeline events (Pull requests read). Pure, apart from
// the optional fetch helper.
//
// The last `labeled`/`unlabeled` event for the label decides:
// - `unlabeled` → not applied;
// - `labeled` by a trusted human login (case-insensitive; bots and Apps never count) → applied, with
//   who and when for the body;
// - `labeled` by anyone else → not applied, even if a trusted login applied it earlier: removing
//   and re-adding the label hands the decision to the last sender.
// The label must also be on the PR now (the event list and the PR's labels agree). Events that could
// not be read (null) give `unreadable`: no override, the blockers stay.

import type { GitHub, RepoRef } from "../github/client.js";
import type { SyntheticBlocker } from "../merge/verdict.js";

export const OVERRIDE_LABEL = "myrabbit:ignore-checks";

/** The fields of a timeline (or issue) event that the check reads. */
export interface LabelEvent {
  event: string;
  created_at?: string | null;
  actor?: { login?: string | null; type?: string | null } | null;
  label?: { name?: string | null } | null;
  performed_via_github_app?: unknown;
}

export type OverrideDecision =
  | { applied: true; by: string; at: string }
  | { applied: false; reason: "absent" | "removed" | "untrusted" | "unreadable"; by?: string };

const sameLabel = (a: string | null | undefined) => (a ?? "").toLowerCase() === OVERRIDE_LABEL;

function isBot(e: LabelEvent): boolean {
  const login = e.actor?.login ?? "";
  return e.actor?.type === "Bot" || /\[bot\]$/i.test(login) || (e.performed_via_github_app ?? null) !== null;
}

/**
 * Whether the override applies. `events` in timeline order (oldest first), or null when they could
 * not be read (failed or timed-out fetch): with the label on the PR that is `unreadable`, never an
 * override, so the check blockers stay and the body can say why. `labels` are the PR's current
 * label names.
 */
export function overrideDecision(
  events: readonly LabelEvent[] | null,
  labels: readonly string[],
  trustedAuthors: readonly string[],
): OverrideDecision {
  if (!labels.some(sameLabel)) return { applied: false, reason: "absent" };
  if (events === null) return { applied: false, reason: "unreadable" };
  let last: LabelEvent | undefined;
  for (const e of events) {
    if ((e.event === "labeled" || e.event === "unlabeled") && sameLabel(e.label?.name)) last = e;
  }
  if (!last) return { applied: false, reason: "absent" };
  if (last.event === "unlabeled") return { applied: false, reason: "removed" };
  const login = last.actor?.login ?? "";
  const trusted = login !== "" && !isBot(last) && trustedAuthors.some((t) => t.toLowerCase() === login.toLowerCase());
  if (!trusted) return login === "" ? { applied: false, reason: "untrusted" } : { applied: false, reason: "untrusted", by: login };
  return { applied: true, by: login, at: last.created_at ?? "" };
}

/** The blockers left after the override: check blockers dropped, secrets and coverage kept. */
export function applyOverride(blockers: readonly SyntheticBlocker[], decision: OverrideDecision): SyntheticBlocker[] {
  return decision.applied ? blockers.filter((b) => b.kind !== "check") : [...blockers];
}

/** The PR's timeline label events, oldest first (paginated, 100 per page). */
export async function fetchLabelEvents(gh: GitHub, repo: RepoRef, pullNumber: number): Promise<LabelEvent[]> {
  const items = (await gh.paginate(gh.rest.issues.listEventsForTimeline, {
    ...repo,
    issue_number: pullNumber,
    per_page: 100,
  })) as unknown as LabelEvent[];
  return items.filter((e) => e.event === "labeled" || e.event === "unlabeled");
}

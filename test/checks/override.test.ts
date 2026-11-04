import { describe, expect, it, vi } from "vitest";

import { applyOverride, fetchLabelEvents, OVERRIDE_LABEL, overrideDecision, type LabelEvent } from "../../src/checks/override.js";
import type { GitHub } from "../../src/github/client.js";
import type { SyntheticBlocker } from "../../src/merge/verdict.js";

const TRUSTED = ["dlled", "Alice"];
const LABELS = [OVERRIDE_LABEL, "bug"];

function ev(event: string, login: string, at: string, extra: Partial<LabelEvent> = {}): LabelEvent {
  return { event, created_at: at, actor: { login, type: "User" }, label: { name: OVERRIDE_LABEL }, ...extra };
}

describe("overrideDecision", () => {
  it("applies when a trusted login added the label (case-insensitive)", () => {
    expect(overrideDecision([ev("labeled", "alice", "2026-11-04T10:00:00Z")], LABELS, TRUSTED)).toEqual({
      applied: true,
      by: "alice",
      at: "2026-11-04T10:00:00Z",
    });
  });

  it("does not apply when an untrusted login added it", () => {
    expect(overrideDecision([ev("labeled", "mallory", "t")], LABELS, TRUSTED)).toEqual({ applied: false, reason: "untrusted", by: "mallory" });
  });

  it("the last sender decides: untrusted re-add after a trusted add does not apply", () => {
    const events = [ev("labeled", "dlled", "t1"), ev("unlabeled", "mallory", "t2"), ev("labeled", "mallory", "t3")];
    expect(overrideDecision(events, LABELS, TRUSTED)).toMatchObject({ applied: false, reason: "untrusted" });
  });

  it("a trusted re-add after an untrusted one applies", () => {
    const events = [ev("labeled", "mallory", "t1"), ev("unlabeled", "dlled", "t2"), ev("labeled", "dlled", "t3")];
    expect(overrideDecision(events, LABELS, TRUSTED)).toEqual({ applied: true, by: "dlled", at: "t3" });
  });

  it("does not apply once removed, or when the PR no longer has the label", () => {
    expect(overrideDecision([ev("labeled", "dlled", "t1"), ev("unlabeled", "dlled", "t2")], LABELS, TRUSTED)).toEqual({ applied: false, reason: "removed" });
    expect(overrideDecision([ev("labeled", "dlled", "t1")], ["bug"], TRUSTED)).toEqual({ applied: false, reason: "absent" });
  });

  it("does not apply when the label is present but no event shows who added it", () => {
    expect(overrideDecision([], LABELS, TRUSTED)).toEqual({ applied: false, reason: "absent" });
  });

  it("events that could not be read (null) are 'unreadable', never an override", () => {
    expect(overrideDecision(null, LABELS, TRUSTED)).toEqual({ applied: false, reason: "unreadable" });
    // Without the label on the PR, unread events change nothing.
    expect(overrideDecision(null, ["bug"], TRUSTED)).toEqual({ applied: false, reason: "absent" });
    // The blockers stay.
    const blockers = [{ kind: "check" as const, title: "Pre-merge check failed: title", severity: "major" as const }];
    expect(applyOverride(blockers, overrideDecision(null, LABELS, TRUSTED))).toEqual(blockers);
    // An empty list (read, nothing found) keeps its old meaning.
    expect(overrideDecision([], LABELS, TRUSTED)).toEqual({ applied: false, reason: "absent" });
  });

  it("bots and Apps never count, even with a trusted-looking login", () => {
    expect(overrideDecision([ev("labeled", "dlled", "t", { actor: { login: "dlled", type: "Bot" } })], LABELS, TRUSTED).applied).toBe(false);
    expect(overrideDecision([ev("labeled", "dlled[bot]", "t")], LABELS, [...TRUSTED, "dlled[bot]"]).applied).toBe(false);
    expect(overrideDecision([ev("labeled", "dlled", "t", { performed_via_github_app: { id: 1 } })], LABELS, TRUSTED).applied).toBe(false);
  });

  it("ignores other labels and other event types", () => {
    const events = [
      ev("labeled", "dlled", "t1"),
      ev("labeled", "mallory", "t2", { label: { name: "bug" } }),
      ev("commented", "mallory", "t3"),
    ];
    expect(overrideDecision(events, LABELS, TRUSTED)).toMatchObject({ applied: true, by: "dlled" });
  });

  it("an event with no actor is untrusted", () => {
    expect(overrideDecision([ev("labeled", "", "t", { actor: null })], LABELS, TRUSTED)).toEqual({ applied: false, reason: "untrusted" });
  });
});

describe("applyOverride", () => {
  const blockers: SyntheticBlocker[] = [
    { kind: "check", title: "Pre-merge check failed: title — x", severity: "major" },
    { kind: "secret", title: "Possible secret committed", severity: "critical" },
    { kind: "coverage", title: "Secret scan did not run", severity: "critical" },
    { kind: "check", title: "Pre-merge check failed: docstrings — y", severity: "major" },
  ];

  it("drops only check blockers when applied", () => {
    expect(applyOverride(blockers, { applied: true, by: "dlled", at: "t" }).map((b) => b.kind)).toEqual(["secret", "coverage"]);
  });

  it("keeps everything when not applied", () => {
    expect(applyOverride(blockers, { applied: false, reason: "untrusted" })).toEqual(blockers);
  });
});

describe("fetchLabelEvents", () => {
  it("paginates the timeline and keeps only label events", async () => {
    const paginate = vi.fn(() =>
      Promise.resolve([ev("labeled", "dlled", "t1"), { event: "commented" }, ev("unlabeled", "dlled", "t2")]),
    );
    const listEventsForTimeline = vi.fn();
    const gh = { paginate, rest: { issues: { listEventsForTimeline } } } as unknown as GitHub;
    const r = await fetchLabelEvents(gh, { owner: "o", repo: "r" }, 7);
    expect(r.map((e) => e.event)).toEqual(["labeled", "unlabeled"]);
    expect(paginate).toHaveBeenCalledWith(listEventsForTimeline, { owner: "o", repo: "r", issue_number: 7, per_page: 100 });
  });
});

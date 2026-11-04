// design-v2 §5 wiring (PW-P5): check inputs under a budget, combination, override, body note.

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/index.js";
import type { GitHub, GitRunner } from "../../src/github/index.js";
import type { EngineSummary } from "../../src/merge/merge.js";
import {
  finishChecks,
  gatherCheckInputs,
  hasErrorCheck,
  overrideLabelAction,
  overrideNote,
  type CheckInputs,
} from "../../src/orchestrator/checks.js";
import type { PreMergeChecksConfig } from "../../src/types.js";

const LABEL = "myrabbit:ignore-checks";
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function checks(over: Partial<PreMergeChecksConfig> = {}): PreMergeChecksConfig {
  return { ...defaultConfig().pre_merge_checks, ...over };
}
const titleError = () => checks({ title: { mode: "error", requirements: "" } });

/** GitHub/git fakes that count calls; `hang` makes every call wait forever. */
function fakes(hang = false): { github: GitHub; git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const reply = <T>(v: T) => (hang ? never<T>() : Promise.resolve(v));
  const github = {
    paginate: (_fn: unknown, args: { issue_number: number }) => (calls.push(`timeline:${args.issue_number}`), reply([])),
    rest: {
      issues: {
        get: (a: { issue_number: number }) => (calls.push(`issue:${a.issue_number}`), reply({ data: { number: a.issue_number, title: "t", body: "b" } })),
        listEventsForTimeline: {},
      },
    },
  } as unknown as GitHub;
  const git: GitRunner = (args) => (calls.push(`git:${args[0] ?? ""}`), reply({ code: 1, stdout: "", stderr: "" }));
  return { github, git, calls };
}

const pr = (body = "", labels: string[] = []) => ({ number: 7, body, labels });
const base = { repo: { owner: "acme", repo: "widgets" }, headSha: "a".repeat(40), files: [] };

describe("overrideLabelAction", () => {
  it("is the action for the override label only", () => {
    expect(overrideLabelAction({ action: "labeled", label: { name: LABEL } })).toBe("labeled");
    expect(overrideLabelAction({ action: "unlabeled", label: { name: "MyRabbit:Ignore-Checks" } })).toBe("unlabeled");
    expect(overrideLabelAction({ action: "labeled", label: { name: "bug" } })).toBeNull();
    expect(overrideLabelAction({ action: "synchronize" })).toBeNull();
    expect(overrideLabelAction(null)).toBeNull();
    expect(overrideLabelAction({ action: "labeled", label: null })).toBeNull();
  });
});

describe("hasErrorCheck", () => {
  it("is true only with an error-mode check", () => {
    expect(hasErrorCheck(checks())).toBe(false);
    expect(hasErrorCheck(checks({ description: { mode: "warning", requirements: "" } }))).toBe(false);
    expect(hasErrorCheck(titleError())).toBe(true);
    expect(hasErrorCheck(checks({ custom: [{ name: "c", mode: "error", instructions: "i" }] }))).toBe(true);
  });
});

describe("gatherCheckInputs", () => {
  it("makes no call with every check off", async () => {
    const f = fakes();
    expect(await gatherCheckInputs({ ...base, config: checks(), github: f.github, git: f.git, pr: pr("Fixes #3", [LABEL]) })).toEqual({
      linkedIssues: [],
      labelEvents: [],
    });
    expect(f.calls).toEqual([]);
  });

  it("reads the timeline only when the label is on and a check can block", async () => {
    const f = fakes();
    await gatherCheckInputs({ ...base, config: titleError(), github: f.github, git: f.git, pr: pr("", []) });
    await gatherCheckInputs({ ...base, config: checks({ title: { mode: "warning", requirements: "" } }), github: f.github, git: f.git, pr: pr("", [LABEL]) });
    expect(f.calls).toEqual([]);
    await gatherCheckInputs({ ...base, config: titleError(), github: f.github, git: f.git, pr: pr("", [LABEL]) });
    expect(f.calls).toEqual(["timeline:7"]);
  });

  it("fetches linked issues when the check is on", async () => {
    const f = fakes();
    const r = await gatherCheckInputs({ ...base, config: checks({ linked_issues: { mode: "warning" } }), github: f.github, git: f.git, pr: pr("Fixes #3") });
    expect(r.linkedIssues).toEqual([{ number: 3, title: "t", body: "b" }]);
  });

  it("a failed label-event fetch is null, not 'no events'", async () => {
    const f = fakes();
    const github = { paginate: () => Promise.reject(new Error("HTTP 500")) } as unknown as GitHub;
    const r = await gatherCheckInputs({ ...base, config: titleError(), github, git: f.git, pr: pr("", [LABEL]) }, {});
    expect(r.labelEvents).toBeNull();
  });

  it("falls back after the budget: no issues, inconclusive docstrings, unreadable events", async () => {
    const f = fakes(true);
    const started = Date.now();
    const r = await gatherCheckInputs(
      {
        ...base,
        config: checks({ title: { mode: "error", requirements: "" }, linked_issues: { mode: "error" }, docstrings: { mode: "warning", threshold: 80 } }),
        github: f.github,
        git: f.git,
        pr: pr("Fixes #3", [LABEL]),
      },
      { budgetMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.linkedIssues).toEqual([]);
    expect(r.labelEvents).toBeNull();
    expect(r.docstrings).toMatchObject({ status: "inconclusive" });
  });

  it("stops on the run signal", async () => {
    const f = fakes(true);
    const r = await gatherCheckInputs(
      { ...base, config: checks({ linked_issues: { mode: "error" } }), github: f.github, git: f.git, pr: pr("Fixes #3") },
      { signal: AbortSignal.abort() },
    );
    expect(r.linkedIssues).toEqual([]);
  });
});

describe("finishChecks", () => {
  const summary = (explanation: string, status: "pass" | "fail" = "fail"): EngineSummary => ({
    engine: "claude",
    summary: "",
    changes: [],
    checks: [{ name: "title", status, explanation }],
  });
  const none: CheckInputs = { linkedIssues: [], labelEvents: [] };
  const token = `ghp_${"A".repeat(36)}`;

  it("redacts the model's explanation before the blocker title and the table", () => {
    const r = finishChecks(titleError(), [summary(`leaked ${token}`)], ["claude"], none, { labels: [] }, ["dlled"]);
    expect(r.checks[0]?.explanation).not.toContain(token);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]?.title).toBe("Pre-merge check failed: title");
    expect(r.blockers[0]?.body).toMatch(/^Pre-merge check failed: title — leaked /);
    expect(r.blockers[0]?.body).not.toContain(token);
    expect(r.override).toBeNull();
  });

  it("a trusted override drops the check blocker; an untrusted one keeps it", () => {
    const ev = (login: string) => ({ event: "labeled", created_at: "2026-11-03T10:00:00Z", actor: { login, type: "User" }, label: { name: LABEL } });
    const ok = finishChecks(titleError(), [summary("x")], ["claude"], { ...none, labelEvents: [ev("dlled")] }, { labels: [LABEL] }, ["dlled"]);
    expect(ok.blockers).toEqual([]);
    expect(ok.override).toEqual({ applied: true, by: "dlled", at: "2026-11-03T10:00:00Z" });
    const bad = finishChecks(titleError(), [summary("x")], ["claude"], { ...none, labelEvents: [ev("mallory")] }, { labels: [LABEL] }, ["dlled"]);
    expect(bad.blockers).toHaveLength(1);
    expect(bad.override).toMatchObject({ applied: false, reason: "untrusted", by: "mallory" });
  });

  it("with the label on but no events fetched, nothing is overridden (fail closed)", () => {
    const r = finishChecks(titleError(), [summary("x")], ["claude"], none, { labels: [LABEL] }, ["dlled"]);
    expect(r.blockers).toHaveLength(1);
    expect(r.override).toMatchObject({ applied: false });
  });

  it("with the label on but the events unreadable, the blocker stays and the decision says why", () => {
    const r = finishChecks(titleError(), [summary("x")], ["claude"], { ...none, labelEvents: null }, { labels: [LABEL] }, ["dlled"]);
    expect(r.blockers).toHaveLength(1);
    expect(r.override).toEqual({ applied: false, reason: "unreadable" });
    expect(overrideNote(r.override)).toBe(
      "The `myrabbit:ignore-checks` label is on the pull request, but its label events could not be read, so it is not applied and the pre-merge check blockers stay.",
    );
  });
});

describe("overrideNote", () => {
  it("records who applied the label and when, in code spans", () => {
    expect(overrideNote({ applied: true, by: "dlled", at: "2026-11-03T10:00:00Z" })).toBe(
      "Pre-merge check blockers are overridden by the `myrabbit:ignore-checks` label, applied by `dlled` at 2026-11-03T10:00:00Z.",
    );
    expect(overrideNote({ applied: true, by: "dl`led", at: "<b>" })).toBe(
      "Pre-merge check blockers are overridden by the `myrabbit:ignore-checks` label, applied by `dlled`.",
    );
    expect(overrideNote({ applied: false, reason: "untrusted", by: "mallory" })).toContain("last applied by `mallory`, who is not a trusted author");
    expect(overrideNote({ applied: false, reason: "removed" })).toBeNull();
    expect(overrideNote(null)).toBeNull();
  });
});

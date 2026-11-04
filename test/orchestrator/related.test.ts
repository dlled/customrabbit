// design-v2 §4.6–§4.7 wiring: the time budget around src/related, and the body's related union.

import { describe, expect, it, vi } from "vitest";

import type { GitHub, GitRunner } from "../../src/github/index.js";
import { relatedUnion, startRelated, withBudget } from "../../src/orchestrator/related.js";
import { SearchBudget } from "../../src/related/index.js";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const opts = (ms: number, signal?: AbortSignal) => ({ deadline: Date.now() + ms, now: Date.now, ...(signal ? { signal } : {}) });

describe("withBudget", () => {
  it("returns the work's value when it is in time", async () => {
    expect(await withBudget(Promise.resolve(1), 0, opts(1_000))).toBe(1);
  });

  it("returns the fallback once the deadline passes", async () => {
    const started = Date.now();
    expect(await withBudget(never<number>(), -1, opts(20))).toBe(-1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns the fallback on abort, and at once for an aborted signal", async () => {
    const c = new AbortController();
    const p = withBudget(never<number>(), -1, opts(60_000, c.signal));
    c.abort();
    expect(await p).toBe(-1);
    expect(await withBudget(Promise.resolve(1), -1, opts(60_000, AbortSignal.abort()))).toBe(-1);
  });

  it("never rejects", async () => {
    expect(await withBudget(Promise.reject(new Error("boom")), -1, opts(1_000))).toBe(-1);
  });
});

const SHA = "a".repeat(40);
const input = { repo: { owner: "acme", repo: "widgets" }, baseSha: SHA, prNumber: 7, prAuthor: "dlled", title: "Fix delivery timeout", paths: ["a.ts"] };

/** A GitHub and git that never answer, counting calls. */
function hanging(): { github: GitHub; git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const github = {
    rest: {
      search: { issuesAndPullRequests: () => (calls.push("search"), never()) },
      repos: {
        listPullRequestsAssociatedWithCommit: () => (calls.push("pulls"), never()),
        getCommit: () => (calls.push("commit"), never()),
      },
    },
  } as unknown as GitHub;
  const git: GitRunner = () => (calls.push("git"), never());
  return { github, git, calls };
}

describe("startRelated", () => {
  it("makes no call for a feature that is off", async () => {
    const d = hanging();
    const step = startRelated({ related: false, reviewers: false }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 10 });
    expect(await step.reviewers).toBeNull();
    expect(await step.candidates(["deliver"])).toBeNull();
    expect(d.calls).toEqual([]);
  });

  it("falls back after the budget: candidates unavailable, no reviewers", async () => {
    const d = hanging();
    const started = Date.now();
    const step = startRelated({ related: true, reviewers: true }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 50, graceMs: 20 });
    expect(await step.candidates(["deliverWebhook"])).toEqual({ candidates: [], unavailable: true });
    expect(await step.reviewers).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(d.calls).toContain("search");
  });

  it("settles through the deadline abort, not the backstop", async () => {
    const d = hanging();
    const started = Date.now();
    const step = startRelated({ related: true, reviewers: true }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 50, graceMs: 60_000 });
    expect(await step.candidates(["deliverWebhook"])).toEqual({ candidates: [], unavailable: true });
    expect(await step.reviewers).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives the candidate search its own budget from when it starts: a slow context pack cannot starve it", async () => {
    const d = hanging();
    const step = startRelated({ related: true, reviewers: false }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 150, graceMs: 10 });
    await new Promise((r) => setTimeout(r, 300)); // the context pack took longer than the whole budget
    const started = Date.now();
    expect(await step.candidates(["deliverWebhook"])).toEqual({ candidates: [], unavailable: true });
    // It ran for its own budget instead of starting already aborted.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(d.calls).toContain("search");
  });

  it("drops its run-signal listeners once the lookups settle", async () => {
    const d = hanging();
    const c = new AbortController();
    const added = vi.spyOn(c.signal, "addEventListener");
    const removed = vi.spyOn(c.signal, "removeEventListener");
    const step = startRelated({ related: true, reviewers: true }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 20, graceMs: 10, signal: c.signal });
    await step.reviewers;
    await step.candidates([]);
    expect(added).toHaveBeenCalledTimes(2);
    expect(removed.mock.calls.map((call) => call[1])).toEqual(added.mock.calls.map((call) => call[1]));
  });

  it("stops on the run signal", async () => {
    const d = hanging();
    const c = new AbortController();
    const step = startRelated({ related: true, reviewers: true }, input, { ...d, budget: new SearchBudget() }, { budgetMs: 60_000, signal: c.signal, graceMs: 20 });
    c.abort();
    expect(await step.reviewers).toEqual([]);
    expect(await step.candidates([])).toEqual({ candidates: [], unavailable: true });
  });
});

describe("relatedUnion", () => {
  const candidates = [
    { number: 3, kind: "issue" as const, title: "t", body: "" },
    { number: 9, kind: "pr" as const, title: "t", body: "" },
  ];

  it("keeps candidate numbers only, first pick wins, with the candidate's kind", () => {
    expect(
      relatedUnion(
        [
          [{ number: 9, reason: "same file" }, { number: 42, reason: "not a candidate" }],
          undefined,
          [{ number: 9, reason: "dup" }, { number: 3, reason: "same bug" }],
        ],
        candidates,
      ),
    ).toEqual([
      { number: 9, kind: "pr", reason: "same file" },
      { number: 3, kind: "issue", reason: "same bug" },
    ]);
  });

  it("is empty with no picks", () => {
    expect(relatedUnion([], candidates)).toEqual([]);
  });
});

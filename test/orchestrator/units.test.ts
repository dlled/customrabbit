import { describe, expect, it } from "vitest";

import { compilePathFilter, defaultConfig } from "../../src/config/index.js";
import { parseUnifiedDiff, type ReviewThread } from "../../src/github/index.js";
import type { PriorThread } from "../../src/merge/index.js";
import { autoReviewSkipReason } from "../../src/orchestrator/auto-review.js";
import { ContextError, normalizePrInput, readActionContext, resolvePrNumber } from "../../src/orchestrator/context.js";
import { errorText } from "../../src/orchestrator/log.js";
import { resolveCandidates, RESOLVE_BUDGET } from "../../src/orchestrator/resolve.js";
import { reviewScope } from "../../src/orchestrator/scope.js";
import { bundledTemplates } from "../../src/orchestrator/templates.js";
import { loadTemplates } from "../../src/prompts/builder.js";

const baseEnv = (): NodeJS.ProcessEnv => ({
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_WORKSPACE: "/home/runner/work/widgets/widgets",
  RUNNER_TEMP: "/home/runner/actions-runner/_work/_temp",
  GITHUB_STEP_SUMMARY: "/home/runner/actions-runner/_work/_temp/summary.md",
  GITHUB_ACTOR: "dlled",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2",
});

describe("readActionContext", () => {
  it("reads the runner variables", () => {
    expect(readActionContext(baseEnv())).toEqual({
      trigger: "pull_request",
      repo: { owner: "acme", repo: "widgets" },
      repoFullName: "acme/widgets",
      workspace: "/home/runner/work/widgets/widgets",
      runnerTemp: "/home/runner/actions-runner/_work/_temp",
      stepSummary: "/home/runner/actions-runner/_work/_temp/summary.md",
      actor: "dlled",
      runUrl: "https://github.com/acme/widgets/actions/runs/42/attempts/2",
    });
  });

  it("refuses other events and malformed values", () => {
    for (const [k, v] of [
      ["GITHUB_EVENT_NAME", "pull_request_target"],
      ["GITHUB_EVENT_NAME", "issue_comment"],
      ["GITHUB_REPOSITORY", "acme"],
      ["GITHUB_WORKSPACE", "relative/path"],
      ["GITHUB_WORKSPACE", ""],
    ] as const) {
      expect(() => readActionContext({ ...baseEnv(), [k]: v })).toThrow(ContextError);
    }
  });
});

describe("resolvePrNumber / normalizePrInput", () => {
  it("dispatch needs the pr input", () => {
    expect(resolvePrNumber("workflow_dispatch", 9, null)).toBe(9);
    expect(() => resolvePrNumber("workflow_dispatch", null, null)).toThrow(ContextError);
  });

  it("pull_request takes the event's PR; an explicit input must agree", () => {
    const ev = { pull_request: { number: 7 } };
    expect(resolvePrNumber("pull_request", null, ev)).toBe(7);
    expect(resolvePrNumber("pull_request", 7, ev)).toBe(7);
    expect(() => resolvePrNumber("pull_request", 8, ev)).toThrow(ContextError);
    expect(() => resolvePrNumber("pull_request", null, {})).toThrow(ContextError);
  });

  it("treats MYRABBIT_PR=0 (review.yml's pull_request default) as unset", () => {
    for (const v of ["0", " 0 ", "00", ""]) {
      const env: NodeJS.ProcessEnv = { MYRABBIT_PR: v };
      normalizePrInput(env);
      expect("MYRABBIT_PR" in env).toBe(false);
    }
    const env: NodeJS.ProcessEnv = { MYRABBIT_PR: "12" };
    normalizePrInput(env);
    expect(env.MYRABBIT_PR).toBe("12");
  });
});

describe("autoReviewSkipReason (§4 auto_review)", () => {
  const cfg = defaultConfig().auto_review;
  const pr = { draft: false, title: "Add widgets", labels: [] as string[] };

  it("reviews by default", () => {
    expect(autoReviewSkipReason(cfg, pr)).toBeNull();
  });

  it("skips disabled, drafts, title keywords (case-insensitive) and !labels", () => {
    expect(autoReviewSkipReason({ ...cfg, enabled: false }, pr)).toMatch(/enabled/);
    expect(autoReviewSkipReason(cfg, { ...pr, draft: true })).toMatch(/draft/);
    expect(autoReviewSkipReason({ ...cfg, drafts: true }, { ...pr, draft: true })).toBeNull();
    expect(autoReviewSkipReason(cfg, { ...pr, title: "wip: stuff" })).toMatch(/WIP/);
    expect(autoReviewSkipReason(cfg, { ...pr, labels: ["No-MyRabbit"] })).toMatch(/no-myrabbit/);
  });

  it("a positive label makes review opt-in", () => {
    const optIn = { ...cfg, labels: ["review-me"] };
    expect(autoReviewSkipReason(optIn, pr)).toMatch(/review-me/);
    expect(autoReviewSkipReason(optIn, { ...pr, labels: ["review-me"] })).toBeNull();
  });
});

const patch = (path: string, lines: number, opts: { binary?: boolean } = {}): string => {
  if (opts.binary) return `diff --git a/${path} b/${path}\nindex 1..2 100644\nBinary files a/${path} and b/${path} differ\n`;
  const body = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
};

describe("reviewScope (§7.5, D2)", () => {
  const files = parseUnifiedDiff(
    [patch("src/a.ts", 3), patch("package-lock.json", 2), patch("data/blob.xyzbin", 0, { binary: true }), patch("src/b.ts", 3), patch("src/c.ts", 1)].join(""),
  );
  const filter = compilePathFilter([]);

  it("puts every changed file in exactly one list", () => {
    const s = reviewScope(files, filter, { max_files: 150, max_diff_bytes: 400_000 });
    expect(s.files.reviewed).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(s.files.filtered.map((f) => f.path)).toEqual(["package-lock.json"]);
    expect(s.files.binary).toEqual(["data/blob.xyzbin"]);
    expect(s.files.notReviewed).toEqual([]);
    expect(s.coverage).toBeNull();
    expect(s.diffText).toContain("+++ b/src/b.ts");
    expect(s.diffText).not.toContain("package-lock.json");
  });

  it("over max_files: the rest are not reviewed and coverage is incomplete", () => {
    const s = reviewScope(files, filter, { max_files: 2, max_diff_bytes: 400_000 });
    expect(s.files.reviewed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(s.files.notReviewed).toEqual(["src/c.ts"]);
    expect(s.inScopeCount).toBe(3);
    expect(s.coverage).toEqual({ notReviewed: 1, limit: "max_files 2" });
  });

  it("over max_diff_bytes: files that do not fit are left out, smaller later ones still fit", () => {
    const a = files.find((f) => f.path === "src/a.ts")?.bytes ?? 0;
    const c = files.find((f) => f.path === "src/c.ts")?.bytes ?? 0;
    const s = reviewScope(files, filter, { max_files: 150, max_diff_bytes: a + c });
    expect(s.files.reviewed).toEqual(["src/a.ts", "src/c.ts"]);
    expect(s.coverage).toEqual({ notReviewed: 1, limit: `max_diff_bytes ${a + c}` });
  });
});

describe("resolveCandidates (§6.4)", () => {
  const diff = parseUnifiedDiff(
    "diff --git a/src/app.ts b/src/app.ts\nindex 1..2 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -4,3 +4,3 @@\n a\n-b\n+B\n c\n",
  );
  const prior = (o: Partial<PriorThread> & { blk?: boolean }): PriorThread => ({
    marker: { v: 1, fp: "abcdef012345", sev: "major", blk: o.blk ?? true },
    state: "open",
    path: "src/app.ts",
    line: 5,
    end_line: null,
    side: "RIGHT",
    category: "correctness",
    summary: "x",
    body: "y",
    sources: [],
    confidence: null,
    ...o,
  });
  const thread = (o: Partial<ReviewThread> = {}): ReviewThread => ({ isOutdated: false, ...o }) as ReviewThread;

  it("picks open threads whose lines changed, or that are outdated", () => {
    const priors = [
      prior({ line: 5 }),
      prior({ line: 20 }),
      prior({ line: 20 }),
      prior({ path: "other.ts" }),
      prior({ state: "dismissed" }),
      prior({ line: 4, end_line: 6, blk: false }),
    ];
    const threads = [thread(), thread(), thread({ isOutdated: true }), thread(), thread(), thread()];
    const got = resolveCandidates(threads, priors, diff);
    expect(got.map((c) => c.index)).toEqual([0, 2, 5]);
    expect(got[0]?.patch).toContain("+B");
  });

  it("caps at the budget, blocking threads first", () => {
    const priors = Array.from({ length: 12 }, (_, i) => prior({ blk: i >= 6 }));
    const threads = priors.map(() => thread());
    const got = resolveCandidates(threads, priors, diff);
    expect(got).toHaveLength(RESOLVE_BUDGET);
    expect(got.slice(0, 6).every((c) => c.prior.marker.blk)).toBe(true);
  });
});

describe("misc", () => {
  it("source runs read the templates from src/prompts", () => {
    expect(bundledTemplates()).toEqual(loadTemplates());
  });

  it("errorText is one redacted line", () => {
    expect(errorText(new TypeError("a\n b"))).toBe("TypeError: a b");
    expect(errorText(new Error("plain"))).toBe("plain");
    expect(errorText("x".repeat(600)).length).toBe(500);
    expect(errorText({})).toBe("unknown error");
  });
});

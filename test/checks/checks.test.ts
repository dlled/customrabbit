import { describe, expect, it } from "vitest";

import { BLOCKER_EXPLANATION_CHARS, combineChecks, DEFAULT_REQUIREMENTS, promptChecks } from "../../src/checks/index.js";
import type { EngineSummary } from "../../src/merge/merge.js";
import { syntheticFinding } from "../../src/merge/verdict.js";
import type { CheckStatus, EngineName, PreMergeChecksConfig } from "../../src/types.js";

const OFF: PreMergeChecksConfig = {
  title: { mode: "off", requirements: "" },
  description: { mode: "off", requirements: "" },
  docstrings: { mode: "off", threshold: 80 },
  linked_issues: { mode: "off" },
  custom: [],
};

function cfg(over: Partial<PreMergeChecksConfig>): PreMergeChecksConfig {
  return { ...OFF, ...over };
}

function summary(engine: EngineName, checks: Record<string, [CheckStatus, string]>): EngineSummary {
  return {
    engine,
    summary: "",
    changes: [],
    checks: Object.entries(checks).map(([name, [status, explanation]]) => ({ name, status, explanation })),
  };
}

const BOTH: EngineName[] = ["claude", "codex"];

describe("promptChecks", () => {
  it("is empty with the defaults (all off)", () => {
    expect(promptChecks(OFF, { linkedIssues: 3 })).toEqual([]);
  });

  it("lists active model checks in config order, with built-in or base-config wording", () => {
    const c = cfg({
      title: { mode: "warning", requirements: "" },
      description: { mode: "error", requirements: "  Must link the design doc.  " },
      docstrings: { mode: "error", threshold: 80 },
      linked_issues: { mode: "warning" },
      custom: [
        { name: "changelog", mode: "error", instructions: "CHANGELOG.md has an entry." },
        { name: "skipped", mode: "off", instructions: "x" },
      ],
    });
    expect(promptChecks(c, { linkedIssues: 1 })).toEqual([
      { name: "title", instructions: DEFAULT_REQUIREMENTS.title },
      { name: "description", instructions: "Must link the design doc." },
      { name: "linked_issues", instructions: DEFAULT_REQUIREMENTS.linked_issues },
      { name: "changelog", instructions: "CHANGELOG.md has an entry." },
    ]);
  });

  it("never asks docstrings (computed in code) nor linked_issues without a linked issue", () => {
    const c = cfg({ docstrings: { mode: "error", threshold: 80 }, linked_issues: { mode: "error" } });
    expect(promptChecks(c)).toEqual([]);
    expect(promptChecks(c, { linkedIssues: 0 })).toEqual([]);
  });
});

describe("combineChecks", () => {
  it("lists nothing and blocks nothing with the defaults", () => {
    const s = [summary("claude", { title: ["fail", "bad"] })];
    expect(combineChecks(OFF, s, ["claude"])).toEqual({ checks: [], blockers: [] });
  });

  it("a fail agreed by both engines in error mode blocks", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    const r = combineChecks(c, [summary("claude", { title: ["fail", "Generic\n title."] }), summary("codex", { title: ["fail", "Too vague."] })], BOTH);
    expect(r.checks).toEqual([{ name: "title", mode: "error", status: "fail", explanation: "Generic title." }]);
    expect(r.blockers).toEqual([
      { kind: "check", title: "Pre-merge check failed: title", severity: "major", body: "Pre-merge check failed: title — Generic title." },
    ]);
  });

  it("a fail in warning mode is listed but never blocks", () => {
    const c = cfg({ title: { mode: "warning", requirements: "" } });
    const r = combineChecks(c, [summary("claude", { title: ["fail", "x"] }), summary("codex", { title: ["fail", "y"] })], BOTH);
    expect(r.checks[0]?.status).toBe("fail");
    expect(r.blockers).toEqual([]);
  });

  it("a split is inconclusive and does not block", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    const r = combineChecks(c, [summary("claude", { title: ["fail", "x"] }), summary("codex", { title: ["pass", "y"] })], BOTH);
    expect(r.checks).toEqual([{ name: "title", mode: "error", status: "inconclusive", explanation: "Engines did not agree (claude: fail, codex: pass)." }]);
    expect(r.blockers).toEqual([]);
  });

  it("an engine that ran but gave no item for the check splits the vote", () => {
    const c = cfg({ description: { mode: "error", requirements: "" } });
    const r = combineChecks(c, [summary("claude", { description: ["fail", "x"] }), summary("codex", {})], BOTH);
    expect(r.checks[0]).toMatchObject({ status: "inconclusive", explanation: "Engines did not agree (claude: fail, codex: no result)." });
    expect(r.blockers).toEqual([]);
  });

  it("an engine that did not run casts no vote: one engine's fail blocks", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    // codex output is present but codex is not in `ran` (e.g. it failed validation): ignored.
    const r = combineChecks(c, [summary("claude", { title: ["fail", "x"] }), summary("codex", { title: ["pass", "y"] })], ["claude"]);
    expect(r.checks[0]?.status).toBe("fail");
    expect(r.blockers).toHaveLength(1);
  });

  it("no engine ran → inconclusive", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    expect(combineChecks(c, [], []).checks[0]).toEqual({ name: "title", mode: "error", status: "inconclusive", explanation: "No engine result." });
  });

  it("matches check names exactly", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    const r = combineChecks(c, [summary("claude", { Title: ["fail", "x"] })], ["claude"]);
    expect(r.checks[0]?.status).toBe("inconclusive");
  });

  it("docstrings comes from code and blocks only on fail in error mode", () => {
    const c = cfg({ docstrings: { mode: "error", threshold: 80 } });
    const fail = { status: "fail" as const, explanation: "Docstring coverage 50%.", total: 2, documented: 1 };
    expect(combineChecks(c, [], [], { docstrings: fail }).blockers).toEqual([
      { kind: "check", title: "Pre-merge check failed: docstrings", severity: "major", body: "Pre-merge check failed: docstrings — Docstring coverage 50%." },
    ]);
    expect(combineChecks(c, [], []).checks[0]).toMatchObject({ name: "docstrings", status: "inconclusive" });
  });

  it("linked_issues with no linked issue is inconclusive whatever the engines say", () => {
    const c = cfg({ linked_issues: { mode: "error" } });
    const s = [summary("claude", { linked_issues: ["fail", "x"] }), summary("codex", { linked_issues: ["fail", "y"] })];
    expect(combineChecks(c, s, BOTH).checks[0]).toMatchObject({ status: "inconclusive" });
    expect(combineChecks(c, s, BOTH, { linkedIssues: 2 }).checks[0]).toMatchObject({ status: "fail" });
  });

  it("custom checks follow config order after the built-ins", () => {
    const c = cfg({
      title: { mode: "warning", requirements: "" },
      custom: [
        { name: "b-check", mode: "error", instructions: "" },
        { name: "a-check", mode: "warning", instructions: "" },
      ],
    });
    const r = combineChecks(c, [summary("claude", { "a-check": ["pass", "ok"], "b-check": ["pass", "ok"], title: ["pass", "ok"] })], ["claude"]);
    expect(r.checks.map((x) => x.name)).toEqual(["title", "b-check", "a-check"]);
    expect(r.blockers).toEqual([]);
  });

  it("cuts a long explanation in the blocker body to one line", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    const long = `${"word ".repeat(100)}\nend`;
    const [b] = combineChecks(c, [summary("claude", { title: ["fail", long] })], ["claude"]).blockers;
    expect(b?.title).toBe("Pre-merge check failed: title");
    expect(b?.body).not.toContain("\n");
    expect(b?.body?.length).toBeLessThanOrEqual("Pre-merge check failed: title — ".length + BLOCKER_EXPLANATION_CHARS);
  });

  it("the blocker fingerprint depends on the check, not on the engines' wording", () => {
    const c = cfg({ title: { mode: "error", requirements: "" } });
    const run = (why: string) => {
      const [b] = combineChecks(c, [summary("claude", { title: ["fail", why] })], ["claude"]).blockers;
      if (b === undefined) throw new Error("no blocker");
      return syntheticFinding(b, ["claude"]);
    };
    const first = run("Generic title.");
    const second = run("The title is too vague to tell this change apart.");
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.body).toBe("Pre-merge check failed: title — The title is too vague to tell this change apart.");
    // An empty explanation keeps the same fingerprint and falls back to the title as the body.
    expect(run("").fingerprint).toBe(first.fingerprint);
    expect(run("").body).toBe("Pre-merge check failed: title");
    // Another check is another blocker.
    const d = cfg({ description: { mode: "error", requirements: "" } });
    const [other] = combineChecks(d, [summary("claude", { description: ["fail", "Generic title."] })], ["claude"]).blockers;
    expect(other && syntheticFinding(other, ["claude"]).fingerprint).not.toBe(first.fingerprint);
  });
});

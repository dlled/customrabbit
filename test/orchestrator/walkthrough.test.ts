// PW-P1: which design-v2 walkthrough items the pipeline passes, from the config flags.

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/index.js";
import { computeVerdict, type PriorThread } from "../../src/merge/index.js";
import { walkthroughItems } from "../../src/orchestrator/pipeline.js";
import type { Config, ProposedLearning, RunCheck } from "../../src/types.js";
import { prior } from "../merge/helpers.js";

function config(walkthrough: Partial<Config["walkthrough"]> = {}): Config {
  const c = defaultConfig();
  return { ...c, walkthrough: { ...c.walkthrough, ...walkthrough } };
}

function items(cfg: Config, priors: PriorThread[], proposals: ProposedLearning[] = []) {
  const verdict = computeVerdict({
    findings: [],
    priorThreads: priors,
    threshold: cfg.request_changes_threshold,
    coverage: null,
    sources: ["claude"],
  });
  return walkthroughItems(cfg, { findings: [], engineSummaries: [] }, priors, verdict, proposals);
}

describe("walkthroughItems", () => {
  it("is empty with every feature off, so the v1 body is unchanged", () => {
    expect(items(config(), [prior()])).toEqual({});
  });

  it("counts open non-blocking prior threads (low), not dismissed or blocking ones", () => {
    const on = config({ merge_risk: true });
    const nonBlocking = prior({ marker: { v: 1, fp: "bbbbbbbbbbbb", sev: "minor", blk: false } });
    expect(items(on, [nonBlocking]).risk).toBe("low");
    expect(items(on, [{ ...nonBlocking, state: "dismissed" }]).risk).toBe("minimal");
    expect(items(on, [prior()]).risk).toBe("high");
    expect(items(on, [prior({ marker: { v: 1, fp: "cccccccccccc", sev: "critical", blk: true } })]).risk).toBe("critical");
  });

  it("passes the AI-agent flag and the proposals as given", () => {
    const p: ProposedLearning = { title: "T", rule: "R.", paths: ["src/**"], fingerprint: "aaaaaaaaaaaa", source: "codex" };
    expect(items(config({ ai_agent_prompts: true }), [], [p])).toEqual({ aiAgentPrompts: true, proposedLearnings: [p] });
  });

  it("passes the combined checks to merge risk and to the table (PW-P5)", () => {
    const cfg = config({ merge_risk: true });
    const verdict = computeVerdict({ findings: [], priorThreads: [], threshold: cfg.request_changes_threshold, coverage: null, sources: ["claude"] });
    const warn: RunCheck = { name: "description", mode: "warning", status: "fail", explanation: "Empty." };
    const out = walkthroughItems(cfg, { findings: [], engineSummaries: [] }, [], verdict, [], [warn]);
    expect(out.risk).toBe("low");
    expect(out.checks).toEqual([warn]);
    // Without checks: minimal, and no table.
    expect(walkthroughItems(cfg, { findings: [], engineSummaries: [] }, [], verdict, [])).toEqual({ risk: "minimal" });
  });
});

import { readFileSync } from "node:fs";
import { TupleAnchorMap } from "../../src/merge/anchor.js";
import type { AnchorTuple, MergeOptions, PriorThread, VerifyFn } from "../../src/merge/types.js";
import type { EngineFinding, MergedFinding, Side } from "../../src/types.js";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
}

function range(path: string, side: Side, from: number, to: number, hunk: number): AnchorTuple[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({ path, side, line: from + i, hunk }));
}

/** Anchor map of the fixture PR: two hunks in src/auth.ts (one with deleted lines), one in src/util.ts. */
export const fixtureAnchors = new TupleAnchorMap([
  ...range("src/auth.ts", "RIGHT", 10, 30, 0),
  ...range("src/auth.ts", "RIGHT", 50, 60, 1),
  ...range("src/auth.ts", "LEFT", 40, 42, 1),
  ...range("src/util.ts", "RIGHT", 1, 20, 0),
]);

export const fixtureDiffPaths = new Set(["src/auth.ts", "src/util.ts"]);

export const confirmAll: VerifyFn = () =>
  Promise.resolve({ confirmed: true, reason: "reproduced", evidence: ["src/x.ts:1"] });

export function options(overrides: Partial<MergeOptions> = {}): MergeOptions {
  return {
    threshold: "major",
    profile: "chill",
    maxInlineComments: 15,
    diffPaths: fixtureDiffPaths,
    anchors: fixtureAnchors,
    priorThreads: [],
    verify: confirmAll,
    ...overrides,
  };
}

export function engineFinding(overrides: Partial<EngineFinding> = {}): EngineFinding {
  return {
    path: "src/util.ts",
    line: 5,
    end_line: null,
    side: "RIGHT",
    severity: "major",
    category: "correctness",
    title: "Off-by-one in page end index",
    body: "The end index excludes the last item.",
    failure_scenario: "page(items, 0, 10) returns 9 items.",
    evidence: ["src/util.ts:5"],
    rule: null,
    suggestion: null,
    confidence: 0.8,
    ...overrides,
  };
}

export function output(findings: unknown[]): unknown {
  return { summary: "A change.", changes: [], findings };
}

export function merged(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    path: "src/util.ts",
    line: 5,
    end_line: null,
    side: "RIGHT",
    severity: "major",
    category: "correctness",
    summary: "Off-by-one in page end index",
    body: "The end index excludes the last item.",
    failure_scenario: "page(items, 0, 10) returns 9 items.",
    rule: null,
    suggestion: null,
    blocking: false,
    sources: ["claude"],
    confidence: 0.8,
    fingerprint: "0123456789ab",
    status: "new",
    outside_diff: false,
    verification: "not_needed",
    synthetic: false,
    ...overrides,
  };
}

export function prior(overrides: Partial<PriorThread> = {}): PriorThread {
  return {
    marker: { v: 1, fp: "aaaaaaaaaaaa", sev: "major", blk: true },
    state: "open",
    path: "src/auth.ts",
    line: 20,
    end_line: null,
    side: "RIGHT",
    category: "correctness",
    summary: "Null session crashes the handler",
    body: "session may be undefined here.",
    sources: ["claude", "codex"],
    confidence: 0.9,
    ...overrides,
  };
}

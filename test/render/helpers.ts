// Builders for render tests. All values are obviously fake; no real tokens anywhere.

import type { ReviewRenderInput, RenderFinding } from "../../src/render/index.js";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const CONFIG_HASH = "c0ffee000001";

let seq = 0;

/** A distinct 12-hex fingerprint per call (deterministic within a test file). */
export function fp(n?: number): string {
  return (n ?? ++seq).toString(16).padStart(12, "0");
}

export function resetFp(): void {
  seq = 0;
}

export function finding(overrides: Partial<RenderFinding> = {}): RenderFinding {
  return {
    path: "src/app.ts",
    line: 10,
    end_line: null,
    side: "RIGHT",
    severity: "major",
    category: "correctness",
    summary: "Return value of parse() is ignored",
    body: "`parse()` returns a new object; the caller keeps using the old one, so config edits are lost.",
    suggestion: null,
    blocking: true,
    sources: ["claude", "codex"],
    confidence: 0.82,
    fingerprint: fp(),
    status: "new",
    outside_diff: false,
    verification: "agreed",
    synthetic: false,
    failure_scenario: "calling load() twice → the second call sees stale defaults",
    rule: null,
    ...overrides,
  };
}

export function input(overrides: Partial<ReviewRenderInput> = {}): ReviewRenderInput {
  return {
    verdict: "APPROVE",
    repo: "dlled/example",
    state: { v: 1, head: HEAD, base: BASE, mode: "full", config: CONFIG_HASH, prompt: "p1a2b3c" },
    rangeFrom: BASE,
    config: {
      profile: "chill",
      request_changes_threshold: "major",
      limits: { max_files: 150, max_diff_bytes: 400000, max_inline_comments: 15 },
    },
    summary: "Adds a config loader and wires it into the CLI. Defaults are applied when the file is missing.",
    changes: [
      { area: "Config", files: ["src/config.ts", "src/defaults.ts"], summary: "New loader with zod validation" },
      { area: "CLI", files: ["src/app.ts"], summary: "Calls the loader at startup" },
    ],
    findings: [],
    priorBlocking: [],
    dismissed: [],
    superseded: [],
    addressed: 0,
    engines: [
      { engine: "claude", status: "ok", model: "claude-opus-5-5", durationMs: 192_000, costUsd: 1.234 },
      { engine: "codex", status: "ok", model: null, durationMs: 241_500, costUsd: null },
    ],
    files: {
      reviewed: ["src/app.ts", "src/config.ts", "src/defaults.ts"],
      filtered: [{ path: "package-lock.json", reason: "excluded", pattern: "!**/package-lock.json" }],
      notReviewed: [],
      binary: [],
    },
    droppedByValidation: 0,
    runUrl: "https://github.com/dlled/example/actions/runs/123456789",
    mergeVersion: "m1",
    configWarnings: [],
    notes: [],
    ...overrides,
  };
}

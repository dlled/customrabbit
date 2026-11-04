// Inputs whose v1 renderings are frozen in fixtures/v1-prompts.json (captured from main before
// design-v2 P0). With no v2 slot set, the builder must reproduce them byte for byte.

import type { PromptContext, ReviewPromptInput } from "../../src/prompts/builder.js";

const NONCE = "0123456789abcdef";
const ctx: PromptContext = { repo: "dlled/example", language: "en-US", toneInstructions: "Be brief.", nonce: NONCE };

const review: ReviewPromptInput = {
  context: ctx,
  mode: "full",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  lastSha: null,
  styleGuides: [{ id: "G1", source: "AGENTS.md", scope: "**", text: "Use early returns." }],
  pathInstructions: [{ id: "P1", path: "src/**/*.ts", instructions: "No default exports." }],
  files: [
    { path: "src/a.ts", ruleIds: ["G1", "P1"] },
    { path: "docs/readme.md", ruleIds: [] },
  ],
  alreadyReported: [{ fingerprint: "abcdef012345", path: "src/old.ts", line: 7, severity: "major", title: "Old title" }],
  pr: { title: "Add retry", description: "Adds a retry helper.", commitSubjects: ["feat: retry"] },
  diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n+x\n",
};

export interface V1Case {
  name: string;
  kind: "review" | "verify" | "resolve";
  input: unknown;
}

export const V1_CASES: V1Case[] = [
  { name: "review-full", kind: "review", input: review },
  {
    name: "review-incremental-empty",
    kind: "review",
    input: {
      ...review,
      mode: "incremental",
      lastSha: "c".repeat(40),
      styleGuides: [],
      pathInstructions: [],
      alreadyReported: [],
      context: { ...ctx, toneInstructions: "" },
      pr: { title: "T", description: "", commitSubjects: [] },
    },
  },
  {
    name: "verify",
    kind: "verify",
    input: {
      context: ctx,
      headSha: "b".repeat(40),
      finding: {
        path: "src/a.ts", line: 3, end_line: 5, side: "RIGHT", severity: "critical", category: "security",
        title: "T", body: "B", failure_scenario: "F", evidence: ["src/a.ts:3"],
      },
    },
  },
  {
    name: "resolve",
    kind: "resolve",
    input: {
      context: ctx,
      lastSha: "c".repeat(40),
      headSha: "b".repeat(40),
      finding: { path: "src/a.ts", line: 3, end_line: null, side: "RIGHT", severity: "major", title: "T", body: "B" },
      diff: "@@ -3 +3 @@\n-old\n+new",
    },
  },
];

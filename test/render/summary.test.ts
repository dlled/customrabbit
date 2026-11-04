import { afterEach, describe, expect, it } from "vitest";
import { registerSecret, resetSecretsForTests } from "../../src/env.js";
import { MAX_JOB_SUMMARY_CHARS, renderJobSummary } from "../../src/render/index.js";
import type { RunDocument } from "../../src/types.js";
import { finding } from "./helpers.js";

afterEach(() => {
  resetSecretsForTests();
});

const engines = [
  { engine: "claude", status: "ok", model: "claude-opus-5-5", durationMs: 192_000, costUsd: 1.234 },
  { engine: "codex", status: "ok", model: null, durationMs: 241_500, costUsd: 0.5 },
] as const;

function runDoc(): RunDocument {
  return {
    schema_version: "1",
    run: { prompt_version: "p1a2b3c", merge_version: "m1", sources: ["claude", "codex"] },
    verdict: "REQUEST_CHANGES",
    findings: [finding({ fingerprint: "000000000001", body: "uses `x` in ```code```" })],
  };
}

describe("job summary", () => {
  it("posted review (snapshot)", async () => {
    const md = renderJobSummary({
      repo: "dlled/example",
      pr: 42,
      outcome: { kind: "posted", verdict: "REQUEST_CHANGES" },
      mode: "full",
      engines: [...engines],
      counts: { blocking: 1, nonBlocking: 2, inline: 2, bodyOnly: 1, dismissed: 0, addressed: 1 },
      redactions: 0,
      totalDurationMs: 300_000,
      runDocument: runDoc(),
    });
    await expect(md).toMatchFileSnapshot("./fixtures/summary-posted.md");
  });

  it("both engines failed (snapshot)", async () => {
    const md = renderJobSummary({
      repo: "dlled/example",
      pr: 42,
      outcome: { kind: "failed", reason: "both engines failed" },
      mode: "full",
      engines: [
        { engine: "claude", status: "failed", error: "timeout", durationMs: 720_000 },
        { engine: "codex", status: "failed", error: "credential expired", durationMs: 0 },
      ],
      redactions: 0,
    });
    await expect(md).toMatchFileSnapshot("./fixtures/summary-failed.md");
  });

  it("skipped and head-moved outcomes", () => {
    const skipped = renderJobSummary({
      repo: "dlled/example",
      pr: 1,
      outcome: { kind: "skipped", reason: "draft PR (auto_review.drafts: false)" },
      mode: "skip",
      engines: [],
      redactions: 0,
    });
    expect(skipped).toContain("**Skipped:** draft PR (auto_review.drafts: false) (no review posted)");
    const moved = renderJobSummary({
      repo: "dlled/example",
      pr: 1,
      outcome: { kind: "head_moved", reviewed: "a".repeat(40), current: "b".repeat(40) },
      mode: "full",
      engines: [],
      redactions: 0,
    });
    expect(moved).toContain("**Head moved** from `aaaaaaa` to `bbbbbbb`");
  });

  it("redacts the run document and warns with the total count", () => {
    const secret = "fake-secret-value-for-tests-0004";
    registerSecret(secret);
    const doc = runDoc();
    const first = doc.findings[0];
    if (first) first.body = `leaked ${secret}`;
    const md = renderJobSummary({
      repo: "dlled/example",
      pr: 2,
      outcome: { kind: "posted", verdict: "REQUEST_CHANGES" },
      mode: "full",
      engines: [...engines],
      redactions: 2,
      runDocument: doc,
    });
    expect(md).not.toContain(secret);
    expect(md).toContain("> [!WARNING]\n> 3 string(s) contained credential-shaped text");
  });

  it("omits an oversized run document", () => {
    const doc = runDoc();
    doc.findings = Array.from({ length: 700 }, () => finding({ body: "x".repeat(1500) }));
    const md = renderJobSummary({
      repo: "dlled/example",
      pr: 3,
      outcome: { kind: "posted", verdict: "REQUEST_CHANGES" },
      mode: "full",
      engines: [...engines],
      redactions: 0,
      runDocument: doc,
    });
    expect(md.length).toBeLessThan(MAX_JOB_SUMMARY_CHARS);
    expect(md).toContain("Run document omitted");
  });
});

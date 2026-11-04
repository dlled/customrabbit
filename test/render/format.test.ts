import { describe, expect, it } from "vitest";

import { reviewedBy, unavailableBanner } from "../../src/render/format.js";
import { renderJobSummary } from "../../src/render/summary.js";
import type { EngineRunSummary } from "../../src/render/types.js";

describe("unavailableBanner (CX1)", () => {
  const codex = (errorKind: NonNullable<EngineRunSummary["errorKind"]> | null): EngineRunSummary => ({
    engine: "codex",
    status: "failed",
    error: errorKind,
    errorKind,
  });
  const claudeOk: EngineRunSummary = { engine: "claude", status: "ok" };

  it.each([
    ["quota", "subscription quota reached"],
    ["rate_limit", "rate limited"],
    ["auth", "subscription/auth expired"],
    ["credential", "subscription/auth expired"],
  ] as const)("names the reason for %s", (kind, reason) => {
    expect(unavailableBanner([claudeOk, codex(kind)])).toBe(`⚠️ Codex unavailable (${reason}): this review was done by Claude only.`);
  });

  it("is null for a plain failure, when both ran, or when nobody reviewed", () => {
    for (const kind of ["timeout", "invalid_output", "sdk_error", "budget", "aborted", null] as const) {
      expect(unavailableBanner([claudeOk, codex(kind)])).toBeNull();
    }
    expect(unavailableBanner([claudeOk, { engine: "codex", status: "ok" }])).toBeNull();
    expect(unavailableBanner([{ engine: "claude", status: "failed", errorKind: "timeout" }, codex("quota")])).toBeNull();
    expect(unavailableBanner([claudeOk, { engine: "codex", status: "disabled" }])).toBeNull();
  });

  it("reads the same for a Claude account that is unavailable", () => {
    expect(unavailableBanner([{ engine: "claude", status: "failed", errorKind: "quota" }, { engine: "codex", status: "ok" }])).toBe(
      "⚠️ Claude unavailable (subscription quota reached): this review was done by Codex only.",
    );
  });
});

describe("reviewedBy", () => {
  it("names the engines that ran and why the others did not", () => {
    expect(reviewedBy([{ engine: "claude", status: "ok" }, { engine: "codex", status: "ok" }])).toBe("claude+codex");
    expect(
      reviewedBy([
        { engine: "claude", status: "ok" },
        { engine: "codex", status: "failed", error: "timeout" },
      ]),
    ).toBe("claude only (codex failed: timeout)");
    expect(reviewedBy([{ engine: "claude", status: "ok" }, { engine: "codex", status: "disabled" }])).toBe("claude only (codex disabled)");
  });

  it("says nothing was reviewed when the enabled engines were not run", () => {
    expect(reviewedBy([{ engine: "claude", status: "not_run" }, { engine: "codex", status: "not_run" }])).toBe("no engine (nothing to review)");
    expect(reviewedBy([{ engine: "claude", status: "not_run" }, { engine: "codex", status: "disabled" }])).toBe("no engine (nothing to review)");
    expect(reviewedBy([{ engine: "claude", status: "failed", error: "timeout" }, { engine: "codex", status: "not_run" }])).toBe("no engine");
  });
});

describe("job summary", () => {
  it("shows not_run engines as 'not run'", () => {
    const md = renderJobSummary({
      repo: "acme/widgets",
      pr: 7,
      outcome: { kind: "posted", verdict: "APPROVE" },
      mode: "full",
      engines: [{ engine: "claude", status: "not_run" }],
      redactions: 0,
    });
    expect(md).toContain("| claude | default | not run |");
  });
});

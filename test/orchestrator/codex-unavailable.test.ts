// CX1: Codex unavailable because of its subscription (quota, rate limit, expired plan or auth).
// The job stays green with a Claude-only review that says so loudly: a banner at the top of the
// review body, a ::warning:: in the job log and a warning in the step summary. Codex is not called
// again in the run. A plain failure (timeout) keeps the old wording; both engines failing still
// exits 1.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetSecretsForTests } from "../../src/env.js";
import { runPipeline } from "../../src/orchestrator/pipeline.js";
import type { EngineSetup } from "../../src/orchestrator/engines.js";
import type { EngineError } from "../../src/types.js";
import { appSource, fakeEngine, finding, harness, output, type Harness } from "./harness.js";

let h: Harness;
let base: string;
let head: string;

beforeEach(() => {
  resetSecretsForTests();
  h = harness();
  base = h.repo.commit("base", { "src/app.ts": appSource(), "README.md": "# widgets\n" });
  h.repo.git("checkout", "-q", "-b", "feature");
  head = h.repo.commit("change a5", { "src/app.ts": appSource({ 5: "export const a5 = 50;" }, ["export const a11 = 11;"]) });
});

afterEach(() => {
  h.cleanup();
  resetSecretsForTests();
});

interface PostedReview {
  event: string;
  body: string;
}

const postedReview = (): PostedReview => {
  const call = h.posts()[0];
  if (!call) throw new Error("no review POST");
  return call.body as PostedReview;
};

const BANNERS = {
  quota: "⚠️ Codex unavailable (subscription quota reached): this review was done by Claude only.",
  rate_limit: "⚠️ Codex unavailable (rate limited): this review was done by Claude only.",
  auth: "⚠️ Codex unavailable (subscription/auth expired): this review was done by Claude only.",
} as const;

const MESSAGES = {
  quota: "codex: You've hit your usage limit. Try again later.",
  rate_limit: "codex: exceeded retry limit, last status: 429 Too Many Requests",
  auth: "codex: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
} as const;

describe("Codex unavailable (CX1)", () => {
  it.each(["quota", "rate_limit", "auth"] as const)(
    "%s: exits 0 with a Claude-only REQUEST_CHANGES, the banner first, a log warning and a summary warning",
    async (kind) => {
      h.routes({ head, base });
      const code = await runPipeline(
        h.deps({ claude: { review: output([finding()]) }, codex: { review: { fail: kind, message: MESSAGES[kind] } } }),
      );
      expect(code).toBe(0);
      const r = postedReview();
      expect(r.event).toBe("REQUEST_CHANGES");
      // Prominent, and above the verdict line.
      expect(r.body.split("\n")[0]).toBe(`**${BANNERS[kind]}**`);
      expect(r.body).toContain(`reviewed by claude only (codex failed: ${kind})`);
      // The single-model blocker is still verified, by a fresh Claude call.
      expect(h.calls.filter((c) => c.task === "verify").map((c) => c.engine)).toEqual(["claude"]);
      // Codex was asked once (the review) and never again in the run.
      expect(h.calls.filter((c) => c.engine === "codex").map((c) => c.task)).toEqual(["review"]);
      expect(h.logs).toContain(`::warning::myrabbit: ${BANNERS[kind]}`);
      expect(h.summary()).toContain(`> [!WARNING]\n> ${BANNERS[kind]}`);
    },
  );

  it.each([
    ["quota", "subscription quota reached", "claude: Claude AI usage limit reached|1767225600"],
    ["auth", "subscription/auth expired", "claude: Invalid API key · Please run /login"],
  ] as const)("Claude %s with Codex ok: exits 0 with a Codex-only review and the Claude banner", async (kind, reason, message) => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: { review: { fail: kind, message } }, codex: { review: output([finding()]) } }));
    expect(code).toBe(0);
    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    const banner = `⚠️ Claude unavailable (${reason}): this review was done by Codex only.`;
    expect(r.body.split("\n")[0]).toBe(`**${banner}**`);
    expect(r.body).toContain(`reviewed by codex only (claude failed: ${kind})`);
    expect(h.calls.filter((c) => c.task === "verify").map((c) => c.engine)).toEqual(["codex"]);
    expect(h.calls.filter((c) => c.engine === "claude").map((c) => c.task)).toEqual(["review"]);
    expect(h.logs).toContain(`::warning::myrabbit: ${banner}`);
  });

  it("quota with no findings: Claude-only APPROVE, still with the banner", async () => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: {}, codex: { review: { fail: "quota", message: MESSAGES.quota } } }));
    expect(code).toBe(0);
    const r = postedReview();
    expect(r.event).toBe("APPROVE");
    expect(r.body.split("\n")[0]).toBe(`**${BANNERS.quota}**`);
  });

  it("an expired credential skipped before starting gets the banner too", async () => {
    h.routes({ head, base });
    const deps = h.deps({ claude: {} });
    const setup = (): Promise<EngineSetup> =>
      Promise.resolve({
        engines: [fakeEngine("claude", {}, h.calls)],
        notRunning: [{ engine: "codex", status: "failed", error: "skipped: credential expired", errorKind: "credential", durationMs: 0 }],
        denyNotes: [],
        cleanup: () => Promise.resolve(),
      });
    expect(await runPipeline({ ...deps, setupEngines: setup })).toBe(0);
    expect(postedReview().body.split("\n")[0]).toBe(`**${BANNERS.auth}**`);
    expect(h.calls.some((c) => c.engine === "codex")).toBe(false);
  });

  it.each(["timeout", "invalid_output", "sdk_error"] satisfies EngineError["kind"][])(
    "a plain %s keeps today's wording and adds no banner",
    async (kind) => {
      h.routes({ head, base });
      const code = await runPipeline(h.deps({ claude: { review: output([finding()]) }, codex: { review: { fail: kind } } }));
      expect(code).toBe(0);
      const r = postedReview();
      expect(r.body).toContain(`reviewed by claude only (codex failed: ${kind})`);
      expect(r.body).not.toContain("unavailable");
      expect(r.body.startsWith("**myrabbit: REQUEST_CHANGES**")).toBe(true);
      expect(h.logs.some((l) => l.startsWith("::warning::myrabbit: ⚠️"))).toBe(false);
      expect(h.summary()).not.toContain("unavailable");
    },
  );

  it("both engines failing still exits 1 and posts nothing, quota included", async () => {
    h.routes({ head, base });
    const code = await runPipeline(
      h.deps({ claude: { review: { fail: "timeout" } }, codex: { review: { fail: "quota", message: MESSAGES.quota } } }),
    );
    expect(code).toBe(1);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("both engines failed");
    // No Claude-only claim when Claude did not review either.
    expect(h.summary()).not.toContain("done by Claude only");
  });
});

import { describe, expect, it } from "vitest";
import {
  engineTimeoutMs,
  resolveFinding,
  reviewInput,
  runBoth,
  runEngine,
  verifierFor,
  verifyFinding,
} from "../../src/engines/run.js";
import { REVIEW_OUTPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA, RESOLVE_OUTPUT_SCHEMA } from "../../src/engines/schema.js";
import type { Engine, EngineInput, EngineName, EngineResult } from "../../src/types.js";
import { reviewEngineInput, reviewOutputFixture } from "./helpers.js";

type Behaviour = (input: EngineInput<unknown>, signal: AbortSignal) => Promise<unknown>;

/** A fake engine: returns `behaviour`'s value as a success, or what the behaviour throws. */
function fakeEngine(name: EngineName, behaviour: Behaviour) {
  const seen: { input: EngineInput<unknown>; signal: AbortSignal }[] = [];
  const engine: Engine = {
    name,
    async review<T>(input: EngineInput<T>, signal: AbortSignal): Promise<EngineResult<T>> {
      seen.push({ input, signal });
      const raw = await behaviour(input, signal);
      if (signal.aborted) {
        return { ok: false, engine: name, error: { kind: "timeout", message: "t" }, model: null, usage: null, costUsd: null, durationMs: 0, toolCalls: 0, denials: 0 };
      }
      return { ok: true, engine: name, output: input.parse(raw), model: null, usage: null, costUsd: null, durationMs: 1, toolCalls: 0, denials: 0 };
    },
  };
  return { engine, seen };
}

const untilAborted: Behaviour = (_i, signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => { resolve(null); });
  });

const PROMPT_CONTEXT = { repo: "dlled/x", language: "en-US", toneInstructions: "", nonce: "0123456789abcdef" };

describe("runEngine", () => {
  it("turns a throwing adapter into an sdk_error failure", async () => {
    const { engine } = fakeEngine("claude", () => Promise.reject(new Error("kaput")));
    const r = await runEngine(engine, reviewEngineInput(), { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, engine: "claude", error: { kind: "sdk_error", message: "claude: kaput" } });
  });

  it("gives each call its own timeout signal", async () => {
    const { engine, seen } = fakeEngine("codex", untilAborted);
    const r = await runEngine(engine, reviewEngineInput(), { timeoutMs: 10 });
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(!r.ok && r.error.kind).toBe("timeout");
  });

  it("gives up on an adapter that ignores the abort, after the grace period", async () => {
    const { engine } = fakeEngine("codex", () => new Promise(() => undefined));
    const r = await runEngine(engine, reviewEngineInput(), { timeoutMs: 10, graceMs: 10 });
    expect(r).toMatchObject({ ok: false, engine: "codex", error: { kind: "timeout" } });
    if (!r.ok) expect(r.error.message).toContain("did not stop");
  });

  it("propagates an outer abort as aborted", async () => {
    const outer = new AbortController();
    const { engine } = fakeEngine("codex", () => new Promise(() => undefined));
    const p = runEngine(engine, reviewEngineInput(), { timeoutMs: 60_000, graceMs: 5, signal: outer.signal });
    outer.abort();
    const r = await p;
    expect(!r.ok && r.error.kind).toBe("aborted");
  });

  it("converts timeout_minutes to ms", () => {
    expect(engineTimeoutMs({ timeout_minutes: 12 })).toBe(720_000);
  });
});

describe("runBoth", () => {
  it("runs both in parallel and keeps one engine's success when the other fails", async () => {
    let concurrent = 0;
    let peak = 0;
    const slow = (fn: () => unknown): Behaviour => async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return fn();
    };
    const claude = fakeEngine("claude", slow(() => reviewOutputFixture()));
    const codex = fakeEngine("codex", slow(() => {
      throw new Error("codex down");
    }));
    const results = await runBoth([claude.engine, codex.engine], reviewEngineInput(), { timeoutMs: 1000 });
    expect(peak).toBe(2);
    expect(results.map((r) => [r.engine, r.ok])).toEqual([["claude", true], ["codex", false]]);
    expect(claude.seen[0]?.signal).not.toBe(codex.seen[0]?.signal);
  });

  it("returns failures for both when both fail", async () => {
    const a = fakeEngine("claude", untilAborted);
    const b = fakeEngine("codex", () => Promise.reject(new Error("x")));
    const results = await runBoth([a.engine, b.engine], reviewEngineInput(), { timeoutMs: 10 });
    expect(results.every((r) => !r.ok)).toBe(true);
  });

  it("builds the review input from a built prompt", () => {
    const input = reviewInput({ systemPrompt: "S", prompt: "P", nonce: "n", promptVersion: "v" }, "/w");
    expect(input).toMatchObject({ task: "review", systemPrompt: "S", prompt: "P", cwd: "/w" });
    expect(input.outputSchema).toBe(REVIEW_OUTPUT_SCHEMA);
  });
});

describe("verify and resolve calls", () => {
  const finding = {
    path: "src/a.ts", line: 1, end_line: null, side: "RIGHT" as const, severity: "major" as const,
    category: "correctness" as const, title: "T", body: "B", failure_scenario: "F", evidence: ["src/a.ts:1"],
  };

  it("picks the other engine, else the same one", () => {
    const c = fakeEngine("claude", untilAborted).engine;
    const x = fakeEngine("codex", untilAborted).engine;
    expect(verifierFor("claude", [c, x])).toBe(x);
    expect(verifierFor("codex", [c, x])).toBe(c);
    expect(verifierFor("claude", [c])).toBe(c);
    expect(verifierFor("claude", [])).toBeNull();
  });

  it("verifyFinding sends the verify prompt and schema", async () => {
    const { engine, seen } = fakeEngine("codex", () => Promise.resolve({ confirmed: true, reason: "yes", evidence: ["src/a.ts:1"] }));
    const r = await verifyFinding(engine, finding, { context: PROMPT_CONTEXT, cwd: "/w", headSha: "h", timeoutMs: 1000 });
    expect(r.ok && r.output.confirmed).toBe(true);
    expect(seen[0]?.input.task).toBe("verify");
    expect(seen[0]?.input.outputSchema).toBe(VERIFY_OUTPUT_SCHEMA);
    expect(seen[0]?.input.prompt).toContain("<untrusted-0123456789abcdef>");
    expect(seen[0]?.input.cwd).toBe("/w");
  });

  it("verifyFinding reports invalid verifier output as a failure", async () => {
    const { engine } = fakeEngine("codex", () => Promise.resolve({ confirmed: "maybe" }));
    const r = await verifyFinding(engine, finding, { context: PROMPT_CONTEXT, cwd: "/w", headSha: "h", timeoutMs: 1000 });
    expect(r.ok).toBe(false);
  });

  it("resolveFinding sends the resolve prompt and schema", async () => {
    const { engine, seen } = fakeEngine("claude", () => Promise.resolve({ fixed: true, reason: "gone", evidence: [] }));
    const r = await resolveFinding(
      engine,
      { path: "src/a.ts", line: 1, end_line: null, side: "RIGHT", severity: "major", title: "T", body: "B" },
      { context: PROMPT_CONTEXT, cwd: "/w", headSha: "h", lastSha: "l", diff: "+x", timeoutMs: 1000 },
    );
    expect(r.ok && r.output.fixed).toBe(true);
    expect(seen[0]?.input.task).toBe("resolve");
    expect(seen[0]?.input.outputSchema).toBe(RESOLVE_OUTPUT_SCHEMA);
  });
});

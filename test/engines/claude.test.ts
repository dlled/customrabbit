import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDenyRules, claudeOptions, createClaudeEngine, runnerRootFromTemp, type ClaudeQuery, type ListDir } from "../../src/engines/claude.js";
import { registerSecret, resetSecretsForTests } from "../../src/env.js";
import { NOW_MS, reviewEngineInput, reviewOutputFixture } from "./helpers.js";

const ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/myrabbit-claude",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-token-0000",
  CLAUDE_AGENT_SDK_CLIENT_APP: "myrabbit/0.1.0",
  MYRABBIT_CLAUDE_BIN: "/opt/action/node_modules/claude",
};
const CONFIG = { model: "claude-opus-5-5", effort: "high" as const, max_turns: 40, max_budget_usd: 3 };
const EXE = "/opt/action/bin/as-agent-claude";

function msg(m: unknown): SDKMessage {
  return m as SDKMessage;
}

function assistant(content: unknown[]): SDKMessage {
  return msg({ type: "assistant", message: { model: "claude-opus-5-5", content }, parent_tool_use_id: null });
}

function result(fields: Record<string, unknown>): SDKMessage {
  return msg({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.42,
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 30, cacheCreationInputTokens: 20, thinkingTokens: 10, costUSD: 0.42 },
    },
    permission_denials: [{ tool_name: "Read", tool_use_id: "t9", tool_input: {} }],
    errors: [],
    ...fields,
  });
}

/** A fake query() that records its options and yields `messages`, then optionally throws. */
function fakeQuery(messages: SDKMessage[], opts: { throwAfter?: Error } = {}) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: ClaudeQuery = (params) => {
    calls.push(params);
    return (async function* () {
      await Promise.resolve();
      for (const m of messages) yield m;
      if (opts.throwAfter !== undefined) throw opts.throwAfter;
    })();
  };
  return { query, calls };
}

function engine(query: ClaudeQuery, deniedDirs: string[] = []) {
  let t = NOW_MS;
  return createClaudeEngine({ config: CONFIG, env: ENV, executable: EXE, deniedDirs, query, now: () => (t += 1000) });
}

afterEach(() => {
  resetSecretsForTests();
});

/** A fake directory tree: dir → entries. Unknown dirs cannot be listed. */
function fakeTree(tree: Record<string, string[]>): ListDir {
  return (dir) => tree[dir] ?? null;
}

/** Paths whose Read, Grep and Glob are all denied, as permission-rule patterns. */
function deniedForAllTools(rules: string[]): Set<string> {
  const patterns = new Set(rules.map((r) => r.replace(/^(Read|Grep|Glob)\((.*)\)$/, "$2")));
  for (const p of patterns) for (const t of ["Read", "Grep", "Glob"]) expect(rules).toContain(`${t}(${p})`);
  return patterns;
}

const STANDARD_TREE = fakeTree({
  "/home": ["runner", "myrabbit-claude", "myrabbit-codex", "ubuntu"],
  "/home/runner": ["actions-runner", ".bashrc", ".ssh"],
  "/home/runner/actions-runner": [".runner", ".credentials", ".credentials_rsaparams", ".env", ".path", "_diag", "bin", "externals", "_work"],
  "/home/runner/actions-runner/_work": ["_temp", "_actions", "_tool", "other-repo", "r"],
  "/home/runner/actions-runner/_work/r": ["r", "r.tmp"],
});

describe("claudeDenyRules", () => {
  it("denies every root wholesale when the checkout is outside them", () => {
    const { rules, skipped, unlisted } = claudeDenyRules("/work/repo", { runnerDir: "/opt/runner", extraDirs: ["/opt/runner/_work/_temp/"], listDir: fakeTree({}) });
    expect(skipped).toEqual([]);
    expect(unlisted).toEqual([]);
    const denied = deniedForAllTools(rules);
    for (const p of ["//proc/**", "//sys/**", "//etc/**", "//home/**", "//root/**", "//tmp/**", "~/**", "//opt/runner/**", "//opt/runner/_work/_temp/**"]) {
      expect(denied).toContain(p);
    }
    for (const e of [".runner", ".credentials*", ".env", ".path", "_diag/**", "_temp/**"]) expect(denied).toContain(`//opt/runner/${e}`);
  });

  it("standard layout: walks /home and the runner dir down to the checkout, denying every sibling", () => {
    const cwd = "/home/runner/actions-runner/_work/r/r";
    const { rules, skipped, unlisted } = claudeDenyRules(cwd, {
      runnerDir: "/home/runner/actions-runner",
      extraDirs: ["/home/runner/actions-runner/_work/_temp"],
      listDir: STANDARD_TREE,
    });
    expect(skipped).toEqual(["/home", "/home/runner/actions-runner"]);
    expect(unlisted).toEqual([]);
    const denied = deniedForAllTools(rules);
    for (const path of [
      "/home/myrabbit-claude", "/home/myrabbit-codex", "/home/ubuntu",
      "/home/runner/.bashrc", "/home/runner/.ssh",
      "/home/runner/actions-runner/.runner", "/home/runner/actions-runner/.credentials",
      "/home/runner/actions-runner/.credentials_rsaparams", "/home/runner/actions-runner/.env",
      "/home/runner/actions-runner/_diag", "/home/runner/actions-runner/bin",
      "/home/runner/actions-runner/_work/_temp", "/home/runner/actions-runner/_work/_actions",
      "/home/runner/actions-runner/_work/other-repo", "/home/runner/actions-runner/_work/r/r.tmp",
    ]) {
      expect(denied, path).toContain(`/${path}`);
      expect(denied, path).toContain(`/${path}/**`);
    }
    // Explicit runner rules, even though the walk covers them.
    for (const e of [".runner", ".credentials*", ".env", ".path", "_diag/**", "_temp/**"]) {
      expect(denied).toContain(`//home/runner/actions-runner/${e}`);
    }
    // Nothing on the path to the checkout, nor the checkout itself, is denied.
    for (const p of ["//home/**", "//home/runner", "//home/runner/**", "//home/runner/actions-runner/**", "//home/runner/actions-runner/_work/**", "//home/runner/actions-runner/_work/r/**", `/${cwd}`, `/${cwd}/**`]) {
      expect(denied, p).not.toContain(p);
    }
    expect([...denied].some((p) => p === `/${cwd}` || p.startsWith(`/${cwd}/`))).toBe(false);
  });

  it("unusual layout: checkout directly in a denied root, runner dir elsewhere", () => {
    const { rules, skipped, unlisted } = claudeDenyRules("/tmp/ws/repo", {
      runnerDir: "/srv/gh-runner",
      listDir: fakeTree({ "/tmp": ["ws", "systemd-private-x", "myrabbit-codex-abc"], "/tmp/ws": ["repo", "weird name*"] }),
    });
    expect(skipped).toEqual(["/tmp"]);
    expect(unlisted).toEqual(["/tmp/ws/weird name*"]);
    const denied = deniedForAllTools(rules);
    expect(denied).toContain("//srv/gh-runner/**");
    expect(denied).toContain("//tmp/myrabbit-codex-abc/**");
    expect(denied).toContain("//tmp/systemd-private-x");
    expect(denied).toContain("//home/**");
    expect(denied).not.toContain("//tmp/**");
    expect(denied).not.toContain("//tmp/ws/**");
  });

  it("reports directories that cannot be listed", () => {
    const { skipped, unlisted } = claudeDenyRules("/home/runner/actions-runner/_work/r/r", { listDir: fakeTree({ "/home": ["runner"] }) });
    expect(skipped).toEqual(["/home"]);
    expect(unlisted).toEqual(["/home/runner", "/home/runner/actions-runner", "/home/runner/actions-runner/_work", "/home/runner/actions-runner/_work/r"]);
  });

  it("lists a real directory tree by default", () => {
    const root = mkdtempSync(join(tmpdir(), "myrabbit-deny-"));
    try {
      const runner = join(root, "actions-runner");
      mkdirSync(join(runner, "_work", "r", "r"), { recursive: true });
      mkdirSync(join(runner, "_diag"));
      writeFileSync(join(runner, ".credentials"), "fake");
      const { rules, skipped } = claudeDenyRules(join(runner, "_work", "r", "r"), { runnerDir: runner });
      expect(skipped).toEqual([runner]);
      const denied = deniedForAllTools(rules);
      expect(denied).toContain(`/${runner}/.credentials`);
      expect(denied).toContain(`/${runner}/_diag/**`);
      expect(denied).not.toContain(`/${runner}/_work/**`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the runner root from RUNNER_TEMP", () => {
    expect(runnerRootFromTemp("/home/runner/actions-runner/_work/_temp")).toBe("/home/runner/actions-runner");
    expect(runnerRootFromTemp("/home/runner/actions-runner/_work/_temp/")).toBe("/home/runner/actions-runner");
    expect(runnerRootFromTemp("/var/tmp/runner")).toBeNull();
    expect(runnerRootFromTemp("/_work/_temp")).toBeNull();
  });

  it("rejects relative directories", () => {
    expect(() => claudeDenyRules("/work/repo", { extraDirs: ["relative/dir"] })).toThrow(/absolute/);
  });
});

describe("claudeOptions", () => {
  it("is the exact read-only option set of §9", () => {
    const ac = new AbortController();
    const o = claudeOptions({ config: CONFIG, env: ENV, executable: EXE, runnerDir: "/opt/runner", listDir: () => null }, reviewEngineInput(), ac);
    expect(o).toMatchObject({
      cwd: "/work/repo",
      model: "claude-opus-5-5",
      effort: "high",
      systemPrompt: "SYSTEM PART",
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "dontAsk",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 40,
      maxBudgetUsd: 3,
      pathToClaudeCodeExecutable: EXE,
    });
    expect(o.abortController).toBe(ac);
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: reviewEngineInput().outputSchema });
    expect(o.disallowedTools?.slice(0, 7)).toEqual(["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent"]);
    expect(o.disallowedTools).toContain("Glob(//opt/runner/**)");
    expect(o.env).toEqual(ENV);
    expect(o.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(o.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(JSON.stringify(o)).not.toContain("bypassPermissions");
  });
});

describe("createClaudeEngine", () => {
  it("returns parsed structured output with usage, cost, tool calls and denials", async () => {
    const { query, calls } = fakeQuery([
      assistant([{ type: "text", text: "looking" }, { type: "tool_use", name: "Read", id: "t1", input: {} }]),
      assistant([{ type: "tool_use", name: "Grep", id: "t2", input: {} }]),
      assistant([{ type: "tool_use", name: "StructuredOutput", id: "t3", input: {} }]),
      result({ structured_output: reviewOutputFixture() }),
    ]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("REVIEW PART");
    expect(r).toMatchObject({
      ok: true,
      engine: "claude",
      model: "claude-opus-5-5",
      costUsd: 0.42,
      toolCalls: 2,
      denials: 1,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 30, cacheWriteInputTokens: 20, reasoningOutputTokens: 10 },
    });
    expect(r.durationMs).toBeGreaterThan(0);
    if (r.ok) expect(r.output).toEqual(reviewOutputFixture());
  });

  it.each([
    ["error_max_budget_usd", "budget"],
    ["error_max_turns", "budget"],
    ["error_max_structured_output_retries", "invalid_output"],
    ["error_during_execution", "sdk_error"],
  ])("maps %s to %s, keeping usage", async (subtype, kind) => {
    const { query } = fakeQuery([result({ subtype, errors: ["boom"] })], { throwAfter: new Error("query failed") });
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind);
      expect(r.error.message).toContain(subtype);
    }
    expect(r.costUsd).toBe(0.42);
  });

  // Same classification as Codex (common.ts); what the pipeline does with Claude is unchanged.
  it.each([
    ["quota", { errors: ["Claude AI usage limit reached|1767225600"] }],
    ["rate_limit", { errors: ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'] }],
    ["auth", { errors: ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'] }],
  ] as const)("classifies an error_during_execution as %s", async (kind, extra) => {
    const { query } = fakeQuery([result({ subtype: "error_during_execution", ...extra })]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(!r.ok && r.error.kind).toBe(kind);
  });

  // How an API error normally arrives: subtype "success", is_error true, the text in `result`.
  it.each([
    ["quota", "Claude AI usage limit reached|1767225600"],
    ["auth", "Invalid API key · Please run /login"],
    ["auth", 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'],
    ["rate_limit", 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'],
  ] as const)("classifies an is_error success result as %s", async (kind, text) => {
    const { query } = fakeQuery([result({ is_error: true, result: text })]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind);
      expect(r.error.message).toBe(`claude: ${text}`);
    }
  });

  it("an is_error result with any other text keeps its current kind and message", async () => {
    const text = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
    const { query } = fakeQuery([result({ is_error: true, result: text })]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_output");
      expect(r.error.message).toBe("claude: run ended without structured output");
    }
  });

  it("classifies a thrown quota error without a result", async () => {
    const { query } = fakeQuery([], { throwAfter: new Error("Claude AI usage limit reached|1767225600") });
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(!r.ok && r.error.kind).toBe("quota");
  });

  it("treats success without structured output as invalid", async () => {
    const { query } = fakeQuery([result({})]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(!r.ok && r.error.kind).toBe("invalid_output");
  });

  it("treats output that fails zod as invalid", async () => {
    const { query } = fakeQuery([result({ structured_output: { summary: "x" } })]);
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(!r.ok && r.error.kind).toBe("invalid_output");
  });

  it("reports a throw without a result as sdk_error, redacted", async () => {
    registerSecret("fake-claude-oauth-token-0000");
    const { query } = fakeQuery([], { throwAfter: new Error("spawn failed with fake-claude-oauth-token-0000\nstack") });
    const r = await engine(query).review(reviewEngineInput(), new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("sdk_error");
      expect(r.error.message).not.toContain("fake-claude-oauth-token-0000");
      expect(r.error.message).toContain("***");
      expect(r.error.message).not.toContain("\n");
    }
  });

  it("forwards abort to the SDK abortController and reports timeout", async () => {
    let seen: AbortSignal | undefined;
    const query: ClaudeQuery = (params) => {
      seen = params.options.abortController?.signal;
      return (async function* () {
        await new Promise((_resolve, reject) => {
          seen?.addEventListener("abort", () => { reject(new Error("aborted by user")); });
        });
        yield msg({});
      })();
    };
    const r = await engine(query).review(reviewEngineInput(), AbortSignal.timeout(10));
    expect(seen?.aborted).toBe(true);
    expect(!r.ok && r.error.kind).toBe("timeout");
  });

  it("does not start when the signal is already aborted", async () => {
    const { query, calls } = fakeQuery([]);
    const ac = new AbortController();
    ac.abort();
    const r = await engine(query).review(reviewEngineInput(), ac.signal);
    expect(calls).toHaveLength(0);
    expect(!r.ok && r.error.kind).toBe("aborted");
  });
});

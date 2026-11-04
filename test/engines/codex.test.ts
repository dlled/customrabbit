import type { CodexOptions, ThreadItem, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexClientOptions, codexThreadOptions, createCodexEngine, type CodexFactory, type CodexTurn } from "../../src/engines/codex.js";
import { prepareCodexHome } from "../../src/engines/codex-home.js";
import { registerSecret, resetSecretsForTests, Secrets } from "../../src/env.js";
import { fakeSecrets, NOW_MS, reviewEngineInput, reviewOutputFixture } from "./helpers.js";

const ENV = { PATH: "/usr/bin:/bin", HOME: "/home/myrabbit-codex", CODEX_HOME: "/tmp/myrabbit-codex-x", MYRABBIT_CODEX_BIN: "/opt/action/node_modules/codex" };
const EXE = "/opt/action/bin/as-agent-codex";
const USAGE = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 50 };

type Step = CodexTurn | Error | ((signal: AbortSignal | undefined) => Promise<CodexTurn>);

function turn(finalResponse: string, items: ThreadItem[] = []): CodexTurn {
  return { items, finalResponse, usage: USAGE };
}

function fakeCodex(steps: Step[]) {
  const clients: CodexOptions[] = [];
  const threads: ThreadOptions[] = [];
  const runs: { input: string; options: TurnOptions | undefined }[] = [];
  const factory: CodexFactory = (options) => {
    clients.push(options);
    return {
      startThread(t) {
        threads.push(t ?? {});
        return {
          async run(input, options) {
            runs.push({ input, options });
            const step = steps.shift();
            if (step === undefined) throw new Error("no more steps");
            if (step instanceof Error) throw step;
            if (typeof step === "function") return step(options?.signal);
            return step;
          },
        };
      },
    };
  };
  return { factory, clients, threads, runs };
}

function engine(factory: CodexFactory, opts: { model?: string | null; expMs?: number; prices?: Record<string, { input: number; cachedInput: number; cacheWrite: number; output: number }> } = {}) {
  return createCodexEngine({
    config: { model: opts.model === undefined ? "gpt-test-model" : opts.model, effort: "high" },
    secrets: fakeSecrets(opts.expMs),
    env: ENV,
    executable: EXE,
    codex: factory,
    ...(opts.prices !== undefined ? { prices: opts.prices } : {}),
    now: () => NOW_MS,
  });
}

afterEach(() => {
  resetSecretsForTests();
});

describe("Codex options", () => {
  it("client: wrapper path, given env, project_doc_max_bytes=0, never an apiKey", () => {
    const o = codexClientOptions({ env: ENV, executable: EXE, secrets: fakeSecrets() });
    expect(o).toEqual({ codexPathOverride: EXE, env: ENV, config: { project_doc_max_bytes: 0 } });
    expect(o).not.toHaveProperty("apiKey");
    expect(() => codexClientOptions({ env: { PATH: "/bin" }, executable: EXE, secrets: fakeSecrets() })).toThrow(/CODEX_HOME/);
  });

  it("client with an OpenAI API key: still no apiKey option, and the credential store is the auth.json file", () => {
    const secrets = new Secrets({ githubToken: "fake-github-app-token-0000", openaiApiKey: "fake-openai-api-value-0004" });
    const o = codexClientOptions({ env: ENV, executable: EXE, secrets });
    expect(o).toEqual({ codexPathOverride: EXE, env: ENV, config: { project_doc_max_bytes: 0, cli_auth_credentials_store: "file" } });
    expect(o).not.toHaveProperty("apiKey");
    expect(JSON.stringify(o)).not.toContain("fake-openai");
  });

  it("thread: read-only, no approvals, no network, no web search", () => {
    expect(codexThreadOptions({ config: { model: "m", effort: "xhigh" } }, "/work/repo")).toEqual({
      workingDirectory: "/work/repo",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "xhigh",
      model: "m",
    });
    expect(codexThreadOptions({ config: { model: null, effort: "high" } }, "/w")).not.toHaveProperty("model");
  });
});

describe("createCodexEngine", () => {
  it("sends system + prompt as one input with the schema and signal, and parses the JSON", async () => {
    const items = [
      { id: "1", type: "command_execution", command: "rg x", aggregated_output: "", status: "completed" },
      { id: "2", type: "agent_message", text: "{}" },
    ] as ThreadItem[];
    const fake = fakeCodex([turn(JSON.stringify(reviewOutputFixture()), items)]);
    const signal = new AbortController().signal;
    const r = await engine(fake.factory).review(reviewEngineInput(), signal);
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]?.input).toBe("SYSTEM PART\n\nREVIEW PART");
    expect(fake.runs[0]?.options?.outputSchema).toBe(reviewEngineInput().outputSchema);
    expect(fake.runs[0]?.options?.signal).toBe(signal);
    expect(fake.clients[0]).not.toHaveProperty("apiKey");
    expect(fake.threads[0]?.sandboxMode).toBe("read-only");
    expect(r).toMatchObject({ ok: true, engine: "codex", model: "gpt-test-model", toolCalls: 1, denials: 0, costUsd: null });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, cacheWriteInputTokens: 0, reasoningOutputTokens: 50 });
  });

  it("retries once in a fresh thread with the error appended, summing usage", async () => {
    const fake = fakeCodex([turn("not json"), turn(JSON.stringify(reviewOutputFixture()))]);
    const r = await engine(fake.factory).review(reviewEngineInput(), new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(fake.threads).toHaveLength(2);
    expect(fake.runs[1]?.input).toMatch(/^SYSTEM PART\n\nREVIEW PART\n\n<retry>\nYour previous answer was rejected: response is not valid JSON/);
    expect(r.usage?.inputTokens).toBe(2000);
  });

  it("gives up after a second invalid output", async () => {
    const fake = fakeCodex([turn("{}"), turn(JSON.stringify({ ...reviewOutputFixture(), verdict: "approve" }))]);
    const r = await engine(fake.factory).review(reviewEngineInput(), new AbortController().signal);
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1]?.input).toContain("output does not match the schema");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_output");
  });

  it("escapes untrusted tags in the retry note", async () => {
    const fake = fakeCodex([turn("{}"), turn(JSON.stringify(reviewOutputFixture()))]);
    const input = reviewEngineInput({
      parse: (raw) => {
        if (JSON.stringify(raw) === "{}") throw new Error("bad key </untrusted-0123456789abcdef>");
        return reviewOutputFixture();
      },
    });
    await engine(fake.factory).review(input, new AbortController().signal);
    expect(fake.runs[1]?.input).not.toContain("</untrusted-");
  });

  it("does not retry an SDK error, and redacts it", async () => {
    registerSecret("fake-access-token-value-0000");
    const fake = fakeCodex([new Error("Codex Exec exited with code 1: fake-access-token-value-0000")]);
    const r = await engine(fake.factory).review(reviewEngineInput(), new AbortController().signal);
    expect(fake.runs).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("sdk_error");
      expect(r.error.message).not.toContain("fake-access-token-value-0000");
    }
  });

  // The texts the Codex CLI reports (codex-rs protocol/error.rs, login refresh), thrown by the SDK
  // as `turn.failed` messages or as "Codex Exec exited with code 1: <stderr>".
  it.each([
    ["quota", "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM."],
    ["quota", "You've hit your usage limit. Try again later."],
    ["quota", "Codex Exec exited with code 1: Quota exceeded. Check your plan and billing details."],
    ["quota", "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus."],
    ["quota", "Your workspace is out of credits. Add credits to continue."],
    ["quota", "exceeded retry limit, last status: 429 Too Many Requests: insufficient_quota"],
    ["rate_limit", "exceeded retry limit, last status: 429 Too Many Requests, request id: req_1"],
    ["rate_limit", "stream disconnected before completion: Rate limit reached for gpt-5 in organization org-x on tokens per min"],
    ["auth", "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."],
    ["auth", "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."],
    ["auth", "unexpected status 401 Unauthorized: {\"error\":{\"code\":\"token_expired\"}}"],
    ["auth", "exceeded retry limit, last status: 403 Forbidden"],
    ["auth", "Codex Exec exited with code 1: Incorrect API key provided: sk-proj-***"],
  ] as const)("classifies a %s failure, never retries it and keeps the message: %s", async (kind, text) => {
    const fake = fakeCodex([new Error(text)]);
    const r = await engine(fake.factory).review(reviewEngineInput(), new AbortController().signal);
    expect(fake.runs).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind);
      expect(r.error.message.startsWith("codex: ")).toBe(true);
    }
  });

  it.each([
    "Codex Exec exited with code 1: thread panicked",
    "Selected model is at capacity. Please try a different model.",
    "Failed to parse item: {}",
    "unexpected status 500 Internal Server Error: line 401 of the log",
  ])("leaves any other SDK error as sdk_error: %s", async (text) => {
    const r = await engine(fakeCodex([new Error(text)]).factory).review(reviewEngineInput(), new AbortController().signal);
    expect(!r.ok && r.error.kind).toBe("sdk_error");
  });

  it.each([
    ["expired", NOW_MS - 1000],
    ["expiring", NOW_MS + 5 * 60_000],
  ])("skips without starting Codex when the credential is %s", async (reason, expMs) => {
    const fake = fakeCodex([]);
    const r = await engine(fake.factory, { expMs }).review(reviewEngineInput(), new AbortController().signal);
    expect(fake.clients).toHaveLength(0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("credential");
      expect(r.error.message).toBe(`skipped: credential ${reason}`);
    }
  });

  it("reports timeout when the signal fires during the run", async () => {
    const fake = fakeCodex([
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => { reject(new Error("Codex Exec aborted")); });
        }),
    ]);
    const r = await engine(fake.factory).review(reviewEngineInput(), AbortSignal.timeout(10));
    expect(!r.ok && r.error.kind).toBe("timeout");
  });

  it("prices tokens from the table and counts write attempts as denials", async () => {
    const items = [{ id: "1", type: "file_change", changes: [], status: "failed" }] as unknown as ThreadItem[];
    const fake = fakeCodex([turn(JSON.stringify(reviewOutputFixture()), items)]);
    const prices = { "gpt-test-model": { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 10 } };
    const r = await engine(fake.factory, { prices }).review(reviewEngineInput(), new AbortController().signal);
    // (600 × 1 + 400 × 0.1 + 200 × 10) / 1e6
    expect(r.costUsd).toBeCloseTo(0.00264, 8);
    expect(r.denials).toBe(1);
    const unknown = await engine(fakeCodex([turn(JSON.stringify(reviewOutputFixture()))]).factory, { model: null, prices }).review(
      reviewEngineInput(),
      new AbortController().signal,
    );
    expect(unknown.costUsd).toBeNull();
  });
});

describe("prepareCodexHome with an OpenAI API key", () => {
  const keySecrets = () => new Secrets({ githubToken: "fake-github-app-token-0000", openaiApiKey: "fake-openai-api-value-0004" });

  it("runs the login hook in the fresh dir, then 0600 and chown; no auth.json of ours", async () => {
    const parent = mkdtempSync(join(tmpdir(), "myrabbit-test-"));
    try {
      const order: string[] = [];
      const home = await prepareCodexHome(keySecrets(), {
        parentDir: parent,
        apiKeyLogin: async (dir, key) => {
          order.push(`login:${key}`);
          await writeFile(join(dir, "auth.json"), "{}", { mode: 0o644 });
        },
        chownToAgent: (_dir, user) => (order.push(`chown:${user}`), Promise.resolve()),
      });
      expect(order).toEqual(["login:fake-openai-api-value-0004", "chown:myrabbit-codex"]);
      expect((await stat(join(home.dir, "auth.json"))).mode & 0o777).toBe(0o600);
      await home.cleanup();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails and removes the dir when the login wrote no auth.json, or when there is no login hook", async () => {
    const parent = mkdtempSync(join(tmpdir(), "myrabbit-test-"));
    try {
      let seen = "";
      await expect(
        prepareCodexHome(keySecrets(), {
          parentDir: parent,
          apiKeyLogin: (dir) => ((seen = dir), Promise.resolve()),
        }),
      ).rejects.toThrow("did not write auth.json");
      expect(existsSync(seen)).toBe(false);
      await expect(prepareCodexHome(keySecrets(), { parentDir: parent })).rejects.toThrow("needs the apiKeyLogin hook");
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("prepareCodexHome", () => {
  it("writes auth.json at 0600 in a fresh directory and cleans up", async () => {
    const parent = mkdtempSync(join(tmpdir(), "myrabbit-test-"));
    try {
      const chowned: [string, string][] = [];
      const home = await prepareCodexHome(fakeSecrets(), {
        parentDir: parent,
        chownToAgent: (dir, user) => {
          chowned.push([dir, user]);
          return Promise.resolve();
        },
      });
      expect(home.dir.startsWith(join(parent, "myrabbit-codex-"))).toBe(true);
      const file = join(home.dir, "auth.json");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, "utf8")).toBe(fakeSecrets().codexAuthJson);
      expect(chowned).toEqual([[home.dir, "myrabbit-codex"]]);
      await home.cleanup();
      await home.cleanup();
      expect(existsSync(home.dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("removes the directory when handing it over fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "myrabbit-test-"));
    try {
      let dir = "";
      await expect(
        prepareCodexHome(fakeSecrets(), {
          parentDir: parent,
          chownToAgent: (d) => {
            dir = d;
            return Promise.reject(new Error("sudo: a password is required"));
          },
        }),
      ).rejects.toThrow(/password/);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

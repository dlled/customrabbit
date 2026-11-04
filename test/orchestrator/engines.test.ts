// Engine setup (§9.1, §9.2) without sudo: the guest-user check is injected.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/index.js";
import { resetSecretsForTests, Secrets } from "../../src/env.js";
import { actionRoot } from "../../src/main.js";
import { BinaryNotFoundError, resolveClaudeBinary, resolveCodexBinary } from "../../src/orchestrator/binaries.js";
import { codexApiKeyLogin, EngineSetupError, ISOLATION_NONE_WARNING, realEngineSetup } from "../../src/orchestrator/engines.js";
import { runPipeline } from "../../src/orchestrator/pipeline.js";
import type { Config } from "../../src/types.js";
import { appSource, fakeCodexAuthJson, harness, type Harness } from "./harness.js";

const ROOT = actionRoot(new URL("../../src/main.ts", import.meta.url).href);

const secrets = (codexExpMs: number): Secrets =>
  new Secrets({ githubToken: "fake-github-app-token-0000", claudeOauthToken: "fake-claude-oauth-token-0000", codexAuthJson: fakeCodexAuthJson(codexExpMs) });

const config = (claude: boolean, codex: boolean): Config => {
  const c = defaultConfig();
  return { ...c, engines: { ...c.engines, claude: { ...c.engines.claude, enabled: claude }, codex: { ...c.engines.codex, enabled: codex } } };
};

const input = (cfg: Config, codexExpMs = Date.now() + 3600_000) => ({
  config: cfg,
  secrets: secrets(codexExpMs),
  workspace: "/nonexistent/work/r/r",
  runnerTemp: "/nonexistent/runner/_work/_temp",
  now: Date.now(),
  log: () => undefined,
  isolation: "guest-users" as const,
});

describe("realEngineSetup", () => {
  it("skips codex before starting when its token is expired, without creating CODEX_HOME", async () => {
    const users: string[] = [];
    const setup = realEngineSetup({ actionRoot: ROOT, checkUser: (u) => (users.push(u), Promise.resolve()) });
    const s = await setup(input(config(false, true), Date.now() - 1000));
    expect(s.engines).toEqual([]);
    expect(s.notRunning).toEqual([
      { engine: "claude", status: "disabled" },
      { engine: "codex", status: "failed", error: "skipped: credential expired", errorKind: "credential", durationMs: 0 },
    ]);
    expect(users).toEqual([]);
    await s.cleanup();
  });

  it("builds the claude engine behind the wrapper after the guest-user check", async () => {
    const users: string[] = [];
    const setup = realEngineSetup({ actionRoot: ROOT, checkUser: (u) => (users.push(u), Promise.resolve()) });
    const s = await setup(input(config(true, false)));
    expect(users).toEqual(["myrabbit-claude"]);
    expect(s.engines.map((e) => e.name)).toEqual(["claude"]);
    expect(s.notRunning).toEqual([{ engine: "codex", status: "disabled" }]);
    await s.cleanup();
  });

  it("fails closed when a guest user cannot be used", async () => {
    const setup = realEngineSetup({ actionRoot: ROOT, checkUser: () => Promise.reject(new EngineSetupError("cannot run commands as myrabbit-claude")) });
    await expect(setup(input(config(true, true)))).rejects.toThrow(EngineSetupError);
  });
});

describe("realEngineSetup with isolation none", () => {
  it("makes no guest-user check, warns, and runs both engines as the runner user", async () => {
    const users: string[] = [];
    const logs: string[] = [];
    const setup = realEngineSetup({ actionRoot: ROOT, checkUser: (u) => (users.push(u), Promise.resolve()) });
    const s = await setup({ ...input(config(true, true)), isolation: "none", log: (m) => logs.push(m) });
    expect(users).toEqual([]);
    expect(s.engines.map((e) => e.name)).toEqual(["claude", "codex"]);
    expect(logs).toContain(ISOLATION_NONE_WARNING);
    expect(ISOLATION_NONE_WARNING).toMatch(/^::warning::.*can read everything/);
    await s.cleanup();
  });

  it("an OpenAI API key goes through codex login --with-api-key into a fresh CODEX_HOME, removed by cleanup", async () => {
    const calls: { dir: string; key: string }[] = [];
    const setup = realEngineSetup({
      actionRoot: ROOT,
      checkUser: () => Promise.reject(new Error("no sudo here")),
      codexApiKeyLogin: async (dir, key) => {
        calls.push({ dir, key });
        await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
      },
    });
    const keySecrets = new Secrets({ githubToken: "fake-github-app-token-0000", openaiApiKey: "fake-openai-api-value-0004" });
    const s = await setup({ ...input(config(false, true)), secrets: keySecrets, isolation: "none" });
    expect(s.engines.map((e) => e.name)).toEqual(["codex"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe("fake-openai-api-value-0004");
    const dir = calls[0]?.dir ?? "";
    expect(dir).toMatch(/myrabbit-codex-/);
    expect(existsSync(join(dir, "auth.json"))).toBe(true);
    await s.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  it("fails before any engine when the API-key login fails, and leaves no CODEX_HOME", async () => {
    let seen = "";
    const setup = realEngineSetup({
      actionRoot: ROOT,
      codexApiKeyLogin: (dir) => {
        seen = dir;
        return Promise.reject(new EngineSetupError("codex login --with-api-key failed (exit 1)"));
      },
    });
    const keySecrets = new Secrets({ githubToken: "fake-github-app-token-0000", openaiApiKey: "fake-openai-api-value-0004" });
    await expect(setup({ ...input(config(false, true)), secrets: keySecrets, isolation: "none" })).rejects.toThrow("codex login --with-api-key failed");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });
});

describe("codexApiKeyLogin", () => {
  it("passes the key on stdin, never argv, with CODEX_HOME and file storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myrabbit-login-test-"));
    try {
      // A stand-in CLI that records argv, the env it sees and stdin, then writes auth.json.
      const fake = join(dir, "codex");
      writeFileSync(
        fake,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CODEX_HOME/argv"\nenv > "$CODEX_HOME/env"\ncat > "$CODEX_HOME/stdin"\necho "{}" > "$CODEX_HOME/auth.json"\n',
        { mode: 0o755 },
      );
      const home = join(dir, "home");
      mkdirSync(home);
      await codexApiKeyLogin(fake, { PATH: "/usr/bin:/bin" })(home, "fake-openai-api-value-0004");
      const argv = readFileSync(join(home, "argv"), "utf8");
      expect(argv.split("\n").filter(Boolean)).toEqual(["-c", 'cli_auth_credentials_store="file"', "login", "--with-api-key"]);
      expect(argv).not.toContain("fake-openai");
      expect(readFileSync(join(home, "stdin"), "utf8")).toBe("fake-openai-api-value-0004\n");
      const env = readFileSync(join(home, "env"), "utf8");
      expect(env).toContain(`CODEX_HOME=${home}`);
      expect(env).toContain(`HOME=${home}`);
      expect(env).not.toContain("fake-openai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with the exit code, never the CLI's output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myrabbit-login-test-"));
    try {
      const fake = join(dir, "codex");
      writeFileSync(fake, "#!/bin/sh\ncat >/dev/null\necho \"bad key $1\" >&2\nexit 3\n", { mode: 0o755 });
      await expect(codexApiKeyLogin(fake, { PATH: "/usr/bin:/bin" })(dir, "fake-openai-api-value-0004")).rejects.toThrow(
        new EngineSetupError("codex login --with-api-key failed (exit 3)"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("native binaries", () => {
  it("finds the installed CLIs for this platform", () => {
    expect(resolveClaudeBinary({ from: ROOT })).toMatch(/claude-agent-sdk-[a-z0-9-]+\/claude$/);
    const codex = resolveCodexBinary({ from: ROOT });
    expect(codex.bin).toMatch(/\/codex$/);
  });

  it("reports unsupported platforms", () => {
    expect(() => resolveClaudeBinary({ from: ROOT, platform: "aix", arch: "ppc64" })).toThrow(BinaryNotFoundError);
    expect(() => resolveCodexBinary({ from: ROOT, platform: "aix", arch: "ppc64" })).toThrow(BinaryNotFoundError);
  });
});

describe("pipeline with a failing guest-user check", () => {
  let h: Harness;
  beforeEach(() => {
    resetSecretsForTests();
    h = harness();
  });
  afterEach(() => {
    h.cleanup();
    resetSecretsForTests();
  });

  it("exits 1 before any model call and posts nothing", async () => {
    const base = h.repo.commit("base", { "src/app.ts": appSource() });
    h.repo.git("checkout", "-q", "-b", "feature");
    const head = h.repo.commit("change", { "src/app.ts": appSource({ 5: "export const a5 = 50;" }) });
    h.routes({ head, base });
    const setupEngines = realEngineSetup({ actionRoot: ROOT, checkUser: (u) => Promise.reject(new EngineSetupError(`cannot run commands as ${u}`)) });
    expect(await runPipeline(h.deps({}, { setupEngines }))).toBe(1);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("cannot run commands as myrabbit-claude");
  });
});

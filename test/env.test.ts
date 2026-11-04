import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_AGENT_ENV_ALLOWLIST,
  CLAUDE_BIN_VAR,
  CODEX_AGENT_ENV_ALLOWLIST,
  CODEX_BIN_VAR,
  claudeEnv,
  codexCredentialStatus,
  codexEnv,
  codexTokenUsable,
  InvalidEnvError,
  loadRuntimeEnv,
  MissingSecretError,
  NONE_NEEDS_ONE_ENGINE,
  redact,
  registerSecret,
  resetSecretsForTests,
  secretValues,
  Secrets,
  TRUSTED_AUTHORS_REQUIRED,
  type RuntimeEnv,
} from "../src/env.js";

// Every value here is fake. Token-shaped strings are built at runtime so no credential-looking
// literal lives in the repository.

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MIN = 60 * 1000;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned-but-well-formed fake JWT; the signature part is filler. */
function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.${"s".repeat(16)}`;
}

function codexAuthJson(accessToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgptAuthTokens",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ sub: "fake-user", exp: NOW / 1000 + 3600 }),
      access_token: accessToken,
      refresh_token: "",
      account_id: "fake-account",
    },
  });
}

const ACCESS_TOKEN = fakeJwt({ sub: "fake-user", exp: NOW / 1000 + 6 * 3600 });

const FAKE = {
  MYRABBIT_GITHUB_TOKEN: "fake-app-installation-value-0001",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-value-0002",
  CODEX_AUTH_JSON: codexAuthJson(ACCESS_TOKEN),
};

/** A parent env resembling the orchestrator step on a WTR runner. */
function runnerEnv(): NodeJS.ProcessEnv {
  return {
    ...FAKE,
    MYRABBIT_BOT_LOGIN: "myrabbit[bot]",
    PATH: "/opt/node/bin:/usr/bin:/bin",
    HOME: "/home/runner",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "dlled/example",
    GITHUB_TOKEN: "fake-workflow-token-value",
    ACTIONS_RUNTIME_TOKEN: "fake-actions-runtime-value",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc-request-value",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    RUNNER_TEMP: "/home/runner/_temp",
    MYRABBIT_TRUSTED_AUTHORS: "dlled",
    // action.yml always sets the API-key variables on the step, empty unless the caller passes one.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "fake-stray-anthropic-auth-value",
    OPENAI_API_KEY: "",
    NODE_OPTIONS: "--require /tmp/evil.js",
  };
}

function load(env = runnerEnv()): { env: NodeJS.ProcessEnv; rt: RuntimeEnv } {
  return { env, rt: loadRuntimeEnv(env) };
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

beforeEach(() => {
  resetSecretsForTests();
});
afterEach(() => {
  resetSecretsForTests();
});

describe("loadRuntimeEnv", () => {
  it("returns the secrets, bot login and no PR override", () => {
    const { rt } = load();
    expect(rt.secrets.githubToken).toBe(FAKE.MYRABBIT_GITHUB_TOKEN);
    expect(rt.secrets.claudeOauthToken).toBe(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
    expect(rt.secrets.codexAuthJson).toBe(FAKE.CODEX_AUTH_JSON);
    expect(rt.botLogin).toBe("myrabbit[bot]");
    expect(rt.prNumber).toBeNull();
  });

  it("deletes the secrets from env and leaves runner variables alone", () => {
    const { env } = load();
    for (const name of Object.keys(FAKE)) expect(env).not.toHaveProperty(name);
    expect(env.ACTIONS_RUNTIME_TOKEN).toBe("fake-actions-runtime-value");
    expect(env.GITHUB_TOKEN).toBe("fake-workflow-token-value");
    expect(env.PATH).toBe("/opt/node/bin:/usr/bin:/bin");
  });

  it("never uses GITHUB_TOKEN as the GitHub token", () => {
    const env = runnerEnv();
    delete env.MYRABBIT_GITHUB_TOKEN;
    expect(() => loadRuntimeEnv(env)).toThrow(new MissingSecretError(["MYRABBIT_GITHUB_TOKEN"]));
  });

  it("reads process.env by default and removes the secrets from it", () => {
    for (const [k, v] of Object.entries(FAKE)) process.env[k] = v;
    process.env.MYRABBIT_BOT_LOGIN = "myrabbit[bot]";
    process.env.MYRABBIT_TRUSTED_AUTHORS = "dlled";
    try {
      const rt = loadRuntimeEnv();
      expect(rt.secrets.githubToken).toBe(FAKE.MYRABBIT_GITHUB_TOKEN);
      for (const name of Object.keys(FAKE)) expect(process.env).not.toHaveProperty(name);
    } finally {
      delete process.env.MYRABBIT_BOT_LOGIN;
      delete process.env.MYRABBIT_TRUSTED_AUTHORS;
    }
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "  \n\t"],
  ])("fails closed when a secret is %s", (_label, value) => {
    const env = runnerEnv();
    if (value === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = value;
    expect(() => loadRuntimeEnv(env)).toThrow(new MissingSecretError(["CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"]));
  });

  it("names every missing value and never prints a provided one", () => {
    const env = runnerEnv();
    env.CODEX_AUTH_JSON = "";
    delete env.MYRABBIT_BOT_LOGIN;
    const err = errorOf(() => loadRuntimeEnv(env));
    expect(err).toBeInstanceOf(MissingSecretError);
    expect(err.message).toBe("missing secret CODEX_AUTH_JSON or OPENAI_API_KEY, MYRABBIT_BOT_LOGIN");
    expect((err as MissingSecretError).names).toEqual(["CODEX_AUTH_JSON or OPENAI_API_KEY", "MYRABBIT_BOT_LOGIN"]);
    const text = `${err.message}\n${err.stack ?? ""}`;
    expect(text).not.toContain(FAKE.MYRABBIT_GITHUB_TOKEN);
    expect(text).not.toContain(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it("deletes the secrets from env and still redacts them when it fails", () => {
    const env = runnerEnv();
    env.MYRABBIT_GITHUB_TOKEN = "";
    expect(() => loadRuntimeEnv(env)).toThrow(MissingSecretError);
    for (const name of Object.keys(FAKE)) expect(env).not.toHaveProperty(name);
    expect(redact(`key=${FAKE.CLAUDE_CODE_OAUTH_TOKEN}`)).toBe("key=***");
  });

  it("trims a pasted trailing newline and redacts both forms", () => {
    const env = runnerEnv();
    env.CLAUDE_CODE_OAUTH_TOKEN = `${FAKE.CLAUDE_CODE_OAUTH_TOKEN}\n`;
    const { rt } = load(env);
    expect(rt.secrets.claudeOauthToken).toBe(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
    expect(redact(`echo ${FAKE.CLAUDE_CODE_OAUTH_TOKEN} end`)).toBe("echo *** end");
    expect(redact(`raw ${FAKE.CLAUDE_CODE_OAUTH_TOKEN}\nnext`)).toBe("raw ***next");
    expect(secretValues()).toContain(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it("validates MYRABBIT_BOT_LOGIN", () => {
    const env = runnerEnv();
    env.MYRABBIT_BOT_LOGIN = "evil login; rm -rf";
    expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError("invalid MYRABBIT_BOT_LOGIN"));
  });

  it.each([
    ["42", 42],
    [" 7 ", 7],
    ["", null],
  ])("parses MYRABBIT_PR %j", (raw, expected) => {
    const env = runnerEnv();
    env.MYRABBIT_PR = raw;
    expect(load(env).rt.prNumber).toBe(expected);
  });

  it.each(["0", "-1", "1.5", "12abc", "99999999999"])("rejects MYRABBIT_PR %j", (raw) => {
    resetSecretsForTests();
    const env = runnerEnv();
    env.MYRABBIT_PR = raw;
    expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError("invalid MYRABBIT_PR"));
  });

  it.each([
    ["single", "alice", ["alice"]],
    ["list with spaces, empties and dupes", " alice, bob-2 ,,alice,", ["alice", "bob-2"]],
    ["39-char login", "a".repeat(39), ["a".repeat(39)]],
  ])("parses MYRABBIT_TRUSTED_AUTHORS (%s)", (_label, raw, expected) => {
    const env = runnerEnv();
    env.MYRABBIT_TRUSTED_AUTHORS = raw;
    const { rt } = load(env);
    expect(rt.trustedAuthors).toEqual(expected);
    // Not a secret: never captured for redaction, never deleted.
    expect(secretValues()).not.toContain(raw);
    expect(env.MYRABBIT_TRUSTED_AUTHORS).toBe(raw);
  });

  it.each([
    ["unset", undefined],
    ["empty (a missing action input)", ""],
    ["blank", "   "],
    ["only commas and whitespace", "  , "],
  ])("MYRABBIT_TRUSTED_AUTHORS %s is a loud error, never a default login", (_label, raw) => {
    const env = runnerEnv();
    if (raw === undefined) Reflect.deleteProperty(env, "MYRABBIT_TRUSTED_AUTHORS");
    else env.MYRABBIT_TRUSTED_AUTHORS = raw;
    expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError(TRUSTED_AUTHORS_REQUIRED));
  });

  it.each(["alice,bob smith", "dependabot[bot]", "a".repeat(40), "alice;bob", "évil"])(
    "rejects MYRABBIT_TRUSTED_AUTHORS %j",
    (raw) => {
      const env = runnerEnv();
      env.MYRABBIT_TRUSTED_AUTHORS = raw;
      expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError("invalid MYRABBIT_TRUSTED_AUTHORS"));
    },
  );

  it("can only be called once", () => {
    load();
    expect(() => loadRuntimeEnv(runnerEnv())).toThrow("secrets already loaded");
  });

  it("never reveals values through JSON, inspect, String or spread", () => {
    const { rt } = load();
    const dumps = [
      JSON.stringify(rt),
      inspect(rt, { showHidden: true, depth: 5 }),
      String(rt.secrets),
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- spreading is the leak under test
      JSON.stringify({ ...rt.secrets }),
      Object.keys(rt.secrets).join(","),
    ];
    for (const dump of dumps) {
      for (const value of [...Object.values(FAKE), ACCESS_TOKEN]) expect(dump).not.toContain(value);
    }
  });
});

describe("secretValues", () => {
  it("captures every input secret, Codex sub-tokens and runner credentials", () => {
    const env = runnerEnv();
    env.SOME_DEPLOY_PASSWORD = "fake-password-value";
    env.MY_PRIVATE_KEY = "fake-private-key-value";
    env.UNRELATED = "plain-value";
    load(env);
    const values = secretValues();
    for (const v of [
      FAKE.MYRABBIT_GITHUB_TOKEN,
      FAKE.CLAUDE_CODE_OAUTH_TOKEN,
      FAKE.CODEX_AUTH_JSON,
      ACCESS_TOKEN,
      "fake-workflow-token-value",
      "fake-actions-runtime-value",
      "fake-oidc-request-value",
      "fake-stray-anthropic-auth-value",
      "fake-password-value",
      "fake-private-key-value",
    ]) {
      expect(values).toContain(v);
    }
    expect(values).not.toContain("plain-value");
    expect(values).not.toContain("myrabbit[bot]");
    expect(values).not.toContain("/home/runner");
  });

  it("makes redact() mask runner credentials", () => {
    load();
    expect(redact("rt=fake-actions-runtime-value oidc=fake-oidc-request-value gh=fake-workflow-token-value")).toBe(
      "rt=*** oidc=*** gh=***",
    );
  });
});

const CLAUDE_BIN = "/opt/myrabbit/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude";
const CODEX_BIN = "/opt/myrabbit/node_modules/@openai/codex/vendor/codex";

describe("claudeEnv", () => {
  it("is the allowlist plus MYRABBIT_CLAUDE_BIN, with myrabbit-claude's HOME", () => {
    const { env, rt } = load();
    const out = claudeEnv(rt.secrets, { clientApp: "myrabbit/0.1.0", realBin: CLAUDE_BIN, parent: env });
    expect(out).toEqual({
      PATH: "/opt/node/bin:/usr/bin:/bin",
      HOME: "/home/myrabbit-claude",
      CLAUDE_CODE_OAUTH_TOKEN: FAKE.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_AGENT_SDK_CLIENT_APP: "myrabbit/0.1.0",
      MYRABBIT_CLAUDE_BIN: CLAUDE_BIN,
    });
    // What survives `sudo --preserve-env=<allowlist>` is the allowlist minus the credential not
    // used (exactly one of the two is ever set); the bin var does not survive.
    expect(Object.keys(out).filter((k) => k !== CLAUDE_BIN_VAR).sort()).toEqual(
      CLAUDE_AGENT_ENV_ALLOWLIST.filter((k) => k !== "ANTHROPIC_API_KEY").sort(),
    );
    expect(CLAUDE_AGENT_ENV_ALLOWLIST).not.toContain(CLAUDE_BIN_VAR);
  });

  it("never uses the runner's HOME, and honours agentHome", () => {
    const { env, rt } = load();
    const def = claudeEnv(rt.secrets, { clientApp: "x", realBin: CLAUDE_BIN, parent: env });
    expect(def.HOME).not.toBe(env.HOME);
    const custom = claudeEnv(rt.secrets, {
      clientApp: "x",
      realBin: CLAUDE_BIN,
      agentHome: "/home/agent2",
      parent: env,
    });
    expect(custom.HOME).toBe("/home/agent2");
  });

  it.each([
    ["realBin", { realBin: "claude" }],
    ["realBin", { realBin: "" }],
    ["agentHome", { realBin: CLAUDE_BIN, agentHome: "home/agent" }],
  ])("requires an absolute %s", (name, opts) => {
    const { rt } = load();
    expect(() => claudeEnv(rt.secrets, { clientApp: "x", parent: {}, ...opts })).toThrow(
      new InvalidEnvError(`${name} must be an absolute path`),
    );
  });

  it("never includes ANTHROPIC_*, GitHub tokens, the Codex credential or runner variables", () => {
    const { env, rt } = load();
    const out = claudeEnv(rt.secrets, { clientApp: "myrabbit/0.1.0", realBin: CLAUDE_BIN, parent: env });
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(out).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    const serialised = JSON.stringify(out);
    for (const v of [FAKE.MYRABBIT_GITHUB_TOKEN, ACCESS_TOKEN, "fake-workflow-token-value", "fake-actions-runtime-value"]) {
      expect(serialised).not.toContain(v);
    }
    expect(Object.keys(out).filter((k) => /^(ACTIONS_|GITHUB_|RUNNER_|NODE_|OPENAI_)/.test(k))).toEqual([]);
  });

  it("falls back to a safe PATH when the parent has none", () => {
    const { rt } = load();
    const out = claudeEnv(rt.secrets, { clientApp: "x", realBin: CLAUDE_BIN, parent: {} });
    expect(out.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("codexEnv", () => {
  it("is the allowlist plus MYRABBIT_CODEX_BIN, with no credential", () => {
    const { env } = load();
    const out = codexEnv({ codexHome: "/tmp/codex-home-abc", realBin: CODEX_BIN, parent: env });
    expect(out).toEqual({
      PATH: "/opt/node/bin:/usr/bin:/bin",
      HOME: "/home/myrabbit-codex",
      CODEX_HOME: "/tmp/codex-home-abc",
      MYRABBIT_CODEX_BIN: CODEX_BIN,
    });
    expect(Object.keys(out).filter((k) => k !== CODEX_BIN_VAR).sort()).toEqual(
      [...CODEX_AGENT_ENV_ALLOWLIST].sort(),
    );
    expect(CODEX_AGENT_ENV_ALLOWLIST).not.toContain(CODEX_BIN_VAR);
    const serialised = JSON.stringify(out);
    for (const v of secretValues()) expect(serialised).not.toContain(v);
  });

  it("requires an absolute CODEX_HOME and realBin", () => {
    expect(() => codexEnv({ codexHome: " ", realBin: CODEX_BIN, parent: {} })).toThrow(/codexHome/);
    expect(() => codexEnv({ codexHome: "tmp/x", realBin: CODEX_BIN, parent: {} })).toThrow(/codexHome/);
    expect(() => codexEnv({ codexHome: "/tmp/x", realBin: "codex", parent: {} })).toThrow(/realBin/);
  });
});

describe("codexCredentialStatus / codexTokenUsable", () => {
  function withAccessToken(token: string): RuntimeEnv {
    const env = runnerEnv();
    env.CODEX_AUTH_JSON = codexAuthJson(token);
    return loadRuntimeEnv(env);
  }

  it("is usable with plenty of lifetime left", () => {
    const rt = withAccessToken(fakeJwt({ exp: NOW / 1000 + 3600 }));
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: true, expiresAtMs: NOW + 60 * MIN });
    expect(codexTokenUsable(rt.secrets, NOW)).toBe(true);
  });

  it("is not usable within 15 minutes of expiry", () => {
    const rt = withAccessToken(fakeJwt({ exp: (NOW + 14 * MIN) / 1000 }));
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: false, reason: "expiring" });
    expect(codexTokenUsable(rt.secrets, NOW)).toBe(false);
  });

  it("is usable at exactly 15 minutes", () => {
    const rt = withAccessToken(fakeJwt({ exp: (NOW + 15 * MIN) / 1000 }));
    expect(codexTokenUsable(rt.secrets, NOW)).toBe(true);
  });

  it("is not usable once expired", () => {
    const rt = withAccessToken(fakeJwt({ exp: NOW / 1000 - 1 }));
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: false, reason: "expired" });
  });

  it.each([
    ["not JSON", "{nope"],
    ["no tokens", JSON.stringify({ auth_mode: "chatgptAuthTokens" })],
    ["empty access_token", codexAuthJson("")],
    ["access_token not a JWT", codexAuthJson("opaque-value")],
    ["no exp claim", codexAuthJson(fakeJwt({ sub: "x" }))],
    ["exp not a number", codexAuthJson(fakeJwt({ exp: "soon" }))],
  ])("is malformed when %s", (_label, json) => {
    const env = runnerEnv();
    env.CODEX_AUTH_JSON = json;
    const rt = loadRuntimeEnv(env);
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: false, reason: "malformed" });
  });

  it("never puts the token in its result", () => {
    const rt = withAccessToken(ACCESS_TOKEN);
    expect(JSON.stringify(codexCredentialStatus(rt.secrets, NOW))).not.toContain(ACCESS_TOKEN);
  });
});

describe("redact", () => {
  it("replaces every occurrence of every captured secret", () => {
    load();
    const text = `a ${FAKE.MYRABBIT_GITHUB_TOKEN} b ${FAKE.CLAUDE_CODE_OAUTH_TOKEN} c ${ACCESS_TOKEN} d ${FAKE.MYRABBIT_GITHUB_TOKEN}`;
    expect(redact(text)).toBe("a *** b *** c *** d ***");
  });

  it("removes a secret that contains another one whole", () => {
    registerSecret("fake-short-value");
    registerSecret("fake-short-value-but-longer");
    expect(redact("x fake-short-value-but-longer y")).toBe("x *** y");
  });

  it("never registers values shorter than 8 characters", () => {
    const env = runnerEnv();
    env.SOME_FLAG_TOKEN = "1";
    env.DEBUG_SECRET = "true";
    env.SHORT_API_KEY = "  x  ";
    load(env);
    registerSecret("1234567");
    for (const v of ["1", "true", "  x  ", "x", "1234567"]) expect(secretValues()).not.toContain(v);
    const text = "line 12 of file 1, confidence 0.91, x is true; 1234567";
    expect(redact(text)).toBe(text);
    registerSecret("12345678");
    expect(redact("id 12345678")).toBe("id ***");
  });

  it("does not mask a short Codex access token, but still checks it", () => {
    const env = runnerEnv();
    env.CODEX_AUTH_JSON = codexAuthJson("x");
    const { rt } = load(env);
    expect(redact("line 1: x")).toBe("line 1: x");
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: false, reason: "malformed" });
  });

  it("redacts runtime-registered secrets and ignores empty ones", () => {
    registerSecret("");
    registerSecret("   ");
    registerSecret("fake-minted-value");
    expect(secretValues()).toEqual(["fake-minted-value"]);
    expect(redact("token fake-minted-value here")).toBe("token *** here");
    expect(redact("nothing to hide")).toBe("nothing to hide");
  });

  it.each([
    ["ghp_", "ghp_" + "A".repeat(36)],
    ["gho_", "gho_" + "b".repeat(36)],
    ["ghs_", "ghs_" + "c1".repeat(18)],
    ["github_pat_", "github_pat_" + "D".repeat(40)],
    ["sk-ant-", "sk-ant-" + "oat01-" + "e".repeat(30)],
    ["sk-", "sk-" + "F".repeat(40)],
    ["sk-proj-", "sk-proj-" + "G".repeat(40)],
    ["JWT", fakeJwt({ sub: "unregistered", exp: 1 })],
    ["PEM", ["-----BEGIN RSA PRIVATE KEY-----", "MIIfake", "-----END RSA PRIVATE KEY-----"].join("\n")],
  ])("redacts unregistered %s token shapes", (_label, sample) => {
    expect(redact(`before ${sample} after`)).toBe("before *** after");
  });

  it("leaves ordinary text alone", () => {
    const text = "skip the task-list; ghost_value is fine; sk-short; eyJ.not.ajwt; a.b.c";
    expect(redact(text)).toBe(text);
  });
});

describe("engine credentials: exactly one per selected engine", () => {
  const KEYS = { ANTHROPIC_API_KEY: "fake-anthropic-api-value-0003", OPENAI_API_KEY: "fake-openai-api-value-0004" };
  const base = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const env = runnerEnv();
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) Reflect.deleteProperty(env, k);
      else env[k] = v;
    }
    return env;
  };

  it("defaults: both engines, guest-user isolation, the subscription credentials", () => {
    const { rt } = load();
    expect(rt.engines).toEqual(["claude", "codex"]);
    expect(rt.isolation).toBe("guest-users");
    expect(rt.secrets.claudeAuth).toBe("oauth");
    expect(rt.secrets.codexAuth).toBe("auth_json");
  });

  it.each([
    ["oauth + auth.json", {}, "oauth", "auth_json"],
    ["API key + auth.json", { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }, "api_key", "auth_json"],
    ["oauth + API key", { CODEX_AUTH_JSON: undefined, OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, "oauth", "api_key"],
    [
      "API keys only",
      { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, CODEX_AUTH_JSON: "", OPENAI_API_KEY: KEYS.OPENAI_API_KEY },
      "api_key",
      "api_key",
    ],
  ] as const)("accepts %s", (_label, over, claude, codex) => {
    const { env, rt } = load(base(over));
    expect(rt.secrets.claudeAuth).toBe(claude);
    expect(rt.secrets.codexAuth).toBe(codex);
    if (claude === "api_key") expect(rt.secrets.anthropicApiKey).toBe(KEYS.ANTHROPIC_API_KEY);
    if (codex === "api_key") expect(rt.secrets.openaiApiKey).toBe(KEYS.OPENAI_API_KEY);
    // Every credential variable is gone from the env, and the keys are redacted.
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_AUTH_JSON", "OPENAI_API_KEY"]) expect(env).not.toHaveProperty(name);
    if (claude === "api_key") expect(redact(KEYS.ANTHROPIC_API_KEY)).toBe("***");
    if (codex === "api_key") expect(redact(KEYS.OPENAI_API_KEY)).toBe("***");
  });

  it.each([
    ["claude", { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }, "both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; pass exactly one"],
    ["codex", { OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, "both OPENAI_API_KEY and CODEX_AUTH_JSON are set; pass exactly one"],
  ])("fails loudly when both %s credentials are set, naming them, never a value", (_engine, over, message) => {
    const env = base(over);
    const err = errorOf(() => loadRuntimeEnv(env));
    expect(err).toEqual(new InvalidEnvError(message));
    expect(`${err.message}\n${err.stack ?? ""}`).not.toContain("fake-");
    // Still deleted and redacted.
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    for (const v of Object.values(over)) expect(redact(v)).toBe("***");
  });

  it("names both alternatives of a selected engine with no credential", () => {
    const env = base({ CLAUDE_CODE_OAUTH_TOKEN: undefined, CODEX_AUTH_JSON: "" });
    expect(() => loadRuntimeEnv(env)).toThrow(new MissingSecretError(["CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY", "CODEX_AUTH_JSON or OPENAI_API_KEY"]));
  });

  it("MYRABBIT_ENGINES=claude needs no Codex credential and ignores one that is set", () => {
    const { env, rt } = load(base({ MYRABBIT_ENGINES: "claude", CODEX_AUTH_JSON: undefined, OPENAI_API_KEY: KEYS.OPENAI_API_KEY }));
    expect(rt.engines).toEqual(["claude"]);
    expect(rt.secrets.codexAuth).toBeNull();
    expect(rt.secrets.openaiApiKey).toBe("");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(redact(KEYS.OPENAI_API_KEY)).toBe("***");
  });

  it("MYRABBIT_ENGINES=codex needs no Claude credential, but a missing Codex one is an error", () => {
    const { rt } = load(base({ MYRABBIT_ENGINES: "codex", CLAUDE_CODE_OAUTH_TOKEN: undefined }));
    expect(rt.engines).toEqual(["codex"]);
    expect(rt.secrets.claudeAuth).toBeNull();
    resetSecretsForTests();
    expect(() => loadRuntimeEnv(base({ MYRABBIT_ENGINES: "codex", CODEX_AUTH_JSON: undefined }))).toThrow(
      new MissingSecretError(["CODEX_AUTH_JSON or OPENAI_API_KEY"]),
    );
  });

  it("parses MYRABBIT_ISOLATION and rejects anything but the two modes, matched exactly", () => {
    expect(load(base({ MYRABBIT_ISOLATION: "none", MYRABBIT_ENGINES: "claude" })).rt.isolation).toBe("none");
    for (const raw of ["None", "off", "guest_users", "true", " none", "none\n", "guest-users "]) {
      resetSecretsForTests();
      expect(() => loadRuntimeEnv(base({ MYRABBIT_ISOLATION: raw }))).toThrow(
        new InvalidEnvError("invalid MYRABBIT_ISOLATION: expected one of guest-users, none"),
      );
    }
  });

  it("rejects an unknown MYRABBIT_ENGINES, matched exactly", () => {
    for (const raw of ["gemini", " claude", "Claude", "both\n"]) {
      resetSecretsForTests();
      expect(() => loadRuntimeEnv(base({ MYRABBIT_ENGINES: raw }))).toThrow(new InvalidEnvError("invalid MYRABBIT_ENGINES: expected one of both, claude, codex"));
    }
  });

  it("isolation none with both engines is an error that says why, and the secrets are still deleted", () => {
    for (const engines of [undefined, "both"]) {
      resetSecretsForTests();
      const env = base({ MYRABBIT_ISOLATION: "none", MYRABBIT_ENGINES: engines });
      expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError(NONE_NEEDS_ONE_ENGINE));
      expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(env).not.toHaveProperty("CODEX_AUTH_JSON");
    }
    expect(NONE_NEEDS_ONE_ENGINE).toContain("could read each other's credentials");
  });

  it.each(["claude", "codex"] as const)("isolation none with engines %s runs that engine only", (engine) => {
    const { rt } = load(base({ MYRABBIT_ISOLATION: "none", MYRABBIT_ENGINES: engine }));
    expect(rt.isolation).toBe("none");
    expect(rt.engines).toEqual([engine]);
  });

  it("Secrets itself refuses both credentials of one engine", () => {
    expect(() => new Secrets({ githubToken: "x", claudeOauthToken: "a", anthropicApiKey: "b" })).toThrow(InvalidEnvError);
    expect(() => new Secrets({ githubToken: "x", codexAuthJson: "{}", openaiApiKey: "b" })).toThrow(InvalidEnvError);
  });

  it("claudeEnv carries the API key, never the OAuth token, when that is the credential", () => {
    const { env, rt } = load(base({ CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }));
    const out = claudeEnv(rt.secrets, { clientApp: "x", realBin: CLAUDE_BIN, parent: env });
    expect(out.ANTHROPIC_API_KEY).toBe(KEYS.ANTHROPIC_API_KEY);
    expect(out).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(Object.keys(out).filter((k) => k !== CLAUDE_BIN_VAR).every((k) => (CLAUDE_AGENT_ENV_ALLOWLIST as readonly string[]).includes(k))).toBe(true);
  });

  it("an OpenAI API key is always a usable Codex credential (Codex checks it on the first request)", () => {
    const { rt } = load(base({ CODEX_AUTH_JSON: "", OPENAI_API_KEY: KEYS.OPENAI_API_KEY }));
    expect(codexCredentialStatus(rt.secrets, NOW)).toEqual({ usable: true, expiresAtMs: Number.POSITIVE_INFINITY });
  });

  it("without a wrapper (isolation none) the env has no *_BIN variable", () => {
    const { env, rt } = load();
    expect(claudeEnv(rt.secrets, { clientApp: "x", realBin: CLAUDE_BIN, parent: env, wrapper: false })).not.toHaveProperty(CLAUDE_BIN_VAR);
    expect(codexEnv({ realBin: CODEX_BIN, codexHome: "/tmp/h", parent: env, wrapper: false })).not.toHaveProperty("MYRABBIT_CODEX_BIN");
  });
});

describe("the secrets file (action.yml passes the secrets outside the process environment)", () => {
  let root: string;
  beforeEach(() => {
    resetSecretsForTests();
    root = mkdtempSync(join(tmpdir(), "myrabbit-envtest-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetSecretsForTests();
  });

  /** A fresh `myrabbit-secrets.*` dir holding a `secrets` file with these NUL-separated records. */
  const writeFile = (records: string): { dir: string; file: string } => {
    const dir = join(root, "myrabbit-secrets.abc123");
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "secrets");
    writeFileSync(file, records, { mode: 0o600 });
    return { dir, file };
  };
  const record = (name: string, value: string): string => `${name}=${value}\0`;
  /** The env of the node step after `exec env -u …`: no secret variable, only the file path. */
  const stepEnv = (file: string): NodeJS.ProcessEnv => {
    const env = runnerEnv();
    for (const name of ["MYRABBIT_GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_AUTH_JSON", "OPENAI_API_KEY"]) {
      Reflect.deleteProperty(env, name);
    }
    env.MYRABBIT_SECRETS_FILE = file;
    return env;
  };
  const allRecords = (): string =>
    record("MYRABBIT_GITHUB_TOKEN", FAKE.MYRABBIT_GITHUB_TOKEN) +
    record("CLAUDE_CODE_OAUTH_TOKEN", FAKE.CLAUDE_CODE_OAUTH_TOKEN) +
    record("ANTHROPIC_API_KEY", "") +
    record("CODEX_AUTH_JSON", FAKE.CODEX_AUTH_JSON) +
    record("OPENAI_API_KEY", "");

  it("reads every secret from the file, keeps newlines in values, then removes the file and its dir", () => {
    // CODEX_AUTH_JSON pretty-printed: a value with newlines survives the NUL-separated format.
    const pretty = JSON.stringify(JSON.parse(FAKE.CODEX_AUTH_JSON), null, 2);
    expect(pretty).toContain("\n");
    const { dir, file } = writeFile(
      record("MYRABBIT_GITHUB_TOKEN", FAKE.MYRABBIT_GITHUB_TOKEN) +
        record("CLAUDE_CODE_OAUTH_TOKEN", FAKE.CLAUDE_CODE_OAUTH_TOKEN) +
        record("ANTHROPIC_API_KEY", "") +
        record("CODEX_AUTH_JSON", pretty) +
        record("OPENAI_API_KEY", ""),
    );
    const env = stepEnv(file);
    const rt = loadRuntimeEnv(env);
    expect(rt.secrets.githubToken).toBe(FAKE.MYRABBIT_GITHUB_TOKEN);
    expect(rt.secrets.claudeAuth).toBe("oauth");
    expect(rt.secrets.codexAuth).toBe("auth_json");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(env).not.toHaveProperty("MYRABBIT_SECRETS_FILE");
    expect(redact(FAKE.CLAUDE_CODE_OAUTH_TOKEN)).toBe("***");
  });

  it("the file wins over env copies, which are still deleted and redacted", () => {
    const { file } = writeFile(allRecords());
    const env = stepEnv(file);
    env.CLAUDE_CODE_OAUTH_TOKEN = "fake-env-copy-value-0009";
    const rt = loadRuntimeEnv(env);
    expect(rt.secrets.claudeAuth).toBe("oauth");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(redact("fake-env-copy-value-0009")).toBe("***");
    expect(inspect(rt.secrets)).not.toContain("fake-env-copy-value-0009");
  });

  it("a missing file is an error, never a fallback to env, and the env secrets are still deleted", () => {
    const env = runnerEnv();
    env.MYRABBIT_SECRETS_FILE = join(root, "myrabbit-secrets.gone", "secrets");
    expect(() => loadRuntimeEnv(env)).toThrow(new InvalidEnvError("MYRABBIT_SECRETS_FILE could not be read"));
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("MYRABBIT_GITHUB_TOKEN");
    expect(redact(FAKE.CLAUDE_CODE_OAUTH_TOKEN)).toBe("***");
  });

  it("a symlink is refused and removed, and its target is left alone", () => {
    const target = join(root, "target");
    writeFileSync(target, allRecords());
    const dir = join(root, "myrabbit-secrets.link");
    mkdirSync(dir);
    const file = join(dir, "secrets");
    symlinkSync(target, file);
    expect(() => loadRuntimeEnv(stepEnv(file))).toThrow(new InvalidEnvError("MYRABBIT_SECRETS_FILE could not be read"));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it.each([
    ["an unknown name", record("GITHUB_TOKEN", "fake-unknown-value-0010")],
    ["a record with no =", "MYRABBIT_GITHUB_TOKEN\0"],
  ])("%s is an error, and the file is removed all the same, its values never in the message", (_label, extra) => {
    const { dir, file } = writeFile(allRecords() + extra);
    const err = errorOf(() => loadRuntimeEnv(stepEnv(file)));
    expect(err).toEqual(new InvalidEnvError("MYRABBIT_SECRETS_FILE has an unexpected record"));
    expect(`${err.message}\n${err.stack ?? ""}`).not.toContain("fake-");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("only removes the parent dir when it is a myrabbit-secrets dir, and only when empty", () => {
    const other = join(root, "other");
    mkdirSync(other);
    const file = join(other, "secrets");
    writeFileSync(file, allRecords());
    loadRuntimeEnv(stepEnv(file));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(other)).toBe(true);

    resetSecretsForTests();
    const { dir, file: second } = writeFile(allRecords());
    writeFileSync(join(dir, "keep"), "x");
    loadRuntimeEnv(stepEnv(second));
    expect(existsSync(second)).toBe(false);
    expect(existsSync(join(dir, "keep"))).toBe(true);
  });
});

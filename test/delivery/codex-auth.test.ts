import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAuthError, deriveAccessTokenAuth, fakeShape, jwtClaims, refreshLogin } from "../../scripts/codex-auth.mjs";

const run = promisify(execFile);
const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 3_600_000;

/** An unsigned, obviously fake JWT. */
function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.fakesig`;
}

const ACCESS = fakeJwt({
  exp: (NOW + 10 * 24 * HOUR) / 1000,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-claim" },
});
const REFRESH = "fake-refresh-token-must-never-leave";

function loginJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt({ email: "x@example.invalid" }), access_token: ACCESS, refresh_token: REFRESH, account_id: "acct-1", ...overrides },
    last_refresh: "2026-11-01T00:00:00Z",
  });
}

describe("deriveAccessTokenAuth", () => {
  it("builds Codex's external-token auth.json with an empty refresh token", () => {
    const { json, expiresAtMs } = deriveAccessTokenAuth(loginJson(), { nowMs: NOW });
    expect(json).toEqual({
      auth_mode: "chatgptAuthTokens",
      OPENAI_API_KEY: null,
      tokens: { id_token: ACCESS, access_token: ACCESS, refresh_token: "", account_id: "acct-1" },
      last_refresh: new Date(NOW).toISOString(),
    });
    expect(expiresAtMs).toBe(NOW + 10 * 24 * HOUR);
    expect(JSON.stringify(json)).not.toContain(REFRESH);
  });

  it("falls back to the account id in the token claims", () => {
    const { json } = deriveAccessTokenAuth(loginJson({ account_id: null }), { nowMs: NOW });
    expect(json.tokens.account_id).toBe("acct-from-claim");
  });

  it.each([
    ["not json", "{", /not valid JSON/],
    ["no tokens (API-key login)", JSON.stringify({ OPENAI_API_KEY: "sk-fake" }), /no tokens object/],
    ["empty access token", loginJson({ access_token: "" }), /access_token is missing/],
    ["access token not a JWT", loginJson({ access_token: "opaque" }), /not a JWT/],
    ["no exp", loginJson({ access_token: fakeJwt({}) }), /no numeric exp/],
    ["no account id", loginJson({ access_token: fakeJwt({ exp: NOW / 1000 + 86400 }), account_id: "" }), /no account id/],
  ])("rejects %s without echoing secrets", (_name, input, message) => {
    let error: unknown;
    try {
      deriveAccessTokenAuth(input, { nowMs: NOW });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CodexAuthError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain("sk-fake");
    expect((error as Error).message).not.toContain(REFRESH);
  });

  it("refuses a token below the minimum lifetime (refresh failed)", () => {
    const soon = fakeJwt({ exp: (NOW + 30 * 60_000) / 1000 });
    expect(() => deriveAccessTokenAuth(loginJson({ access_token: soon }), { nowMs: NOW })).toThrow(/expires in 30 min/);
    expect(() => deriveAccessTokenAuth(loginJson({ access_token: soon }), { nowMs: NOW, minLifetimeMs: 0 })).not.toThrow();
  });

  it("fakeShape keeps the shape and drops every credential", () => {
    const { json } = deriveAccessTokenAuth(loginJson(), { nowMs: NOW });
    const shape = fakeShape(json);
    expect(Object.keys(shape.tokens)).toEqual(Object.keys(json.tokens));
    expect(shape.auth_mode).toBe("chatgptAuthTokens");
    expect(shape.tokens.refresh_token).toBe("");
    expect(JSON.stringify(shape)).not.toContain(ACCESS);
    expect(JSON.stringify(shape)).not.toContain("acct-1");
    expect(json.tokens.access_token).toBe(ACCESS); // the input is not mutated
  });

  it("jwtClaims ignores non-JWTs", () => {
    expect(jwtClaims("a.b")).toBeNull();
    expect(jwtClaims("a.!!!.c")).toBeNull();
    expect(jwtClaims(ACCESS)?.exp).toBe((NOW + 10 * 24 * HOUR) / 1000);
  });
});

describe("refreshLogin and the refresher script", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "myrabbit-codex-auth-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake `codex` that speaks the app-server handshake and records what it received. */
  async function fakeCodex(behaviour: "ok" | "apikey" | "exit"): Promise<string> {
    const bin = join(dir, "codex");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(m) + "\\n");
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME, hasToken: "MYRABBIT_GITHUB_TOKEN" in process.env });
if (${JSON.stringify(behaviour)} === "exit") process.exit(3);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); log(msg);
    if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
    if (msg.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: ${JSON.stringify(behaviour === "ok" ? "chatgpt" : "apiKey")} } } }) + "\\n");
  }
});
`,
    );
    await chmod(bin, 0o755);
    return bin;
  }

  async function calls(): Promise<Record<string, unknown>[]> {
    const text = await readFile(join(dir, "calls.jsonl"), "utf8");
    return text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("runs initialize -> initialized -> account/read { refreshToken: true } with a minimal env", async () => {
    const codexBin = await fakeCodex("ok");
    await refreshLogin({ codexBin, codexHome: "/fake/codex-home", timeoutMs: 10_000 });
    const [start, init, initialized, read] = await calls();
    expect(start).toEqual({ argv: ["app-server", "-c", 'cli_auth_credentials_store="file"'], codexHome: "/fake/codex-home", hasToken: false });
    expect(init).toMatchObject({ method: "initialize", id: 1, params: { clientInfo: { name: "myrabbit-codex-auth-refresh" } } });
    expect(initialized).toEqual({ method: "initialized" });
    expect(read).toEqual({ method: "account/read", id: 2, params: { refreshToken: true } });
  });

  it("fails when the login is not a ChatGPT login", async () => {
    const codexBin = await fakeCodex("apikey");
    await expect(refreshLogin({ codexBin, codexHome: dir, timeoutMs: 10_000 })).rejects.toThrow(/not a ChatGPT login/);
  });

  it("fails when the server exits early", async () => {
    const codexBin = await fakeCodex("exit");
    await expect(refreshLogin({ codexBin, codexHome: dir, timeoutMs: 10_000 })).rejects.toThrow(/exited early/);
  });

  it("--dry-run prints only the fake shape and the target repositories", async () => {
    const home = join(dir, "codex-home");
    await run("mkdir", ["-p", home]);
    const fresh = fakeJwt({ exp: Date.now() / 1000 + 86400, "https://api.openai.com/auth": { chatgpt_account_id: "acct-x" } });
    await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: fresh, access_token: fresh, refresh_token: REFRESH, account_id: "acct-x" } }));
    await writeFile(join(dir, "repos.txt"), "# enabled repos\nowner/repo-a\n\n");
    const { stdout, stderr } = await run("bash", ["scripts/codex-auth-refresh.sh", "--dry-run"], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, MYRABBIT_CODEX_HOME: home, MYRABBIT_REPOS_FILE: join(dir, "repos.txt"), GH_BIN: "/bin/false", CODEX_BIN: "/bin/false" },
    });
    const shape = JSON.parse(stdout) as { auth_mode: string; tokens: Record<string, string> };
    expect(shape.auth_mode).toBe("chatgptAuthTokens");
    expect(shape.tokens.refresh_token).toBe("");
    expect(stderr).toContain("would run: gh secret set CODEX_AUTH_JSON --repo owner/repo-a");
    for (const out of [stdout, stderr]) {
      expect(out).not.toContain(fresh);
      expect(out).not.toContain(REFRESH);
      expect(out).not.toContain("acct-x");
    }
  });

  it("full run: refreshes, pipes the derived JSON to gh over stdin, breaks a stale lock", async () => {
    const codexBin = await fakeCodex("ok");
    const home = join(dir, "codex-home");
    await run("mkdir", ["-p", home]);
    const fresh = fakeJwt({ exp: Date.now() / 1000 + 86400, "https://api.openai.com/auth": { chatgpt_account_id: "acct-x" } });
    await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: fresh, access_token: fresh, refresh_token: REFRESH, account_id: "acct-x" } }));
    await writeFile(join(dir, "repos.txt"), "owner/repo-a\ndlled/other # comment\n");
    // A fake gh that records its argv (one line) and the stdin it got (one file per call).
    const gh = join(dir, "gh");
    await writeFile(gh, `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh-argv"\ncat > "${dir}/gh-stdin-$(wc -l < "${dir}/gh-argv" | tr -d ' ')"\n`);
    await chmod(gh, 0o755);
    // Stale lock from a killed run: a PID that is not alive.
    const lock = join(dir, "lock");
    await run("mkdir", ["-p", lock]);
    await writeFile(join(lock, "pid"), "999999");

    const { stdout, stderr } = await run("bash", ["scripts/codex-auth-refresh.sh"], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, MYRABBIT_CODEX_HOME: home, MYRABBIT_REPOS_FILE: join(dir, "repos.txt"), MYRABBIT_LOCK_DIR: lock, GH_BIN: gh, CODEX_BIN: codexBin },
    });
    expect(stderr).toContain("breaking stale lock (pid 999999)");
    expect(stderr).toContain("updated CODEX_AUTH_JSON on owner/repo-a");
    expect(stderr).toContain("updated CODEX_AUTH_JSON on dlled/other");
    expect((await readFile(join(dir, "gh-argv"), "utf8")).trim().split("\n")).toEqual([
      "secret set CODEX_AUTH_JSON --repo owner/repo-a",
      "secret set CODEX_AUTH_JSON --repo dlled/other",
    ]);
    for (const n of [1, 2]) {
      const sent = JSON.parse(await readFile(join(dir, `gh-stdin-${n}`), "utf8")) as { auth_mode: string; tokens: Record<string, string> };
      expect(sent.auth_mode).toBe("chatgptAuthTokens");
      expect(sent.tokens).toMatchObject({ access_token: fresh, refresh_token: "", account_id: "acct-x" });
    }
    expect((await calls()).find((c) => "method" in c && c.method === "account/read")).toBeDefined();
    for (const out of [stdout, stderr]) {
      expect(out).not.toContain(fresh);
      expect(out).not.toContain(REFRESH);
    }
    await expect(run("test", ["-e", lock])).rejects.toBeDefined(); // released on exit
  });

  it("does not break a live lock", async () => {
    const home = join(dir, "codex-home");
    await run("mkdir", ["-p", home]);
    await writeFile(join(home, "auth.json"), "{}");
    await writeFile(join(dir, "repos.txt"), "owner/repo-a\n");
    const lock = join(dir, "lock");
    await run("mkdir", ["-p", lock]);
    await writeFile(join(lock, "pid"), String(process.pid));
    await expect(
      run("bash", ["scripts/codex-auth-refresh.sh"], {
        env: { PATH: process.env.PATH ?? "", HOME: dir, MYRABBIT_CODEX_HOME: home, MYRABBIT_REPOS_FILE: join(dir, "repos.txt"), MYRABBIT_LOCK_DIR: lock, CODEX_BIN: "/bin/false", GH_BIN: "/bin/false" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(`another refresh is running (pid ${process.pid}`) as unknown });
  });

  it("refuses the everyday ~/.codex login", async () => {
    await run("mkdir", ["-p", join(dir, ".codex")]);
    await writeFile(join(dir, ".codex", "auth.json"), "{}");
    await writeFile(join(dir, "repos.txt"), "owner/repo-a\n");
    await expect(
      run("bash", ["scripts/codex-auth-refresh.sh", "--dry-run"], {
        env: { PATH: process.env.PATH ?? "", HOME: dir, MYRABBIT_CODEX_HOME: join(dir, ".codex"), MYRABBIT_REPOS_FILE: join(dir, "repos.txt") },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("refusing to use the everyday login") as unknown });
  });
});

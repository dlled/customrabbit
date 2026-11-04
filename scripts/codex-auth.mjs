#!/usr/bin/env node
// Codex credential helper for scripts/codex-auth-refresh.sh (design.md §9.1). Runs on the operator's Mac,
// never in a job and never on the WTR host. It never prints a token: errors name fields, not values.
//
//   node scripts/codex-auth.mjs refresh            force a refresh of the dedicated login in $CODEX_HOME
//   node scripts/codex-auth.mjs derive <auth.json> print the access-token-only auth.json (for a pipe only)
//   node scripts/codex-auth.mjs shape  <auth.json> print the same JSON with fake values (dry run)
//
// The derived file is Codex's external-token form (codex-rs login/src/auth/manager.rs
// `from_external_access_token`): auth_mode "chatgptAuthTokens", the access token (also stored as
// id_token, as Codex itself does), the account id and an EMPTY refresh_token, so a VM can use the
// token but never rotate it.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

/** Remaining lifetime the published token must have; below it the refresh is treated as failed. */
export const MIN_PUBLISH_LIFETIME_MS = 60 * 60 * 1000;

const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const FAKE_JWT = "eyFAKE.eyFAKE.FAKE";

export class CodexAuthError extends Error {
  /** @param {string} message never contains a credential */
  constructor(message) {
    super(message);
    this.name = "CodexAuthError";
  }
}

/**
 * Decodes a JWT payload without verifying it. Returns null when it is not a JWT.
 * @param {string} jwt
 * @returns {Record<string, unknown> | null}
 */
export function jwtClaims(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts[1] === "") return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Builds the access-token-only auth.json from the dedicated login's auth.json text.
 * @param {string} authJsonText contents of $CODEX_HOME/auth.json (ChatGPT login)
 * @param {{ nowMs?: number, minLifetimeMs?: number }} [options]
 * @returns {{ json: object, expiresAtMs: number }}
 */
export function deriveAccessTokenAuth(authJsonText, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const minLifetimeMs = options.minLifetimeMs ?? MIN_PUBLISH_LIFETIME_MS;

  let parsed;
  try {
    parsed = JSON.parse(authJsonText);
  } catch {
    throw new CodexAuthError("auth.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new CodexAuthError("auth.json is not an object");
  const tokens = parsed.tokens;
  if (typeof tokens !== "object" || tokens === null) {
    throw new CodexAuthError("auth.json has no tokens object (is this a ChatGPT login? API-key logins are not supported)");
  }
  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw new CodexAuthError("tokens.access_token is missing");
  const claims = jwtClaims(accessToken);
  if (claims === null) throw new CodexAuthError("tokens.access_token is not a JWT");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new CodexAuthError("tokens.access_token has no numeric exp claim");
  }
  const expiresAtMs = claims.exp * 1000;
  if (expiresAtMs - nowMs < minLifetimeMs) {
    throw new CodexAuthError(
      `access token expires in ${Math.round((expiresAtMs - nowMs) / 60000)} min, below the ${Math.round(minLifetimeMs / 60000)} min minimum: refresh failed or the login is stale`,
    );
  }

  const authClaim = claims[ACCOUNT_CLAIM];
  const claimAccount =
    typeof authClaim === "object" && authClaim !== null && typeof authClaim.chatgpt_account_id === "string"
      ? authClaim.chatgpt_account_id
      : undefined;
  const accountId = typeof tokens.account_id === "string" && tokens.account_id !== "" ? tokens.account_id : claimAccount;
  if (accountId === undefined || accountId === "") throw new CodexAuthError("no account id in tokens.account_id or the token claims");

  return {
    expiresAtMs,
    json: {
      auth_mode: "chatgptAuthTokens",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: accessToken,
        access_token: accessToken,
        refresh_token: "",
        account_id: accountId,
      },
      last_refresh: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * The derived JSON with every credential replaced by a fake value: same shape, nothing secret.
 * @param {{ tokens: { account_id: string } }} derived
 */
export function fakeShape(derived) {
  const copy = JSON.parse(JSON.stringify(derived));
  copy.tokens.id_token = FAKE_JWT;
  copy.tokens.access_token = FAKE_JWT;
  copy.tokens.account_id = "00000000-0000-0000-0000-000000000000";
  return copy;
}

/**
 * Forces a token refresh of the login in codexHome through `codex app-server` (JSON-RPC over
 * stdio: initialize -> initialized -> account/read { refreshToken: true }). The server rewrites
 * $CODEX_HOME/auth.json itself. Its stdout and stderr are never echoed.
 * @param {{ codexBin?: string, codexHome: string, timeoutMs?: number }} options
 * @returns {Promise<void>}
 */
export function refreshLogin({ codexBin = "codex", codexHome, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const finish = (/** @type {Error | null} */ err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new CodexAuthError(`codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (/** @type {object} */ msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    child.on("error", (err) => finish(new CodexAuthError(`cannot start ${codexBin}: ${err.code ?? err.message}`)));
    child.on("exit", (code) => finish(new CodexAuthError(`codex app-server exited early (code ${code})`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish(new CodexAuthError(`initialize failed (code ${msg.error.code})`));
          send({ method: "initialized" });
          send({ method: "account/read", id: 2, params: { refreshToken: true } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new CodexAuthError(`account/read failed (code ${msg.error.code})`));
          if (msg.result?.account?.type !== "chatgpt") {
            return finish(new CodexAuthError("the login in CODEX_HOME is not a ChatGPT login"));
          }
          return finish(null);
        }
      }
    });
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "myrabbit-codex-auth-refresh", title: null, version: "0.1.0" }, capabilities: null },
    });
  });
}

async function main(argv) {
  const [command, file] = argv;
  if (command === "refresh") {
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) throw new CodexAuthError("CODEX_HOME must be set to the dedicated login");
    await refreshLogin({ codexBin: process.env.CODEX_BIN ?? "codex", codexHome });
    const { expiresAtMs } = deriveAccessTokenAuth(await readFile(join(codexHome, "auth.json"), "utf8"));
    process.stderr.write(`codex login refreshed; access token valid for ${((expiresAtMs - Date.now()) / 3_600_000).toFixed(1)} h\n`);
    return;
  }
  if ((command === "derive" || command === "shape") && file) {
    const { json } = deriveAccessTokenAuth(await readFile(file, "utf8"));
    if (command === "derive" && process.stdout.isTTY) {
      throw new CodexAuthError("refusing to print a credential to a terminal; pipe it (e.g. into gh secret set)");
    }
    process.stdout.write(JSON.stringify(command === "derive" ? json : fakeShape(json), null, command === "shape" ? 2 : 0));
    if (command === "shape") process.stdout.write("\n");
    return;
  }
  throw new CodexAuthError("usage: codex-auth.mjs refresh | derive <auth.json> | shape <auth.json>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    // Only CodexAuthError messages are known to be credential-free.
    process.stderr.write(`codex-auth: ${err instanceof CodexAuthError ? err.message : "unexpected error"}\n`);
    process.exit(1);
  });
}

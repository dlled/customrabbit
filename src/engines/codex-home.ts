// CODEX_HOME preparation (design.md §9, §9.1, §9.2).
//
// A fresh mkdtemp directory, so Codex loads no user config, rules, AGENTS.md or sessions. The
// credential becomes $CODEX_HOME/auth.json in one of two ways, by the runner user:
// - CODEX_AUTH_JSON: written as is (mode 0600);
// - OPENAI_API_KEY: Codex's own API-key login, `codex login --with-api-key`, with the key on stdin
//   (never argv) through the `apiKeyLogin` hook. The login is told to store the credential in the
//   file (`cli_auth_credentials_store="file"`), never a keyring, and the runs say the same
//   (CODEX_API_KEY_CONFIG), so the key lives only in this directory.
// With guest-user isolation the orchestrator then hands the directory to myrabbit-codex
// (`sudo chown -R`) through the `chownToAgent` hook.

import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Secrets } from "../env.js";
import { CODEX_AGENT_USER } from "./users.js";

export const AUTH_FILE = "auth.json";

/** Config overrides for the API-key login and every run that uses it: the credential is a file. */
export const CODEX_API_KEY_CONFIG = Object.freeze({ cli_auth_credentials_store: "file" });

export interface CodexHome {
  dir: string;
  /** Removes the directory and the credential in it. Safe to call twice. */
  cleanup: () => Promise<void>;
}

export interface PrepareCodexHomeOptions {
  /** Parent of the temp directory; default os.tmpdir(). Never $RUNNER_TEMP (§9.2). */
  parentDir?: string;
  /**
   * Hands the directory to `user` (always CODEX_AGENT_USER), e.g. `sudo -n chown -R <user> <dir>`.
   * The orchestrator should also pass an explicit parentDir that the Codex user can traverse.
   * Absent with isolation "none": the runner user keeps the directory.
   */
  chownToAgent?: (dir: string, user: string) => Promise<void>;
  /**
   * Required for an OPENAI_API_KEY credential: runs `codex login --with-api-key` with
   * CODEX_HOME=`dir` and `apiKey` on stdin. Must write `dir`/auth.json.
   */
  apiKeyLogin?: (dir: string, apiKey: string) => Promise<void>;
}

export async function prepareCodexHome(secrets: Secrets, options: PrepareCodexHomeOptions = {}): Promise<CodexHome> {
  const auth = secrets.codexAuth;
  if (auth === null) throw new Error("codex has no credential");
  if (auth === "api_key" && options.apiKeyLogin === undefined) throw new Error("an OPENAI_API_KEY credential needs the apiKeyLogin hook");
  const dir = await mkdtemp(join(options.parentDir ?? tmpdir(), "myrabbit-codex-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const file = join(dir, AUTH_FILE);
    if (auth === "api_key" && options.apiKeyLogin !== undefined) {
      await options.apiKeyLogin(dir, secrets.openaiApiKey);
      // The login must have stored the key in this directory, as a regular file.
      const st = await lstat(file).catch(() => null);
      if (st === null || !st.isFile()) throw new Error("codex login --with-api-key did not write auth.json");
    } else {
      // "wx": never follow or overwrite an existing file; chmod afterwards in case of a umask.
      await writeFile(file, secrets.codexAuthJson, { mode: 0o600, flag: "wx" });
    }
    await chmod(file, 0o600);
    if (options.chownToAgent !== undefined) await options.chownToAgent(dir, CODEX_AGENT_USER);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, cleanup };
}

// Engine setup for a run (design §9, §9.1, §9.2).
//
// - Each enabled engine runs as its own guest user through bin/as-agent-{claude,codex}; the guest
//   users are created by action.yml. Before any model call the orchestrator checks that
//   `sudo -n -u <user>` works for every enabled engine and fails closed (exit 1) if it does not.
// - Isolation "none" (an explicit opt-in, never a fallback): no guest users, no sudo. The SDKs run
//   the real CLIs as the runner user, each with a fresh 0700 HOME, and a ::warning:: says so.
// - Credentials: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in Claude's env; CODEX_AUTH_JSON
//   written to auth.json, or OPENAI_API_KEY stored there by `codex login --with-api-key`.
// - Codex is skipped (an engine failure, §2.2) when its access token is expired, expiring within 15
//   minutes or malformed (§9.1 step 4); no CODEX_HOME is created then.
// - CODEX_HOME is a fresh mkdtemp under /tmp (traversable by myrabbit-codex, never $RUNNER_TEMP)
//   holding auth.json (0600), handed to myrabbit-codex with `sudo -n chown -R`, and removed with
//   `sudo -n rm -rf` after the run.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { claudeEnv, codexCredentialStatus, codexEnv, type Isolation, type Secrets } from "../env.js";
import {
  CLAUDE_AGENT_USER,
  CODEX_AGENT_USER,
  CODEX_API_KEY_CONFIG,
  claudeDenyRules,
  createClaudeEngine,
  createCodexEngine,
  prepareCodexHome,
  runnerRootFromTemp,
} from "../engines/index.js";
import type { EngineRunSummary } from "../render/index.js";
import type { Config, Engine, EngineName } from "../types.js";
import { resolveClaudeBinary, resolveCodexBinary } from "./binaries.js";
import { errorText, type Log } from "./log.js";

/** CLAUDE_AGENT_SDK_CLIENT_APP (identifies myrabbit to the Agent SDK). */
export const CLIENT_APP = "myrabbit/0.1.0";

export interface EngineSetupInput {
  config: Config;
  secrets: Secrets;
  workspace: string;
  runnerTemp: string | null;
  now: number;
  log: Log;
  /** MYRABBIT_ISOLATION: "none" runs the CLIs as the runner user, without the guest users. */
  isolation: Isolation;
}

export interface EngineSetup {
  /** Engines ready to call, in canonical order (claude, codex). */
  engines: Engine[];
  /** Engines that will not run: disabled in config, or skipped before starting (credential). */
  notRunning: EngineRunSummary[];
  /** Claude path-rule gaps for the job summary (§9: §9.2 is the only control there). */
  denyNotes: string[];
  cleanup: () => Promise<void>;
}

export type SetupEngines = (input: EngineSetupInput) => Promise<EngineSetup>;

export class EngineSetupError extends Error {
  override readonly name = "EngineSetupError";
}

const execFileAsync = promisify(execFile);
/** sudo never sees the job env: no secrets, no runner credentials. */
const SUDO_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };

async function sudo(args: readonly string[]): Promise<void> {
  await execFileAsync("sudo", ["-n", ...args], { env: SUDO_ENV, timeout: 30_000, maxBuffer: 64 * 1024 });
}

/** Fails unless the runner user can run commands as `user` without a password (§9.2). */
export async function checkGuestUser(user: string): Promise<void> {
  try {
    await sudo(["-u", user, "--", "true"]);
  } catch {
    throw new EngineSetupError(`cannot run commands as ${user} (sudo -n -u ${user} failed); the guest users must be created by the action`);
  }
}

export interface RealSetupOptions {
  /** $GITHUB_ACTION_PATH: holds bin/ and node_modules/. */
  actionRoot: string;
  /** Default checkGuestUser. */
  checkUser?: (user: string) => Promise<void>;
  /** Test hook; default codexApiKeyLogin with the resolved Codex binary. */
  codexApiKeyLogin?: (dir: string, apiKey: string) => Promise<void>;
}

/** Runs `codex login --with-api-key` as the runner user, the key on stdin, never argv or a log. */
export function codexApiKeyLogin(realBin: string, options: { PATH: string; timeoutMs?: number }) {
  return (dir: string, apiKey: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const config = Object.entries(CODEX_API_KEY_CONFIG).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);
      const child = spawn(realBin, [...config, "login", "--with-api-key"], {
        // HOME is the fresh dir too: the login reads and writes nothing of the runner's.
        env: { PATH: options.PATH, HOME: dir, CODEX_HOME: dir },
        stdio: ["pipe", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 60_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new EngineSetupError(`codex login --with-api-key could not start (${err.message})`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new EngineSetupError(`codex login --with-api-key failed (${signal ?? `exit ${String(code)}`})`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${apiKey}\n`);
    });
}

/** A fresh 0700 HOME for an engine run as the runner user (isolation "none"), never the runner's HOME. */
async function freshHome(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The `::warning::` printed for isolation "none" (design.md §9.2 is then not in force). */
export const ISOLATION_NONE_WARNING =
  "::warning::myrabbit: isolation is none: the engine CLI runs as the runner user and can read everything it can (the checkout, $RUNNER_TEMP, the runner's files) and its own model credential; prompt injection in PR or issue content could leak that credential in the posted review";

/** The real engines: SDK adapters behind the guest-user wrappers, or the CLIs themselves with isolation "none". */
export function realEngineSetup(options: RealSetupOptions): SetupEngines {
  const checkUser = options.checkUser ?? checkGuestUser;
  return async (input) => {
    const { config, secrets, workspace, runnerTemp, log } = input;
    const isolated = input.isolation === "guest-users";
    const engines: Engine[] = [];
    const notRunning: EngineRunSummary[] = [];
    const denyNotes: string[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const cleanup = async (): Promise<void> => {
      for (const c of cleanups.reverse()) {
        try {
          await c();
        } catch (err) {
          log(`cleanup failed: ${errorText(err)}`);
        }
      }
    };
    const disabled = (engine: EngineName): void => {
      notRunning.push({ engine, status: "disabled" });
    };
    if (!isolated && (config.engines.claude.enabled || config.engines.codex.enabled)) log(ISOLATION_NONE_WARNING);

    try {
      if (config.engines.claude.enabled) {
        if (isolated) await checkUser(CLAUDE_AGENT_USER);
        const runnerDir = runnerTemp === null ? null : runnerRootFromTemp(runnerTemp);
        const deniedDirs = runnerTemp === null ? [] : [runnerTemp];
        const deny = claudeDenyRules(workspace, { extraDirs: deniedDirs, ...(runnerDir !== null ? { runnerDir } : {}) });
        if (deny.skipped.length > 0) denyNotes.push(`claude path rules: walked instead of denied whole (contain the checkout): ${deny.skipped.join(", ")}`);
        if (deny.unlisted.length > 0) {
          denyNotes.push(
            isolated
              ? `claude path rules: not covered, guest-user isolation (§9.2) is the only control: ${deny.unlisted.join(", ")}`
              : `claude path rules: not covered, and isolation is none: ${deny.unlisted.join(", ")}`,
          );
        }
        const realBin = resolveClaudeBinary({ from: options.actionRoot });
        let agentHome: string | undefined;
        if (!isolated) {
          const home = await freshHome("myrabbit-claude-home-");
          cleanups.push(home.cleanup);
          agentHome = home.dir;
        }
        engines.push(
          createClaudeEngine({
            config: config.engines.claude,
            env: claudeEnv(secrets, { realBin, clientApp: CLIENT_APP, wrapper: isolated, ...(agentHome === undefined ? {} : { agentHome }) }),
            executable: isolated ? join(options.actionRoot, "bin", "as-agent-claude") : realBin,
            ...(runnerDir !== null ? { runnerDir } : {}),
            deniedDirs,
          }),
        );
      } else {
        disabled("claude");
      }

      if (config.engines.codex.enabled) {
        const cred = codexCredentialStatus(secrets, input.now);
        if (!cred.usable) {
          const why = cred.reason === "malformed" ? "credential malformed" : `credential ${cred.reason}`;
          log(`codex skipped: ${why}`);
          notRunning.push({ engine: "codex", status: "failed", error: `skipped: ${why}`, errorKind: "credential", durationMs: 0 });
        } else {
          if (isolated) await checkUser(CODEX_AGENT_USER);
          const { bin: realBin, pathDirs } = resolveCodexBinary({ from: options.actionRoot });
          const PATH = [...pathDirs, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
          const login = options.codexApiKeyLogin ?? codexApiKeyLogin(realBin, { PATH });
          const home = await prepareCodexHome(secrets, {
            // /tmp: traversable by myrabbit-codex, never $RUNNER_TEMP (§9.2).
            parentDir: isolated ? "/tmp" : tmpdir(),
            apiKeyLogin: login,
            ...(isolated
              ? {
                  chownToAgent: async (dir: string, user: string) => {
                    await sudo(["chown", "-R", "--", user, dir]);
                  },
                }
              : {}),
          });
          cleanups.push(
            isolated
              ? async () => {
                  try {
                    await sudo(["rm", "-rf", "--", home.dir]);
                  } catch {
                    await home.cleanup();
                  }
                }
              : home.cleanup,
          );
          let agentHome: string | undefined;
          if (!isolated) {
            const h = await freshHome("myrabbit-codex-home-");
            cleanups.push(h.cleanup);
            agentHome = h.dir;
          }
          engines.push(
            createCodexEngine({
              config: config.engines.codex,
              secrets,
              env: codexEnv({ realBin, codexHome: home.dir, parent: { PATH }, wrapper: isolated, ...(agentHome === undefined ? {} : { agentHome }) }),
              executable: isolated ? join(options.actionRoot, "bin", "as-agent-codex") : realBin,
            }),
          );
        }
      } else {
        disabled("codex");
      }
    } catch (err) {
      await cleanup();
      throw err;
    }
    return { engines, notRunning, denyNotes, cleanup };
  };
}

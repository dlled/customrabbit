// Runs one tool as myrabbit-tools through bin/as-tools (design-v2 §7.3), with the §7.1 60 s
// timeout. The child gets only PATH: as-tools then replaces the whole env with PATH, HOME and LANG
// for the tool. The cwd is the install's empty `cwd/` dir, outside the checkout.
//
// No tool process may outlive its run, and no run may hang: as-tools kills every myrabbit-tools
// process when the tool exits; on timeout or abort this module asks it to (`--kill-all`, the tool
// runs as another user, so only sudo can signal it), then kills the wrapper itself. The promise
// settles on the wrapper's exit plus a bounded drain, never on 'close' alone, so a pipe inherited
// by a stray process cannot keep it pending.

import { spawn } from "node:child_process";

import { SYSTEM_PATH } from "./install.js";
import type { ToolCommand } from "./commands.js";

/** A tool that prints more than this is treated as failed (no unbounded buffering). */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** After a stop: how long the kill gets before the wrapper is SIGKILLed and the run settles. */
export const KILL_GRACE_MS = 2000;
/** After the wrapper exits: how long its pipes may still drain. */
export const DRAIN_MS = 1000;

export interface ExecResult {
  /** null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output over {@link MAX_OUTPUT_BYTES}, spawn failure, or abort. */
  failed: boolean;
}

export interface ExecOptions {
  /** Absolute path of bin/as-tools. */
  asTools: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ToolExec = (cmd: ToolCommand, options: ExecOptions) => Promise<ExecResult>;

export const execTool: ToolExec = (cmd, options) =>
  new Promise((resolve) => {
    const child = spawn(options.asTools, [cmd.file, ...cmd.args], {
      cwd: options.cwd,
      env: { PATH: SYSTEM_PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let failed = false;
    let stopped = false;
    let settled = false;
    let exitCode: number | null = null;
    const timers: NodeJS.Timeout[] = [];

    const finish = (): void => {
      if (settled) return;
      settled = true;
      timers.forEach((t) => {
        clearTimeout(t);
      });
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8").slice(0, 4000),
        timedOut,
        failed,
      });
    };

    const killAll = (): void => {
      const k = spawn(options.asTools, ["--kill-all"], { cwd: options.cwd, env: { PATH: SYSTEM_PATH }, stdio: "ignore" });
      k.on("error", () => undefined);
    };

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      killAll();
      timers.push(
        setTimeout(() => {
          child.kill("SIGKILL");
          finish();
        }, KILL_GRACE_MS),
      );
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs),
    );
    const onAbort = (): void => {
      failed = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        failed = true;
        stop();
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", () => {
      failed = true;
      finish();
    });
    child.on("exit", (code) => {
      exitCode = code;
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    child.on("close", finish);
  });

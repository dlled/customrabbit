// design-v2 §7.1/§7.3: a tool run always settles, within its timeout plus the kill grace, even
// when the tool leaves a process behind that holds its stdout (review of #46). Real processes,
// with a stand-in for bin/as-tools that runs the tool as the current user.

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRAIN_MS, execTool, KILL_GRACE_MS } from "../../src/tools/exec.js";

let dir: string;
let asTools: string;
let killLog: string;
// The timing tests must not race the machine's load: a stray process holds the pipes for HOLD_S,
// far longer than any path that settles correctly (drain, timeout + grace, abort + grace, each a
// few seconds), so SETTLE_BOUND_MS sits well between the two. A slow spawn under load (seen:
// +1.3 s) stays far inside it, while waiting for 'close' (≈ HOLD_S) is always caught.
const HOLD_S = 30;
const SETTLE_BOUND_MS = 12_000;
const TEST_TIMEOUT_MS = 20_000;
/** Decimal digits only: `sleep 30.<tag>` is a valid duration and unique to this test file run. */
const HOLD_TAG = String(process.pid) + String(Date.now() % 100_000);

/** A sleep with a per-file unique duration, so afterAll can kill exactly these strays. */
const hold = (): string => `sleep ${String(HOLD_S)}.${HOLD_TAG}`;

afterAll(() => {
  // The stand-in as-tools kills nothing, so the stray sleeps outlive their runs; reap exactly ours
  // (with KILL: the timeout test's sleeps ignore TERM).
  spawnSync("pkill", ["-KILL", "-f", `sleep ${String(HOLD_S)}.${HOLD_TAG}`], { stdio: "ignore" });
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "p6-exec-"));
  asTools = join(dir, "as-tools");
  killLog = join(dir, "kills");
  // Records --kill-all calls but kills nothing: the worst case for the promise.
  await writeFile(asTools, `#!/bin/sh\nif [ "$1" = --kill-all ]; then echo kill >> "${killLog}"; exit 0; fi\n"$@"\n`);
  await chmod(asTools, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tool(body: string): Promise<string> {
  const p = join(dir, `tool-${Math.random().toString(36).slice(2)}`);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

const run = async (file: string, timeoutMs: number, signal?: AbortSignal) => {
  const t0 = Date.now();
  const r = await execTool({ file, args: [] }, { asTools, cwd: dir, timeoutMs, signal });
  return { ...r, ms: Date.now() - t0 };
};

describe("execTool", () => {
  it("returns a normal tool's output and exit code", async () => {
    const r = await run(await tool("echo '[]'; exit 3"), 5000);
    expect(r).toMatchObject({ code: 3, stdout: "[]\n", timedOut: false, failed: false });
  });

  it("settles after the drain when the tool exits but a background child holds stdout", { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await run(await tool(`${hold()} &\necho out`), 60_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("out\n");
    expect(r.timedOut).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(DRAIN_MS - 50);
    expect(r.ms).toBeLessThan(SETTLE_BOUND_MS);
  });

  it("times out within timeout + grace even when everything ignores signals, and asks as-tools to kill", { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await run(await tool(`trap '' TERM\n${hold()} &\n${hold()}`), 300);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(300 + KILL_GRACE_MS - 50);
    expect(r.ms).toBeLessThan(SETTLE_BOUND_MS);
    expect(await readFile(killLog, "utf8")).toBe("kill\n");
  });

  it("an abort stops the run as failed", { timeout: TEST_TIMEOUT_MS }, async () => {
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 100);
    const r = await run(await tool(hold()), 60_000, ac.signal);
    expect(r.failed).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.ms).toBeLessThan(SETTLE_BOUND_MS);
  });
});

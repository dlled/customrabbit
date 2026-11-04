// bin/as-runner-tools (isolation "none"): the tool runs as the runner user with an empty env, and no
// process it starts outlives its run or a --kill-all.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WRAPPER = resolve("bin/as-runner-tools");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myrabbit-runner-tools-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

describe("bin/as-runner-tools", () => {
  it("runs the tool with only PATH, HOME (fresh, removed after) and LANG, and passes its exit code", () => {
    const tool = script("tool", `env > "${dir}/env"\necho "$HOME" > "${dir}/home"\necho out\nexit 4`);
    const r = spawnSync(WRAPPER, [tool, "a"], { cwd: dir, env: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "fake-secret-value-0001" }, encoding: "utf8" });
    expect(r.status).toBe(4);
    expect(r.stdout).toBe("out\n");
    const env = readFileSync(join(dir, "env"), "utf8");
    const names = env
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=")[0])
      .filter((n) => n !== "PWD" && n !== "SHLVL" && n !== "_" && n !== "OLDPWD");
    expect(names.sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(env).not.toContain("fake-secret");
    const home = readFileSync(join(dir, "home"), "utf8").trim();
    expect(home).toMatch(/myrabbit-tool-home\./);
    expect(spawnSync("test", ["-e", home]).status).not.toBe(0);
  });

  it("kills what the tool left running in its group when it exits", async () => {
    const tool = script("tool", `sleep 30 &\necho $! > "${dir}/bg"\nexit 0`);
    const r = spawnSync(WRAPPER, [tool], { cwd: dir, env: { PATH: "/usr/bin:/bin" } });
    expect(r.status).toBe(0);
    const bg = Number(readFileSync(join(dir, "bg"), "utf8").trim());
    await until(() => !alive(bg));
  });

  it("--kill-all stops a running tool and its children", async () => {
    const tool = script("tool", `sleep 30 &\necho $! > "${dir}/bg"\necho $$ > "${dir}/main"\nwait`);
    const child = spawn(WRAPPER, [tool], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
    await until(() => {
      try {
        return readFileSync(join(dir, "bg"), "utf8").trim() !== "" && readFileSync(join(dir, "main"), "utf8").trim() !== "";
      } catch {
        return false;
      }
    });
    const bg = Number(readFileSync(join(dir, "bg"), "utf8").trim());
    const main = Number(readFileSync(join(dir, "main"), "utf8").trim());
    expect(spawnSync(WRAPPER, ["--kill-all"], { cwd: dir, env: { PATH: "/usr/bin:/bin" } }).status).toBe(0);
    await until(() => !alive(bg) && !alive(main));
    await new Promise((r) => child.on("exit", r));
  });

  it("refuses a relative or missing tool", () => {
    expect(spawnSync(WRAPPER, ["tool"], { cwd: dir, env: { PATH: "/usr/bin:/bin" } }).status).toBe(127);
    expect(spawnSync(WRAPPER, [join(dir, "nope")], { cwd: dir, env: { PATH: "/usr/bin:/bin" } }).status).toBe(127);
  });
});

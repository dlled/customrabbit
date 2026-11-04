// bin/as-agent-{claude,codex} with a fake REAL_BIN and a fake sudo first on PATH.

import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_AGENT_ENV_ALLOWLIST,
  CLAUDE_BIN_VAR,
  CODEX_AGENT_ENV_ALLOWLIST,
  CODEX_BIN_VAR,
  claudeEnv,
  codexEnv,
} from "../../src/env.js";
import { CLAUDE_AGENT_HOME, CLAUDE_AGENT_USER, CODEX_AGENT_HOME, CODEX_AGENT_USER } from "../../src/engines/users.js";
import { fakeSecrets } from "./helpers.js";

const BIN = fileURLToPath(new URL("../../bin/", import.meta.url));

let dir: string;
let realBin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "myrabbit-wrapper-"));
  // Fake sudo: records its argv (one per line) and the env it received, then exits 0.
  const sudo = join(dir, "sudo");
  writeFileSync(
    sudo,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$WRAPPER_TEST_OUT.args"\nenv > "$WRAPPER_TEST_OUT.env"\n',
  );
  chmodSync(sudo, 0o755);
  realBin = join(dir, "real-cli");
  writeFileSync(realBin, "#!/bin/sh\nexit 0\n");
  chmodSync(realBin, 0o755);
  writeFileSync(join(dir, "not-executable"), "x");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(script: string, env: Record<string, string>, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(join(BIN, script), args, { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } }, (err, _stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stderr });
    });
  });
}

const CASES = [
  { script: "as-agent-claude", binVar: CLAUDE_BIN_VAR, user: CLAUDE_AGENT_USER, allowlist: CLAUDE_AGENT_ENV_ALLOWLIST, secret: { CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-token-0000" } },
  { script: "as-agent-codex", binVar: CODEX_BIN_VAR, user: CODEX_AGENT_USER, allowlist: CODEX_AGENT_ENV_ALLOWLIST, secret: { CODEX_HOME: "/tmp/fake-codex-home" } },
] as const;

describe.each(CASES)("$script", ({ script, binVar, user, allowlist, secret }) => {
  it("execs sudo -n -u <its own engine user> with exactly the src/env.ts allowlist", async () => {
    const out = join(dir, `${script}-ok`);
    const r = await run(script, { [binVar]: realBin, WRAPPER_TEST_OUT: out, HOME: `/home/${user}`, ...secret }, ["--print", "a b", "--flag=$HOME"]);
    expect(r.code).toBe(0);
    const argv = readFileSync(`${out}.args`, "utf8").split("\n").slice(0, -1);
    expect(argv).toEqual(["-n", "-u", user, `--preserve-env=${allowlist.join(",")}`, "--", realBin, "--print", "a b", "--flag=$HOME"]);
    // The real-binary variable is not passed on, and never in the allowlist.
    const env = readFileSync(`${out}.env`, "utf8");
    expect(env).not.toContain(`${binVar}=`);
    expect(allowlist as readonly string[]).not.toContain(binVar);
    expect(CLAUDE_AGENT_USER).not.toBe(CODEX_AGENT_USER);
  });

  it.each([
    ["unset", undefined],
    ["relative", "real-cli"],
    ["missing", "/nonexistent/real-cli"],
    ["not executable", "NOT_EXECUTABLE"],
    ["a directory", "/"],
  ])("refuses a REAL_BIN that is %s, without calling sudo", async (_label, value) => {
    const out = join(dir, `${script}-bad-${_label.replace(/\s/g, "-")}`);
    const env: Record<string, string> = { WRAPPER_TEST_OUT: out };
    if (value !== undefined) env[binVar] = value === "NOT_EXECUTABLE" ? join(dir, "not-executable") : value;
    const r = await run(script, env, ["x"]);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain(binVar);
    expect(existsSync(`${out}.args`)).toBe(false);
  });
});

describe("as-agent-codex --output-schema", () => {
  // A fake sudo that records argv, the copied schema (content and `ls -ld` modes), its stdin, and
  // then exits with $FAKE_EXIT, or waits for TERM/INT when $FAKE_HANG is set.
  let sdir: string;
  let schema: string;
  // /tmp/myrabbit-codex-schema.* is shared with every other run on the machine (another job's
  // suite, a real review). This run's copies carry a unique marker, so a test proves a dir is its
  // own before asserting on it or deleting it, and never touches another run's live dirs.
  const MARKER = `myrabbit-wrapper-test-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const SCHEMA = `{"$comment":"${MARKER}","type":"object","properties":{"ok":{"type":"boolean"}}}\n`;
  /** This run's schema dirs: those holding a copy that carries MARKER. Others' dirs may vanish mid-read. */
  const ownSchemaDirs = () =>
    readdirSync("/tmp")
      .filter((n) => n.startsWith("myrabbit-codex-schema."))
      .filter((n) => {
        try {
          return readdirSync(join("/tmp", n)).some((f) => readFileSync(join("/tmp", n, f), "utf8").includes(MARKER));
        } catch {
          return false;
        }
      })
      .sort();

  beforeAll(() => {
    sdir = mkdtempSync(join(tmpdir(), "myrabbit-wrapper-schema-"));
    writeFileSync(
      join(sdir, "sudo"),
      [
        "#!/bin/sh",
        'echo $$ > "$WRAPPER_TEST_OUT.pid"',
        'printf "%s\\n" "$@" > "$WRAPPER_TEST_OUT.args"',
        'prev=""; path=""',
        'for a in "$@"; do',
        '  case "$a" in --output-schema=*) path="${a#--output-schema=}" ;; esac',
        '  if [ "$prev" = --output-schema ]; then path="$a"; fi',
        '  prev="$a"',
        "done",
        'if [ -n "$path" ]; then cat "$path" > "$WRAPPER_TEST_OUT.schema"; ls -ld "$(dirname "$path")" "$path" > "$WRAPPER_TEST_OUT.modes"; fi',
        'cat > "$WRAPPER_TEST_OUT.stdin"',
        'if [ -n "${FAKE_HANG:-}" ]; then',
        '  trap \'echo TERM > "$WRAPPER_TEST_OUT.sig"; exit 143\' TERM',
        '  trap \'echo INT > "$WRAPPER_TEST_OUT.sig"; exit 130\' INT',
        '  : > "$WRAPPER_TEST_OUT.ready"',
        "  while :; do sleep 0.05; done",
        "fi",
        'exit "${FAKE_EXIT:-0}"',
        "",
      ].join("\n"),
    );
    chmodSync(join(sdir, "sudo"), 0o755);
    schema = join(sdir, "private", "schema.json");
    execFileSync("mkdir", ["-m", "0700", join(sdir, "private")]);
    writeFileSync(schema, SCHEMA);
  });

  afterAll(() => {
    rmSync(sdir, { recursive: true, force: true });
  });

  interface Ran {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    out: string;
  }

  function start(label: string, args: string[], env: Record<string, string> = {}, stdin = "") {
    const out = join(sdir, label);
    const child = spawn(join(BIN, "as-agent-codex"), args, {
      env: { PATH: `${sdir}:/usr/bin:/bin`, [CODEX_BIN_VAR]: realBin, WRAPPER_TEST_OUT: out, CODEX_HOME: "/tmp/fake-codex-home", ...env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.stdin.end(stdin);
    const done = new Promise<Ran>((resolve) => {
      child.on("close", (code, signal) => {
        resolve({ code, signal, stderr, out });
      });
    });
    return { child, done, out };
  }

  const argv = (out: string) => readFileSync(`${out}.args`, "utf8").split("\n").slice(0, -1);
  const copied = (out: string) => {
    const a = argv(out);
    const i = a.findIndex((x) => x === "--output-schema" || x.startsWith("--output-schema="));
    const v = a[i] === "--output-schema" ? a[i + 1] : a[i]?.slice("--output-schema=".length);
    return v ?? "";
  };

  it.each([
    ["separate", (p: string) => ["exec", "--experimental-json", "--output-schema", p, "--skip-git-repo-check"]],
    ["=", (p: string) => ["exec", `--output-schema=${p}`, "--experimental-json"]],
  ])("copies the schema to a readable /tmp dir for the %s form, rewrites only that arg, and removes it", async (form, mk) => {
    const { done } = start(`form-${form === "=" ? "eq" : "sep"}`, mk(schema), {}, "the prompt on stdin");
    const r = await done;
    expect(r.code).toBe(0);
    const path = copied(r.out);
    expect(path).toMatch(/^\/tmp\/myrabbit-codex-schema\.[A-Za-z0-9]+\/schema-1\.json$/);
    expect(path).not.toBe(schema);
    // The other arguments are passed unchanged, in order.
    const a = argv(r.out);
    expect(a.slice(0, 5)).toEqual(["-n", "-u", CODEX_AGENT_USER, `--preserve-env=${CODEX_AGENT_ENV_ALLOWLIST.join(",")}`, "--"]);
    expect(a.filter((x) => x !== path && !x.startsWith("--output-schema="))).toEqual(
      ["-n", "-u", CODEX_AGENT_USER, `--preserve-env=${CODEX_AGENT_ENV_ALLOWLIST.join(",")}`, "--", realBin, ...mk(schema).filter((x) => x !== schema && !x.startsWith("--output-schema="))],
    );
    expect(readFileSync(`${r.out}.schema`, "utf8")).toBe(SCHEMA);
    const modes = readFileSync(`${r.out}.modes`, "utf8").split("\n").map((l) => l.split(/\s+/)[0]);
    expect(modes[0]).toMatch(/^drwxr-xr-x/);
    expect(modes[1]).toMatch(/^-rw-r--r--/);
    // stdin (the SDK's prompt) reaches the CLI although it runs as a background child.
    expect(readFileSync(`${r.out}.stdin`, "utf8")).toBe("the prompt on stdin");
    // Cleaned up after the CLI exited; the SDK's own file is untouched.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(readFileSync(schema, "utf8")).toBe(SCHEMA);
  });

  it("passes the CLI's exit code through and still cleans up", async () => {
    const r = await start("exit7", ["exec", "--output-schema", schema], { FAKE_EXIT: "7" }).done;
    expect(r.code).toBe(7);
    expect(existsSync(dirname(copied(r.out)))).toBe(false);
  });

  it.each([
    ["SIGTERM", "TERM", 143],
    ["SIGINT", "INT", 130],
  ] as const)("forwards %s to the CLI (the SDK's abort), passes its status and cleans up", async (sig, name, code) => {
    const { child, done, out } = start(`sig-${name}`, ["exec", "--output-schema", schema], { FAKE_HANG: "1" });
    try {
      for (let i = 0; i < 200 && !existsSync(`${out}.ready`); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(`${out}.ready`)).toBe(true);
      child.kill(sig);
      const r = await done;
      expect(readFileSync(`${out}.sig`, "utf8")).toBe(`${name}\n`);
      expect(r.code).toBe(code);
      expect(existsSync(dirname(copied(out)))).toBe(false);
    } finally {
      // Never leave a hanging fake CLI behind if an assertion fails.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (existsSync(`${out}.args`)) {
        const d = dirname(copied(out));
        if (d.startsWith("/tmp/myrabbit-codex-schema.")) rmSync(d, { recursive: true, force: true });
      }
    }
  });

  // Only marker-bearing dirs are provably this run's, so only they are asserted on and deleted. A
  // dir leaked before the copy (empty, no marker) is not visible here; a late cleanup still is,
  // since it also leaks dirs after the copy.
  it("a TERM at any point of the start (before, during or after the copy and launch) leaves no CLI and no schema dir", async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The fake CLI's pid, or 0 (not started, or killed between the file's truncate and write).
    const pidOf = (out: string) => (existsSync(`${out}.pid`) ? Number(readFileSync(`${out}.pid`, "utf8").trim()) : 0);
    // Earlier tests in this file removed their own dirs; any leftover would be a leak too.
    expect(ownSchemaDirs()).toEqual([]);
    const outs: string[] = [];
    try {
      // Every ms from 0 to 40, twice: the wrapper's start (bash, traps, copy, launch) falls in it.
      const delays = [...Array(41).keys(), ...Array(41).keys()];
      for (const [n, delay] of delays.entries()) {
        const { child, done, out } = start(`early-${String(n)}`, ["exec", "--output-schema", schema], { FAKE_HANG: "1" });
        outs.push(out);
        await new Promise((r) => setTimeout(r, delay));
        child.kill("SIGTERM");
        // A wrapper still waiting on an unsignalled CLI would never close: fail instead of hanging.
        const r = await Promise.race([done, new Promise<null>((r) => setTimeout(() => { r(null); }, 3000))]);
        if (r === null) {
          child.kill("SIGKILL");
          expect.fail(`delay ${String(delay)}: the wrapper did not exit after TERM`);
        }
        // Killed before the traps (bash's default) or ended by the wrapper with 128+15.
        expect(r.code === 143 || r.signal === "SIGTERM", `delay ${String(delay)}: ${String(r.code)}/${String(r.signal)}`).toBe(true);
      }
      // A CLI left unsignalled keeps running (and may record its pid late): give it time to show.
      await new Promise((r) => setTimeout(r, 300));
      expect(outs.map(pidOf).filter((p) => p > 0 && alive(p)), "fake CLIs still running").toEqual([]);
      expect(ownSchemaDirs(), "schema dirs left by this run").toEqual([]);
    } finally {
      for (const out of outs) {
        const pid = pidOf(out);
        if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      }
      for (const d of ownSchemaDirs()) rmSync(join("/tmp", d), { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    ["missing", () => join(sdir, "nope.json")],
    ["a symlink", () => {
      const l = join(sdir, "link.json");
      if (!existsSync(l)) symlinkSync(schema, l);
      return l;
    }],
    ["a directory", () => sdir],
  ])("refuses an --output-schema that is %s, without calling sudo", async (label, path) => {
    const r = await start(`bad-${label.replace(/\s/g, "-")}`, ["exec", "--output-schema", path()]).done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--output-schema");
    expect(existsSync(`${r.out}.args`)).toBe(false);
  });

  it("refuses a trailing --output-schema with no file", async () => {
    const r = await start("trailing", ["exec", "--output-schema"]).done;
    expect(r.code).toBe(2);
    expect(existsSync(`${r.out}.args`)).toBe(false);
  });

  it("leaves arguments after -- alone and, with no schema, still execs sudo directly", async () => {
    const r = await start("after-dashdash", ["exec", "--", "--output-schema", "not-a-file"], {}, "in").done;
    expect(r.code).toBe(0);
    // Unchanged (no copy, so not rewritten to a /tmp path).
    expect(argv(r.out).slice(-3)).toEqual(["--", "--output-schema", "not-a-file"]);
    expect(readFileSync(`${r.out}.stdin`, "utf8")).toBe("in");
  });
});

describe("engine users", () => {
  it("are distinct, and each engine env defaults to its own user's home", () => {
    expect(CLAUDE_AGENT_USER).toBe("myrabbit-claude");
    expect(CODEX_AGENT_USER).toBe("myrabbit-codex");
    expect(CLAUDE_AGENT_HOME).toBe(`/home/${CLAUDE_AGENT_USER}`);
    expect(CODEX_AGENT_HOME).toBe(`/home/${CODEX_AGENT_USER}`);
    expect(claudeEnv(fakeSecrets(), { clientApp: "x", realBin: "/bin/true", parent: {} }).HOME).toBe(CLAUDE_AGENT_HOME);
    expect(codexEnv({ codexHome: "/tmp/c", realBin: "/bin/true", parent: {} }).HOME).toBe(CODEX_AGENT_HOME);
  });
});

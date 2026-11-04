// Contract test for action.yml (design.md §10, §9.2): the composite steps, the guest users and the
// wrappers, inputs mapped to env only on the node step, and the secrets passed to node in a 0600
// file, never in its environment. Split out of workflows.test.ts unchanged, so the public export
// (scripts/public/) can override the workflow tests and keep these.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { TOOLS_USER } from "../../src/engines/users.js";

type Step = { id?: string; name?: string; "working-directory"?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };

const load = (path: string): unknown => parse(readFileSync(path, "utf8"));
const text = (path: string): string => readFileSync(path, "utf8");

const action = load("action.yml") as { runs: { using: string; steps: Step[] }; inputs: Record<string, { required?: boolean; default?: string }> };

describe("action.yml (composite)", () => {
  const steps = action.runs.steps;
  const node = steps.at(-1);

  it("is composite: npm ci (always, no cache) -> guest users -> tools user -> node dist/main.js", () => {
    expect(action.runs.using).toBe("composite");
    expect(steps).toHaveLength(4);
    // No dependency cache: a cache entry in the target repo's scope could be poisoned (review of #16).
    expect(text("action.yml")).not.toMatch(/actions\/cache|cache-hit/);
    const [install, users] = steps;
    expect(install?.run).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(install?.if).toBeUndefined();
    // Both guest-user steps are skipped only for exactly isolation "none"; any other value runs them
    // (and the node step then rejects an unknown value before any model call).
    expect(users?.if).toBe("inputs.isolation != 'none'");
    expect(steps[2]?.if).toBe("inputs.isolation != 'none'");
    expect(install?.["working-directory"]).toBe("${{ github.action_path }}");
    expect(users?.run).toMatch(/users=\(myrabbit-claude myrabbit-codex\)/);
    expect(node?.run).toMatch(/exec env (-u [A-Z_]+ )+\\\n\s+"MYRABBIT_SECRETS_FILE=\$secrets_dir\/secrets" node "\$GITHUB_ACTION_PATH\/dist\/main\.js"\n$/);
  });

  it("passes the secrets in a 0600 file under $RUNNER_TEMP, never in node's environment", () => {
    const run = node?.run ?? "";
    expect(run).not.toContain("${{");
    expect(run.split("\n").slice(0, 2)).toEqual(["set -euo pipefail", "umask 077"]);
    expect(run).toContain('secrets_dir="$(mktemp -d "$RUNNER_TEMP/myrabbit-secrets.XXXXXX")"');
    // printf is a builtin, so no value is ever on a command line; NUL-separated records keep the
    // newlines of CODEX_AUTH_JSON.
    expect(run).toContain(`printf '%s=%s\\0' "$name" "\${!name:-}"`);
    const SECRET_VARS = ["MYRABBIT_GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_AUTH_JSON", "OPENAI_API_KEY"];
    expect(run).toContain(`for name in ${SECRET_VARS.join(" ")}; do`);
    for (const name of SECRET_VARS) expect(run).toContain(`-u ${name} `);
    // Every credential input the step env maps is written and unset.
    const CREDENTIAL_INPUTS = ["github-token", "claude-oauth-token", "anthropic-api-key", "codex-auth-json", "openai-api-key"];
    const mapped = Object.entries(node?.env ?? {}).filter(([, v]) => CREDENTIAL_INPUTS.some((i) => v === `\${{ inputs.${i} }}`));
    expect(mapped.map(([k]) => k).sort()).toEqual([...SECRET_VARS].sort());
  });

  it("denies the static-analysis user every runner path and verifies it as that user (design-v2 §7.3)", () => {
    const tools = steps[2];
    const run = tools?.run ?? "";
    expect(tools?.name).toBe("Create static-analysis guest user");
    expect(run).toContain(`u=${TOOLS_USER}`);
    expect(run).toContain('sudo -n useradd --system --create-home --shell /usr/sbin/nologin "$u"');
    expect(run).toContain('sudo -n setfacl -m "u:${u}:---" -- "${deny[@]}"');
    expect(run).toMatch(/sudo -n -u "\$u" -- bash -c '[\s\S]*can reach \$p[\s\S]*' check "\$\{deny\[@\]\}"/);
  });

  it("bin/as-tools runs a tool only as the tools user, with an empty environment", () => {
    const wrapper = text("bin/as-tools");
    expect(wrapper).toContain(`user=${TOOLS_USER}\n`);
    expect(wrapper).toContain('sudo -n -u "$user" -- /usr/bin/env -i PATH=/usr/bin:/bin "HOME=$home" LANG=C.UTF-8 "$tool" "$@" || code=$?');
    // Nothing the tool left behind outlives it (review of #46).
    expect(wrapper).toMatch(/\|\| code=\$\?\nkill_all\nexit "\$code"/);
    // Repeated until nothing is left, so a child forked mid-walk does not survive (P6b).
    expect(wrapper).toContain("for _ in {1..1000}; do kill -KILL -1 2>/dev/null || exit 0; done");
    expect(wrapper).not.toMatch(/-E\b|--preserve-env/);
  });

  it("denies the guest users every runner-private path and verifies it as each user", () => {
    const run = steps[1]?.run ?? "";
    expect(run).toContain('setfacl -m "u:${u}:---" -- "${deny[@]}"');
    expect(run).toContain('setfacl -d -m "u:${u}:---" -- "${private_dirs[@]}"');
    expect(run).toMatch(/for f in \.runner \.credentials \.credentials_rsaparams \.env \.path; do/);
    expect(run).toContain('deny+=("$runner_temp")');
    expect(run).toMatch(/sudo -n -u "\$u" -- bash -c '[\s\S]*can read \$p[\s\S]*' check "\$\{deny\[@\]\}"/);
  });

  it("maps inputs to env only on the node step", () => {
    expect(node?.env).toEqual({
      MYRABBIT_GITHUB_TOKEN: "${{ inputs.github-token }}",
      MYRABBIT_BOT_LOGIN: "${{ inputs.bot-login }}",
      CLAUDE_CODE_OAUTH_TOKEN: "${{ inputs.claude-oauth-token }}",
      ANTHROPIC_API_KEY: "${{ inputs.anthropic-api-key }}",
      CODEX_AUTH_JSON: "${{ inputs.codex-auth-json }}",
      OPENAI_API_KEY: "${{ inputs.openai-api-key }}",
      MYRABBIT_ENGINES: "${{ inputs.engines }}",
      MYRABBIT_ISOLATION: "${{ inputs.isolation }}",
      MYRABBIT_PR: "${{ inputs.pr }}",
      MYRABBIT_TRUSTED_AUTHORS: "${{ inputs.trusted-authors }}",
    });
    // Before the node step, only an `if:` may read an input, and only the non-secret isolation.
    for (const s of steps.slice(0, -1)) {
      const { if: cond, ...rest } = s;
      expect(JSON.stringify(rest), s.name).not.toContain("inputs.");
      if (cond !== undefined) expect(cond, s.name).toBe("inputs.isolation != 'none'");
    }
  });

  it("requires the App inputs and trusted-authors, defaults the credentials to empty (exactly one per engine) and pr", () => {
    for (const k of ["github-token", "bot-login", "trusted-authors"]) expect(action.inputs[k]?.required, k).toBe(true);
    for (const k of ["claude-oauth-token", "anthropic-api-key", "codex-auth-json", "openai-api-key"]) {
      expect(action.inputs[k], k).toMatchObject({ required: false, default: "" });
    }
    expect(action.inputs.engines).toMatchObject({ required: false, default: "both" });
    expect(action.inputs.isolation).toMatchObject({ required: false, default: "guest-users" });
    expect(action.inputs.pr).toMatchObject({ required: false, default: "0" });
    // No default: a public action never trusts anyone the caller did not name.
    expect(action.inputs["trusted-authors"]).not.toHaveProperty("default");
  });

  it("uses the guest users of src/engines/users.ts and the wrappers", () => {
    const users = text("src/engines/users.ts");
    for (const u of ["myrabbit-claude", "myrabbit-codex"]) expect(users).toContain(`"${u}"`);
    expect(text("bin/as-agent-claude")).toContain("-u myrabbit-claude");
    expect(text("bin/as-agent-codex")).toContain("-u myrabbit-codex");
  });
});

describe("action.yml node step, run for real with a stand-in main.js", () => {
  const SECRETS: Record<string, string> = {
    MYRABBIT_GITHUB_TOKEN: "fake-step-github-value-0101",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-step-claude-value-0102",
    ANTHROPIC_API_KEY: "",
    // A value with newlines, quotes and an = sign, as a pretty-printed auth.json would have.
    CODEX_AUTH_JSON: '{\n  "tokens": {"access_token": "fake-step-codex-value-0103=="}\n}\n',
    OPENAI_API_KEY: "",
  };
  // The stand-in records what main would see: its env, the file (mode, records), and what a child
  // of main (an engine CLI under isolation none) can read from /proc/<ppid>/environ on Linux.
  const MAIN = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const file = process.env.MYRABBIT_SECRETS_FILE;
const st = fs.statSync(file);
const dir = require("node:path").dirname(file);
const out = {
  env: process.env,
  fileMode: st.mode & 0o777,
  dirMode: fs.statSync(dir).mode & 0o777,
  dirName: require("node:path").basename(dir),
  records: fs.readFileSync(file, "utf8").split("\\0").filter((r) => r !== ""),
  childSawEnviron: null,
};
fs.rmSync(file);
fs.rmdirSync(dir);
if (process.platform === "linux") {
  const child = spawnSync("sh", ["-c", "cat /proc/$PPID/environ"], { encoding: "utf8" });
  out.childSawEnviron = child.stdout;
}
process.stdout.write(JSON.stringify(out));
`;

  const runStep = (): {
    env: Record<string, string>;
    fileMode: number;
    dirMode: number;
    dirName: string;
    records: string[];
    childSawEnviron: string | null;
    runnerTempLeft: string[];
  } => {
    const root = mkdtempSync(join(tmpdir(), "myrabbit-step-"));
    try {
      const actionPath = join(root, "action");
      const runnerTemp = join(root, "temp");
      mkdirSync(join(actionPath, "dist"), { recursive: true });
      mkdirSync(runnerTemp);
      writeFileSync(join(actionPath, "dist", "main.js"), MAIN);
      const step = action.runs.steps.at(-1);
      const res = spawnSync("bash", ["-c", step?.run ?? "exit 99"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, RUNNER_TEMP: runnerTemp, GITHUB_ACTION_PATH: actionPath, MYRABBIT_ENGINES: "claude", ...SECRETS },
      });
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      return { ...(JSON.parse(res.stdout) as ReturnType<typeof runStep>), runnerTempLeft: readdirSync(runnerTemp) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const values = Object.values(SECRETS).filter((v) => v !== "");

  it("node starts with no secret in its environment, only the file path", () => {
    const r = runStep();
    for (const name of Object.keys(SECRETS)) expect(r.env).not.toHaveProperty(name);
    const all = JSON.stringify(r.env);
    for (const v of values) expect(all).not.toContain(v.trim());
    expect(r.env.MYRABBIT_ENGINES).toBe("claude");
    expect(r.env.MYRABBIT_SECRETS_FILE).toMatch(/\/myrabbit-secrets\.[A-Za-z0-9]{6}\/secrets$/);
    expect(r.runnerTempLeft).toEqual([]);
  });

  it("the file is 0600 in a 0700 myrabbit-secrets dir and holds every value exactly, newlines included", () => {
    const r = runStep();
    expect(r.fileMode).toBe(0o600);
    expect(r.dirMode).toBe(0o700);
    expect(r.dirName).toMatch(/^myrabbit-secrets\./);
    expect(r.records).toEqual(Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`));
  });

  it.runIf(process.platform === "linux")("a child of main finds no secret value in /proc/<ppid>/environ", () => {
    const r = runStep();
    expect(r.childSawEnviron).toContain("MYRABBIT_SECRETS_FILE=");
    for (const v of values) expect(r.childSawEnviron).not.toContain(v.trim());
    for (const name of Object.keys(SECRETS)) expect(r.childSawEnviron).not.toContain(`${name}=`);
  });
});

// Contract test for the public delivery files: the reusable review.yml (runs-on and trusted-authors
// REQUIRED, no defaults), the example callers, and CI. No pull_request_target/workflow_run, forks
// and bots skipped by every caller, every action pinned by full SHA, no expressions interpolated
// into `run:`, exactly one credential per selected engine, and isolation none with one engine only.
// action.yml is covered by action.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { "runs-on"?: unknown; permissions?: Record<string, string>; "timeout-minutes"?: number; if?: string; uses?: string; steps?: Step[]; with?: Record<string, unknown>; secrets?: Record<string, string> };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: unknown; jobs: Record<string, Job> };
type CallInputs = Record<string, { type: string; required?: boolean; default?: unknown }>;

const load = (path: string): unknown => parse(readFileSync(path, "utf8"));
const text = (path: string): string => readFileSync(path, "utf8");
/** The file without YAML comments (headers may name the forbidden triggers on purpose). */
const code = (path: string): string => text(path).replace(/(^|\s)#.*$/gm, "");

const SLUG = "dlled/customrabbit";
const review = load(".github/workflows/review.yml") as Workflow;
const ci = load(".github/workflows/ci.yml") as Workflow;
const action = load("action.yml") as { runs: { steps: Step[] } };
const EXAMPLES = ["examples/caller.yml", "examples/self-hosted.yml", "examples/wtr.yml"] as const;
const examples = Object.fromEntries(EXAMPLES.map((p) => [p, load(p) as Workflow])) as Record<(typeof EXAMPLES)[number], Workflow>;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;

function wtrLabels(jobKey: string): string[] {
  return ["self-hosted", "wtr-ci", `wtr-\${{ github.run_id }}-\${{ github.run_attempt }}-${jobKey}`];
}

function allSteps(): Step[] {
  return [...Object.values(review.jobs), ...Object.values(ci.jobs)].flatMap((j) => j.steps ?? []).concat(action.runs.steps);
}

const CREDENTIALS = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_AUTH_JSON", "OPENAI_API_KEY"],
} as const;

describe("every delivery file", () => {
  it.each([".github/workflows/review.yml", ".github/workflows/ci.yml", "action.yml", ...EXAMPLES])("%s has no unsupported trigger", (path) => {
    expect(code(path)).not.toMatch(/pull_request_target|workflow_run|issue_comment/);
  });

  it("review.yml, ci.yml and action.yml name no runner: the caller chooses it", () => {
    for (const path of [".github/workflows/review.yml", ".github/workflows/ci.yml", "action.yml"]) {
      expect(code(path), path).not.toMatch(/ubuntu-latest|ubuntu-\d|windows-|macos-/);
    }
  });

  it("pins every action by full SHA, and every example pins review.yml of this repository", () => {
    const uses = allSteps().flatMap((s) => (s.uses === undefined ? [] : [s.uses]));
    expect(uses.length).toBeGreaterThan(5);
    for (const u of uses) expect(u, u).toMatch(PINNED);
    for (const p of EXAMPLES) {
      expect(examples[p].jobs.customrabbit?.uses, p).toMatch(/^dlled\/customrabbit\/\.github\/workflows\/review\.yml@[0-9a-f]{40}$/);
    }
  });

  it("never interpolates an expression into run:", () => {
    for (const s of allSteps()) if (s.run !== undefined) expect(s.run, s.name ?? s.run).not.toContain("${{");
  });
});

describe("review.yml (reusable job)", () => {
  const job = review.jobs.review;
  const call = review.on.workflow_call as { inputs: CallInputs; secrets: Record<string, { required: boolean }> };

  it("is workflow_call only, job key review", () => {
    expect(Object.keys(review.on)).toEqual(["workflow_call"]);
    expect(Object.keys(review.jobs)).toEqual(["review"]);
    expect(job?.["timeout-minutes"]).toBe(30);
    expect(review.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toEqual({ contents: "read" });
  });

  it("requires runs-on and trusted-authors, with no default: nothing runs on a runner or for an author nobody chose", () => {
    expect(call.inputs["runs-on"]).toEqual({ type: "string", required: true });
    expect(call.inputs["trusted-authors"]).toEqual({ type: "string", required: true });
    expect(call.inputs["runs-on"]).not.toHaveProperty("default");
    expect(call.inputs["trusted-authors"]).not.toHaveProperty("default");
    // Both pass through as the caller wrote them, with no fallback in the expression.
    expect(job?.["runs-on"]).toBe("${{ fromJSON(inputs.runs-on) }}");
    expect(job?.steps?.at(-1)?.with?.["trusted-authors"]).toBe("${{ inputs.trusted-authors }}");
    expect(text(".github/workflows/review.yml")).not.toMatch(/wtr-ci|'dlled'/);
  });

  it("defaults engines to both and isolation to guest-users", () => {
    expect(call.inputs.engines).toEqual({ type: "string", required: false, default: "both" });
    expect(call.inputs.isolation).toEqual({ type: "string", required: false, default: "guest-users" });
    expect(call.inputs.pr).toEqual({ type: "number", required: false, default: 0 });
    expect(Object.keys(call.inputs).sort()).toEqual(["engines", "isolation", "pr", "runs-on", "trusted-authors"]);
  });

  it("installs guest deps unless isolation none, and checks out the PR head without credentials", () => {
    const steps = job?.steps ?? [];
    expect(steps[0]?.if).toBe("inputs.isolation != 'none'");
    expect(steps[0]?.run).toMatch(/libatomic1/);
    expect(steps[0]?.run).toMatch(/\bacl\b/);
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({
      ref: "${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pr) }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  it("accepts either credential of each engine (none required) and requires the App secrets", () => {
    expect(Object.keys(call.secrets).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON", "MYRABBIT_APP_CLIENT_ID", "MYRABBIT_APP_PRIVATE_KEY", "OPENAI_API_KEY"].sort(),
    );
    for (const k of [...CREDENTIALS.claude, ...CREDENTIALS.codex]) expect(call.secrets[k]?.required, k).toBe(false);
    for (const k of ["MYRABBIT_APP_CLIENT_ID", "MYRABBIT_APP_PRIVATE_KEY"]) expect(call.secrets[k]?.required, k).toBe(true);
    const w = job?.steps?.at(-1)?.with ?? {};
    expect(w["claude-oauth-token"]).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(w["anthropic-api-key"]).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(w["codex-auth-json"]).toBe("${{ secrets.CODEX_AUTH_JSON }}");
    expect(w["openai-api-key"]).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(w.engines).toBe("${{ inputs.engines }}");
    expect(w.isolation).toBe("${{ inputs.isolation }}");
  });

  it("gives secrets only to the App-token step and the review step, which is the release pin line", () => {
    const steps = job?.steps ?? [];
    const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
    expect(withSecrets.map((s) => s.uses?.split("@")[0])).toEqual(["actions/create-github-app-token", SLUG]);
    const app = steps.find((s) => s.id === "app");
    expect(Object.fromEntries(Object.entries(app?.with ?? {}).filter(([k]) => k.startsWith("permission-")))).toEqual({
      "permission-pull-requests": "write",
      "permission-contents": "read",
      "permission-issues": "read",
    });
    expect(app?.with?.repositories).toBe("${{ github.event.repository.name }}");
    expect(app?.with).not.toHaveProperty("owner");
    expect(app?.with).not.toHaveProperty("enterprise");
    const last = steps.at(-1);
    expect(last?.uses).toMatch(/^dlled\/customrabbit@[0-9a-f]{40}$/);
    expect(last?.env).toBeUndefined();
    expect(Object.keys(last?.with ?? {}).sort()).toEqual(
      ["anthropic-api-key", "bot-login", "claude-oauth-token", "codex-auth-json", "engines", "github-token", "isolation", "openai-api-key", "pr", "trusted-authors"].sort(),
    );
    // scripts/release.sh rewrites exactly this line.
    expect(text(".github/workflows/review.yml")).toMatch(/^ {6}- uses: dlled\/customrabbit@[0-9a-f]{40} # myrabbit-action-pin$/m);
  });
});

describe.each(EXAMPLES)("%s", (path) => {
  const wf = examples[path];
  const job = wf.jobs.customrabbit;
  const w = job?.with ?? {};

  it("runs on pull_request and dispatch, never pull_request_target, and skips forks and bots", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(Object.keys(wf.jobs)).toEqual(["customrabbit"]);
    expect(job?.if).toContain("!endsWith(github.actor, '[bot]')");
    expect(job?.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(job?.if).toContain("!endsWith(github.event.pull_request.user.login, '[bot]')");
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(text(path)).toContain("cancel-in-progress: true");
  });

  it("passes both required inputs: a JSON label list and a non-empty author list", () => {
    const labels = JSON.parse(String(w["runs-on"])) as unknown;
    expect(Array.isArray(labels) && labels.length > 0 && labels.every((l) => typeof l === "string" && l !== "")).toBe(true);
    expect(String(w["trusted-authors"])).toMatch(/^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/);
  });

  it("passes exactly one credential per selected engine, and one engine only with isolation none", () => {
    const engines = typeof w.engines === "string" ? [w.engines] : ["claude", "codex"];
    if (w.isolation === "none") expect(engines).toHaveLength(1);
    const secrets = Object.keys(job?.secrets ?? {});
    for (const engine of engines) {
      const passed = CREDENTIALS[engine as keyof typeof CREDENTIALS].filter((k) => secrets.includes(k));
      expect(passed, `${path} ${engine}`).toHaveLength(1);
    }
    // Nothing for an engine that does not run, and the App secrets always.
    const expected = engines.flatMap((e) => CREDENTIALS[e as keyof typeof CREDENTIALS].filter((k) => secrets.includes(k)));
    expect(secrets.sort()).toEqual([...expected, "MYRABBIT_APP_CLIENT_ID", "MYRABBIT_APP_PRIVATE_KEY"].sort());
  });
});

describe("the three example profiles", () => {
  it("hosted: ubuntu-latest, isolation none, Claude with an API key", () => {
    const w = examples["examples/caller.yml"].jobs.customrabbit?.with ?? {};
    expect(JSON.parse(String(w["runs-on"]))).toEqual(["ubuntu-latest"]);
    expect(w.isolation).toBe("none");
    expect(w.engines).toBe("claude");
    expect(Object.keys(examples["examples/caller.yml"].jobs.customrabbit?.secrets ?? {})).toContain("ANTHROPIC_API_KEY");
  });

  it("self-hosted: guest-user isolation (the default), both engines", () => {
    const w = examples["examples/self-hosted.yml"].jobs.customrabbit?.with ?? {};
    expect(JSON.parse(String(w["runs-on"]))).toEqual(["self-hosted", "linux", "x64"]);
    expect(w).not.toHaveProperty("isolation");
    expect(w).not.toHaveProperty("engines");
  });

  it("WTR: exactly the three WTR labels, the last ending in review.yml's job key", () => {
    const w = examples["examples/wtr.yml"].jobs.customrabbit?.with ?? {};
    expect(JSON.parse(String(w["runs-on"]))).toEqual(wtrLabels("review"));
    expect(w).not.toHaveProperty("isolation");
  });
});

describe("ci.yml (this repository's CI)", () => {
  it("runs lint, typecheck, test, build and the dist freshness check on three WTR labels", () => {
    expect(Object.keys(ci.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(ci.jobs)).toEqual(["quality"]);
    const job = ci.jobs.quality;
    expect(job?.["runs-on"]).toEqual(wtrLabels("quality"));
    const runs = (job?.steps ?? []).flatMap((s) => (s.run === undefined ? [] : [s.run]));
    for (const cmd of ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build"]) expect(runs).toContain(cmd);
    expect(runs.join("\n")).toContain("git diff --exit-code -- dist/");
    const lint = runs.find((r) => r.includes("rhysd/actionlint/releases/download"));
    expect(lint).toMatch(/sha256=[0-9a-f]{64}/);
    expect(lint).toContain("sha256sum -c -");
    expect(job?.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("declares the WTR label for actionlint", () => {
    const config = load(".github/actionlint.yaml") as { "self-hosted-runner": { labels: string[] } };
    expect(config["self-hosted-runner"].labels).toEqual(["wtr-ci"]);
  });
});

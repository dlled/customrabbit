// End-to-end harness for the orchestrator: a real temp git repository (exercising createGitRunner
// and createGitReader), a fake GitHub HTTP API (Octokit with an injected fetch), fake engines and
// a temp RUNNER_TEMP / GITHUB_STEP_SUMMARY. Every credential here is an obviously fake value.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createGitReader } from "../../src/config/index.js";
import { createGitHubClientWithToken, createGitRunner } from "../../src/github/index.js";
import type { EngineSetup, SetupEngines } from "../../src/orchestrator/engines.js";
import type { PipelineDeps } from "../../src/orchestrator/pipeline.js";
import { loadTemplates } from "../../src/prompts/builder.js";
import type { Engine, EngineError, EngineInput, EngineName, EngineOutput, EngineResult, EngineTask } from "../../src/types.js";
import { LEARNING_OUTPUT_SCHEMA, type LearningOutput } from "../../src/learnings/index.js";
import { fakeServer, type Call, type FakeServer } from "../github/helpers.js";
import { fakeJwt } from "../engines/helpers.js";

export const OWNER = "acme";
export const NAME = "widgets";
export const PR = 7;
export const BOT = "myrabbit[bot]";
export const FAKE_GH_TOKEN = "fake-github-app-token-0000";
export const FAKE_CLAUDE_TOKEN = "fake-claude-oauth-token-0000";

export function fakeCodexAuthJson(expMs = Date.now() + 6 * 3600_000): string {
  return JSON.stringify({
    auth_mode: "chatgptAuthTokens",
    tokens: { access_token: fakeJwt(Math.floor(expMs / 1000)), refresh_token: "", account_id: "acct-fake-0000" },
  });
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export class TempRepo {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: this.dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  }

  write(path: string, content: string): void {
    const p = join(this.dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  commit(message: string, files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }
}

/** Ten numbered lines; `edit` replaces some of them (1-based). */
export function appSource(edit: Record<number, string> = {}, extra: string[] = []): string {
  const lines = Array.from({ length: 10 }, (_, i) => edit[i + 1] ?? `export const a${i + 1} = ${i + 1};`);
  return [...lines, ...extra].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------

export type EngineBehaviour = {
  review?: EngineOutput | { fail: EngineError["kind"]; message?: string };
  confirmed?: boolean;
  fixed?: boolean;
  /** Answer to a design-v2 §6.2 proposal call; "fail" makes the call fail. */
  learning?: LearningOutput | "fail";
};

export interface EngineCall {
  engine: EngineName;
  task: EngineTask;
  prompt: string;
  systemPrompt: string;
  /** A §6.2 proposal call (task "learning"). */
  learning: boolean;
  outputSchema: Record<string, unknown>;
}

export function fakeEngine(name: EngineName, behaviour: EngineBehaviour, calls: EngineCall[]): Engine {
  return {
    name,
    review<T>(input: EngineInput<T>): Promise<EngineResult<T>> {
      const learning = input.task === "learning";
      if (learning && input.outputSchema !== LEARNING_OUTPUT_SCHEMA) throw new Error("learning call without its schema");
      calls.push({ engine: name, task: input.task, prompt: input.prompt, systemPrompt: input.systemPrompt, learning, outputSchema: input.outputSchema });
      const base = { engine: name, model: `${name}-model`, usage: null, costUsd: 0.01, durationMs: 1000, toolCalls: 1, denials: 0 };
      let raw: unknown;
      if (learning) {
        const l = behaviour.learning ?? { propose: false, title: "", rule: "", paths: [] };
        if (l === "fail") return Promise.resolve({ ...base, ok: false, error: { kind: "timeout", message: `${name} timeout` } });
        raw = l;
      } else if (input.task === "review") {
        const r = behaviour.review ?? { summary: "Changes a constant.", changes: [], findings: [] };
        if ("fail" in r) return Promise.resolve({ ...base, ok: false, error: { kind: r.fail, message: r.message ?? `${name} ${r.fail}` } });
        raw = r;
      } else if (input.task === "verify") {
        raw = { confirmed: behaviour.confirmed ?? true, reason: "reproduced", evidence: ["src/app.ts:5"] };
      } else {
        raw = { fixed: behaviour.fixed ?? false, reason: "checked", evidence: ["src/app.ts:5"] };
      }
      return Promise.resolve({ ...base, ok: true, output: input.parse(raw) });
    },
  };
}

export function fakeSetup(engines: Partial<Record<EngineName, EngineBehaviour>>, calls: EngineCall[], counter: { setups: number; cleanups: number }): SetupEngines {
  return (): Promise<EngineSetup> => {
    counter.setups++;
    const list: Engine[] = [];
    for (const name of ["claude", "codex"] as const) {
      const b = engines[name];
      if (b !== undefined) list.push(fakeEngine(name, b, calls));
    }
    return Promise.resolve({
      engines: list,
      notRunning: [],
      denyNotes: [],
      cleanup: () => {
        counter.cleanups++;
        return Promise.resolve();
      },
    });
  };
}

export function finding(o: Partial<EngineOutput["findings"][number]> = {}): EngineOutput["findings"][number] {
  return {
    path: "src/app.ts",
    line: 5,
    end_line: null,
    side: "RIGHT",
    severity: "major",
    category: "correctness",
    title: "Constant a5 has the wrong value",
    body: "a5 must stay 5; callers index by it.",
    failure_scenario: "lookup(a5) reads index 50 and returns undefined.",
    evidence: ["src/app.ts:5"],
    rule: null,
    suggestion: null,
    confidence: 0.9,
    ...o,
  };
}

export function output(findings: EngineOutput["findings"]): EngineOutput {
  return { summary: "Changes constant a5 and adds a11.", changes: [{ area: "app", files: ["src/app.ts"], summary: "constants" }], findings };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface PrOptions {
  head: string;
  base: string;
  author?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  title?: string;
  body?: string;
  labels?: string[];
  headRepo?: string;
}

export function prJson(o: PrOptions): Record<string, unknown> {
  return {
    number: PR,
    state: o.state ?? "open",
    merged: o.merged ?? false,
    draft: o.draft ?? false,
    title: o.title ?? "Change constants",
    body: o.body ?? "Changes a5.",
    labels: (o.labels ?? []).map((name) => ({ name })),
    user: { login: o.author ?? "dlled" },
    html_url: `https://github.com/${OWNER}/${NAME}/pull/${PR}`,
    head: { sha: o.head, ref: "feature", repo: { full_name: o.headRepo ?? `${OWNER}/${NAME}` } },
    base: { sha: o.base, ref: "main", repo: { full_name: `${OWNER}/${NAME}` } },
  };
}

export interface RawThreadInput {
  id: string;
  databaseId: number;
  body: string;
  line: number | null;
  originalLine?: number;
  isOutdated?: boolean;
  isResolved?: boolean;
  resolvedBy?: string | null;
  authorLogin?: string;
  /** design-v2 §6.2: replies after the first comment. */
  replies?: { login: string; typename?: string; body: string }[];
  /** Commit of the first comment. */
  originalCommit?: string;
}

export function rawThread(t: RawThreadInput): Record<string, unknown> {
  return {
    id: t.id,
    path: "src/app.ts",
    line: t.line,
    startLine: null,
    originalLine: t.originalLine ?? t.line ?? 1,
    originalStartLine: null,
    diffSide: "RIGHT",
    isResolved: t.isResolved ?? false,
    isOutdated: t.isOutdated ?? false,
    resolvedBy: t.resolvedBy ? { login: t.resolvedBy } : null,
    comments: {
      nodes: [
        {
          id: `C${t.databaseId}`,
          databaseId: t.databaseId,
          body: t.body,
          author: { __typename: "Bot", login: t.authorLogin ?? "myrabbit" },
          originalCommit: t.originalCommit === undefined ? null : { oid: t.originalCommit },
        },
        ...(t.replies ?? []).map((r, i) => ({
          id: `R${t.databaseId}-${i}`,
          databaseId: t.databaseId * 100 + i,
          body: r.body,
          author: { __typename: r.typename ?? "User", login: r.login },
          originalCommit: null,
        })),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Harness {
  root: string;
  repo: TempRepo;
  runnerTemp: string;
  summaryPath: string;
  eventPath: string;
  server: FakeServer;
  env: NodeJS.ProcessEnv;
  calls: EngineCall[];
  counter: { setups: number; cleanups: number };
  logs: string[];
  deps(engines: Partial<Record<EngineName, EngineBehaviour>>, overrides?: Partial<PipelineDeps>): PipelineDeps;
  /** Review POSTs. */
  posts(): Call[];
  summary(): string;
  runDocument(): Record<string, unknown> | null;
  /** Default routes: PR, no reviews, no threads, POST review ok. */
  routes(pr: PrOptions, opts?: { reviews?: unknown[]; threads?: unknown[] }): void;
  cleanup(): void;
}

export function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "myrabbit-main-"));
  const repo = new TempRepo(join(root, "work", NAME));
  const runnerTemp = join(root, "runner", "_work", "_temp");
  mkdirSync(runnerTemp, { recursive: true });
  const summaryPath = join(runnerTemp, "step_summary.md");
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: PR } }));
  const server = fakeServer();
  const calls: EngineCall[] = [];
  const counter = { setups: 0, cleanups: 0 };
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    MYRABBIT_GITHUB_TOKEN: FAKE_GH_TOKEN,
    MYRABBIT_BOT_LOGIN: BOT,
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN,
    CODEX_AUTH_JSON: fakeCodexAuthJson(),
    MYRABBIT_PR: "0",
    MYRABBIT_TRUSTED_AUTHORS: "dlled",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: `${OWNER}/${NAME}`,
    GITHUB_WORKSPACE: repo.dir,
    GITHUB_ACTOR: "dlled",
    GITHUB_RUN_ID: "42",
    GITHUB_SERVER_URL: "https://github.com",
    RUNNER_TEMP: runnerTemp,
    GITHUB_STEP_SUMMARY: summaryPath,
  };
  const h: Harness = {
    root,
    repo,
    runnerTemp,
    summaryPath,
    eventPath,
    server,
    env,
    calls,
    counter,
    logs,
    deps(engines, overrides = {}) {
      return {
        env,
        readEvent: (path) => Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as unknown),
        github: (runtime) =>
          createGitHubClientWithToken(runtime.secrets.githubToken, { fetch: server.fetch, sleep: () => Promise.resolve() }),
        git: (workspace) => createGitRunner(workspace),
        gitReader: (workspace) => createGitReader(workspace),
        setupEngines: fakeSetup(engines, calls, counter),
        templates: loadTemplates(),
        writeFile: (path, text) => writeFile(path, text, "utf8"),
        appendFile: (path, text) => appendFile(path, text, "utf8"),
        log: (m) => logs.push(m),
        nonce: () => "0123456789abcdef",
        ...overrides,
      };
    },
    posts: () => server.calls.filter((c) => c.method === "POST" && c.path === `/repos/${OWNER}/${NAME}/pulls/${PR}/reviews`),
    summary: () => (existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : ""),
    runDocument: () => {
      const p = join(runnerTemp, "myrabbit-run.json");
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
    },
    routes(pr, opts = {}) {
      server.on("GET", `/repos/${OWNER}/${NAME}/pulls/${PR}`, { body: prJson(pr) });
      server.on("GET", `/repos/${OWNER}/${NAME}/pulls/${PR}/reviews`, { body: opts.reviews ?? [] });
      server.on("POST", "/graphql", (call) => {
        const q = (call.body as { query?: string }).query ?? "";
        if (q.includes("resolveReviewThread")) return { body: { data: { resolveReviewThread: { thread: { id: "T", isResolved: true } } } } };
        return {
          body: {
            data: {
              repository: {
                pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.threads ?? [] } },
              },
            },
          },
        };
      });
      server.on("POST", `/repos/${OWNER}/${NAME}/pulls/${PR}/reviews`, {
        body: { id: 1001, html_url: `https://github.com/${OWNER}/${NAME}/pull/${PR}#pullrequestreview-1001` },
      });
      server.on("PATCH", /^\/repos\/acme\/widgets\/pulls\/comments\/\d+$/, { body: {} });
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

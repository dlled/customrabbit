// myrabbit entry point: `node $GITHUB_ACTION_PATH/dist/main.js` (design §10.3).
//
// Inputs come only as env on this step (§10.3): MYRABBIT_GITHUB_TOKEN, MYRABBIT_BOT_LOGIN,
// CLAUDE_CODE_OAUTH_TOKEN, CODEX_AUTH_JSON, MYRABBIT_PR, MYRABBIT_TRUSTED_AUTHORS, plus the
// runner's own non-secret variables. Exit 0 = posted / skipped / head moved; 1 = failure.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGitReader } from "./config/index.js";
import { createGitHubClient, createGitRunner } from "./github/index.js";
import { realEngineSetup } from "./orchestrator/engines.js";
import { stdoutLog } from "./orchestrator/log.js";
import { runPipeline, type PipelineDeps } from "./orchestrator/pipeline.js";
import { bundledLearningTemplate, bundledTemplates } from "./orchestrator/templates.js";
import { realToolsDeps } from "./orchestrator/tools.js";

/** The action root: the parent of dist/ (bundle) or of src/ (source); holds bin/ and node_modules/. */
export function actionRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): PipelineDeps {
  return {
    env,
    readEvent: async (path) => JSON.parse(await readFile(path, "utf8")) as unknown,
    github: (runtime, log) =>
      createGitHubClient(runtime.secrets, {
        onRateLimit: ({ method, url, waitMs, attempt }) => {
          log(`GitHub rate limit on ${method} ${url}: waiting ${Math.ceil(waitMs / 1000)} s (attempt ${attempt})`);
        },
      }),
    git: (workspace) => createGitRunner(workspace),
    gitReader: (workspace) => createGitReader(workspace),
    setupEngines: realEngineSetup({ actionRoot: actionRoot() }),
    templates: bundledTemplates(),
    learningTemplate: bundledLearningTemplate(),
    writeFile: (path, text) => writeFile(path, text, { encoding: "utf8", mode: 0o600 }),
    appendFile: (path, text) => appendFile(path, text, "utf8"),
    log: stdoutLog,
    // design-v2 §7.2: dist/tools-install.js in a minimal-env child; bin/as-tools; tools/.
    tools: realToolsDeps(actionRoot(), stdoutLog),
  };
}

/** Longest wait for the log streams to drain before exiting anyway (a closed pipe never calls back). */
export const FLUSH_TIMEOUT_MS = 5_000;

interface Flushable {
  write(chunk: string, cb: (err?: Error | null) => void): boolean;
}

/**
 * Flushes the log streams, then exits with `code`. The exit is explicit: work the pipeline abandoned
 * on a time budget (design-v2 §4.6–§4.7 lookups still waiting on the API or a rate-limit sleep) must
 * not keep the job's VM busy after the review is posted. Every file the run writes (run document,
 * step summary) is awaited inside runPipeline, so only buffered stdout/stderr can be pending here.
 */
export async function exitAfterFlush(
  code: number,
  streams: readonly Flushable[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (c) => process.exit(c),
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> {
  // Should Node drain the event loop by itself while a write is pending (the cap timer is
  // unref'd), it still exits with the pipeline's code, not 0.
  process.exitCode = code;
  const drained = (s: Flushable) =>
    new Promise<void>((resolve) => {
      // An empty write calls back once everything queued before it is handed to the OS.
      s.write("", () => {
        resolve();
      });
    });
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([Promise.all(streams.map(drained)), cap]);
  } finally {
    clearTimeout(timer);
  }
  exit(code);
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await exitAfterFlush(await runPipeline(realDeps()));
}

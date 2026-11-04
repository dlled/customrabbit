// The GitHub Actions context the orchestrator runs in (design §2 step 1, §10.1, §10.2).
// Only non-secret runner variables are read here; the secrets are read once by src/env.ts.
// The event payload is read from GITHUB_EVENT_PATH in Node; nothing from it is ever interpolated
// into a shell.

import type { RepoRef, Trigger } from "../github/index.js";

export class ContextError extends Error {
  override readonly name = "ContextError";
}

export interface ActionContext {
  trigger: Trigger;
  repo: RepoRef;
  /** owner/name */
  repoFullName: string;
  /** The PR checkout (GITHUB_WORKSPACE): the engines' read-only working directory. */
  workspace: string;
  /** $RUNNER_TEMP: run document location; denied to the engines. */
  runnerTemp: string | null;
  /** $GITHUB_STEP_SUMMARY, when set. */
  stepSummary: string | null;
  /** The triggering actor (loop guard, §8.1). */
  actor: string | null;
  /** Link to this workflow run, for the review body. */
  runUrl: string | null;
}

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? null : v;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = nonEmpty(env, name);
  if (v === null) throw new ContextError(`${name} is not set`);
  return v;
}

/** Reads the runner variables. Throws ContextError for an unsupported event or a missing variable. */
export function readActionContext(env: NodeJS.ProcessEnv): ActionContext {
  const event = required(env, "GITHUB_EVENT_NAME");
  if (event !== "pull_request" && event !== "workflow_dispatch") {
    throw new ContextError(`unsupported event ${event.slice(0, 40)}: myrabbit runs on pull_request and workflow_dispatch only`);
  }
  const repoFullName = required(env, "GITHUB_REPOSITORY");
  const m = REPO.exec(repoFullName);
  if (!m?.[1] || !m[2]) throw new ContextError("GITHUB_REPOSITORY is malformed");
  const workspace = required(env, "GITHUB_WORKSPACE");
  if (!workspace.startsWith("/")) throw new ContextError("GITHUB_WORKSPACE must be an absolute path");
  const runnerTemp = nonEmpty(env, "RUNNER_TEMP");
  const server = nonEmpty(env, "GITHUB_SERVER_URL") ?? "https://github.com";
  const runId = nonEmpty(env, "GITHUB_RUN_ID");
  const attempt = nonEmpty(env, "GITHUB_RUN_ATTEMPT");
  const runUrl =
    runId !== null && /^\d+$/.test(runId)
      ? `${server}/${repoFullName}/actions/runs/${runId}${attempt !== null && /^\d+$/.test(attempt) ? `/attempts/${attempt}` : ""}`
      : null;
  return {
    trigger: event,
    repo: { owner: m[1], repo: m[2] },
    repoFullName,
    workspace,
    runnerTemp: runnerTemp !== null && runnerTemp.startsWith("/") ? runnerTemp : null,
    stepSummary: nonEmpty(env, "GITHUB_STEP_SUMMARY"),
    actor: nonEmpty(env, "GITHUB_ACTOR"),
    runUrl,
  };
}

/**
 * The PR to review. workflow_dispatch: the `pr` input (MYRABBIT_PR), required. pull_request: the
 * event's PR number; an explicit MYRABBIT_PR must agree with it.
 */
export function resolvePrNumber(trigger: Trigger, inputPr: number | null, eventPayload: unknown): number {
  if (trigger === "workflow_dispatch") {
    if (inputPr === null) throw new ContextError("workflow_dispatch needs the pr input");
    return inputPr;
  }
  const pr = (eventPayload as { pull_request?: { number?: unknown } } | null)?.pull_request?.number;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) {
    throw new ContextError("pull_request event payload has no PR number");
  }
  if (inputPr !== null && inputPr !== pr) throw new ContextError("pr input does not match the pull_request event");
  return pr;
}

/**
 * The composite action maps `pr` to MYRABBIT_PR, and review.yml passes 0 on pull_request events
 * ("take the PR from the event", §10.2). src/env.ts accepts only positive numbers, so 0 (or blank)
 * means unset.
 */
export function normalizePrInput(env: NodeJS.ProcessEnv): void {
  const raw = env.MYRABBIT_PR?.trim();
  if (raw === undefined || raw === "" || /^0+$/.test(raw)) Reflect.deleteProperty(env, "MYRABBIT_PR");
}

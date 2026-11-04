// Running engines (design.md §2 step 6, §2.2, §6.3, §6.4, §9).
//
// - runEngine: one call with its own AbortSignal.timeout; never throws.
// - runBoth: both engines in parallel with Promise.allSettled, each with its own timeout.
// - verifyFinding / resolveFinding: the single small calls used by the merger (§6.3) and the
//   incremental resolve step (§6.4). The per-run budgets (8 verifications, 10 resolves) and their
//   ordering are applied by the caller.

import type {
  EngineFailure,
  EngineInput,
  EngineName,
  EngineResult,
  EnginesConfig,
  Engine,
  ResolveOutput,
  VerifyOutput,
} from "../types.js";
import {
  buildResolvePrompt,
  buildVerifyPrompt,
  type BuiltPrompt,
  type PromptContext,
  type ResolveFinding,
  type Templates,
  type VerifyFinding,
} from "../prompts/builder.js";
import { abortKind, engineError, failure, safeMessage } from "./common.js";
import {
  parseEngineOutput,
  parseResolveOutput,
  parseVerifyOutput,
  RESOLVE_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  VERIFY_OUTPUT_SCHEMA,
} from "./schema.js";

/** Extra time an adapter gets to wind down after its signal fires before runEngine gives up on it. */
export const ABORT_GRACE_MS = 30_000;

export interface RunOptions {
  timeoutMs: number;
  /** Outer cancellation (e.g. the job shutting down). */
  signal?: AbortSignal;
  /** Default ABORT_GRACE_MS. */
  graceMs?: number;
  now?: () => number;
}

/** `engines.timeout_minutes` in ms. */
export function engineTimeoutMs(config: Pick<EnginesConfig, "timeout_minutes">): number {
  return config.timeout_minutes * 60_000;
}

function stuck(engine: EngineName, signal: AbortSignal, startedAt: number, now: number): EngineFailure {
  const kind = abortKind(signal);
  return failure(engine, engineError(kind, `${engine} ${kind} (did not stop after abort)`), {
    model: null,
    usage: null,
    costUsd: null,
    startedAt,
    now,
    toolCalls: 0,
    denials: 0,
  });
}

/** One engine call with its own timeout. Resolves to an EngineFailure instead of throwing. */
export async function runEngine<T>(engine: Engine, input: EngineInput<T>, opts: RunOptions): Promise<EngineResult<T>> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
  const graceMs = opts.graceMs ?? ABORT_GRACE_MS;

  let graceTimer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const watchdog = new Promise<EngineResult<T>>((resolve) => {
    onAbort = () => {
      graceTimer = setTimeout(() => {
        resolve(stuck(engine.name, signal, startedAt, now()));
      }, graceMs);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  const call = (async (): Promise<EngineResult<T>> => {
    try {
      return await engine.review(input, signal);
    } catch (err) {
      return failure(engine.name, engineError("sdk_error", `${engine.name}: ${safeMessage(err)}`), {
        model: null,
        usage: null,
        costUsd: null,
        startedAt,
        now: now(),
        toolCalls: 0,
        denials: 0,
      });
    }
  })();

  try {
    return await Promise.race([call, watchdog]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs every given engine on the same input in parallel (§2 step 6). Each gets its own timeout;
 * one failing never affects the other. Results are in the order of `engines`.
 */
export async function runBoth<T>(
  engines: readonly Engine[],
  input: EngineInput<T>,
  opts: RunOptions,
): Promise<EngineResult<T>[]> {
  const settled = await Promise.allSettled(engines.map((e) => runEngine(e, input, opts)));
  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const engine = engines[i];
    const name: EngineName = engine === undefined ? "claude" : engine.name;
    return failure(name, engineError("sdk_error", `${name}: ${safeMessage(s.reason)}`), {
      model: null,
      usage: null,
      costUsd: null,
      startedAt: 0,
      now: 0,
      toolCalls: 0,
      denials: 0,
    });
  });
}

/** EngineInput for the main review (§6.2). */
export function reviewInput(built: BuiltPrompt, cwd: string): EngineInput {
  return {
    task: "review",
    systemPrompt: built.systemPrompt,
    prompt: built.prompt,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    parse: parseEngineOutput,
    cwd,
  };
}

/**
 * The verifier for a single-source finding (§6.3): the other engine if it is available, else a
 * fresh call of the same engine; null if neither is available.
 */
export function verifierFor(source: EngineName, available: readonly Engine[]): Engine | null {
  return available.find((e) => e.name !== source) ?? available.find((e) => e.name === source) ?? null;
}

export interface CallOptions extends RunOptions {
  context: PromptContext;
  cwd: string;
  headSha: string;
  templates?: Templates;
}

/** §6.3: asks `engine` to confirm a finding against the code. */
export function verifyFinding(
  engine: Engine,
  finding: VerifyFinding,
  opts: CallOptions,
): Promise<EngineResult<VerifyOutput>> {
  const built = buildVerifyPrompt({ context: opts.context, headSha: opts.headSha, finding }, opts.templates);
  return runEngine(
    engine,
    {
      task: "verify",
      systemPrompt: built.systemPrompt,
      prompt: built.prompt,
      outputSchema: VERIFY_OUTPUT_SCHEMA,
      parse: parseVerifyOutput,
      cwd: opts.cwd,
    },
    opts,
  );
}

/** §6.4: asks `engine` whether a prior finding is fixed in the current code. */
export function resolveFinding(
  engine: Engine,
  finding: ResolveFinding,
  opts: CallOptions & { lastSha: string; diff: string },
): Promise<EngineResult<ResolveOutput>> {
  const built = buildResolvePrompt(
    { context: opts.context, lastSha: opts.lastSha, headSha: opts.headSha, finding, diff: opts.diff },
    opts.templates,
  );
  return runEngine(
    engine,
    {
      task: "resolve",
      systemPrompt: built.systemPrompt,
      prompt: built.prompt,
      outputSchema: RESOLVE_OUTPUT_SCHEMA,
      parse: parseResolveOutput,
      cwd: opts.cwd,
    },
    opts,
  );
}

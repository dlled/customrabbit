// Codex SDK adapter (design.md §9, §9.1, R2 §2, R3 §6 #4).
//
// - The CLI runs through bin/as-agent-codex (codexPathOverride) as myrabbit-codex (§9.2).
// - Auth is $CODEX_HOME/auth.json only (no apiKey option): CODEX_AUTH_JSON, or an OPENAI_API_KEY
//   stored there by `codex login --with-api-key`. An auth.json credential is checked before every call
//   and an expired or expiring token skips the call as an engine failure (§9.1 step 4).
// - Read-only sandbox, no approvals, no network, no web search; project_doc_max_bytes=0 so the
//   PR's AGENTS.md is never loaded as instructions.
// - The output is JSON.parse(finalResponse) → zod; on a parse or validation failure the call is
//   retried once in a fresh thread with the error appended.

import { Codex, type CodexOptions, type ThreadItem, type ThreadOptions, type TurnOptions, type Usage } from "@openai/codex-sdk";
import { codexCredentialStatus, type EngineEnv, type Secrets } from "../env.js";
import { escapeUntrusted } from "../prompts/builder.js";
import type { CodexEngineConfig, Engine, EngineInput, EngineResult, EngineUsage } from "../types.js";
import { CODEX_API_KEY_CONFIG } from "./codex-home.js";
import { abortKind, addUsage, engineError, failure, safeMessage, sdkErrorKind } from "./common.js";
import { costUsd, PRICES, type TokenRates } from "./prices.js";

/** Config overrides passed as `--config key=value` (§9). */
export const CODEX_CONFIG = Object.freeze({ project_doc_max_bytes: 0 });

/** Minimal surface of the SDK used here, so tests can inject a fake. */
export interface CodexTurn {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
}
export interface CodexThread {
  run(input: string, options?: TurnOptions): Promise<CodexTurn>;
}
export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread;
}
export type CodexFactory = (options: CodexOptions) => CodexClient;

export interface CodexEngineOptions {
  config: Pick<CodexEngineConfig, "model" | "effort">;
  /** Used only to check the token lifetime before each call. */
  secrets: Secrets;
  /** From codexEnv() in src/env.ts (PATH, HOME, CODEX_HOME, MYRABBIT_CODEX_BIN). */
  env: EngineEnv;
  /** Absolute path of bin/as-agent-codex. */
  executable: string;
  /** Injected for tests; default constructs the SDK's Codex. */
  codex?: CodexFactory;
  prices?: Readonly<Record<string, TokenRates>>;
  now?: () => number;
}

/**
 * The exact client options (§9). Never an apiKey: an OPENAI_API_KEY credential is in
 * $CODEX_HOME/auth.json from `codex login --with-api-key`, and the run reads it from that file.
 */
export function codexClientOptions(opts: Pick<CodexEngineOptions, "env" | "executable" | "secrets">): CodexOptions {
  if (opts.env.CODEX_HOME === undefined || opts.env.CODEX_HOME === "") throw new Error("codex env needs CODEX_HOME");
  return {
    codexPathOverride: opts.executable,
    env: { ...opts.env },
    config: { ...CODEX_CONFIG, ...(opts.secrets.codexAuth === "api_key" ? CODEX_API_KEY_CONFIG : {}) },
  };
}

/** The exact thread options (§9). */
export function codexThreadOptions(opts: Pick<CodexEngineOptions, "config">, cwd: string): ThreadOptions {
  const o: ThreadOptions = {
    workingDirectory: cwd,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: opts.config.effort,
  };
  if (opts.config.model !== null) o.model = opts.config.model;
  return o;
}

function usageOf(u: Usage | null): EngineUsage | null {
  if (u === null) return null;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: u.cached_input_tokens,
    cacheWriteInputTokens: u.cache_write_input_tokens,
    reasoningOutputTokens: u.reasoning_output_tokens,
  };
}

function countTools(items: ThreadItem[]): { toolCalls: number; denials: number } {
  let toolCalls = 0;
  let denials = 0;
  for (const item of items) {
    if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search") toolCalls++;
    if (item.type === "file_change") {
      // Any write attempt in a read-only review is a policy hit.
      toolCalls++;
      denials++;
    }
  }
  return { toolCalls, denials };
}

/** Text appended for the single retry; the error text derives from model output, so escape it. */
export function retryNote(message: string): string {
  return `\n\n<retry>\nYour previous answer was rejected: ${escapeUntrusted(message)}\nReturn only JSON matching the schema.\n</retry>`;
}

/** Reads signal.aborted without control-flow narrowing (it changes across awaits). */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createCodexEngine(opts: CodexEngineOptions): Engine {
  const factory: CodexFactory = opts.codex ?? ((o) => new Codex(o));
  const now = opts.now ?? Date.now;
  const prices = opts.prices ?? PRICES;

  return {
    name: "codex",
    async review<T>(input: EngineInput<T>, signal: AbortSignal): Promise<EngineResult<T>> {
      const startedAt = now();
      const model = opts.config.model;
      let usage: EngineUsage | null = null;
      let toolCalls = 0;
      let denials = 0;
      const stats = () => ({ model, usage, costUsd: costUsd(model, usage, prices), startedAt, now: now(), toolCalls, denials });

      const cred = codexCredentialStatus(opts.secrets, now());
      if (!cred.usable) {
        const why = cred.reason === "malformed" ? "credential malformed" : `credential ${cred.reason}`;
        return failure("codex", engineError("credential", `skipped: ${why}`), stats());
      }

      let client: CodexClient;
      try {
        client = factory(codexClientOptions(opts));
      } catch (err) {
        const message = `codex: ${safeMessage(err)}`;
        return failure("codex", engineError(sdkErrorKind(message), message), stats());
      }

      const text = `${input.systemPrompt}\n\n${input.prompt}`;
      let lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) break;
        let turn: CodexTurn;
        try {
          const thread = client.startThread(codexThreadOptions(opts, input.cwd));
          turn = await thread.run(attempt === 0 ? text : text + retryNote(lastError), {
            outputSchema: input.outputSchema,
            signal,
          });
        } catch (err) {
          if (aborted(signal)) break;
          // Quota, rate-limit and auth failures are classified and never retried (the retry
          // below is only for invalid output).
          const message = `codex: ${safeMessage(err)}`;
          return failure("codex", engineError(sdkErrorKind(message), message), stats());
        }
        usage = addUsage(usage, usageOf(turn.usage));
        const counts = countTools(turn.items);
        toolCalls += counts.toolCalls;
        denials += counts.denials;

        let output: T;
        try {
          output = input.parse(JSON.parse(turn.finalResponse));
        } catch (err) {
          lastError = err instanceof SyntaxError ? "response is not valid JSON" : safeMessage(err);
          continue;
        }
        const s = stats();
        return {
          ok: true,
          engine: "codex",
          output,
          model: s.model,
          usage: s.usage,
          costUsd: s.costUsd,
          durationMs: Math.max(0, s.now - startedAt),
          toolCalls,
          denials,
        };
      }
      if (aborted(signal)) {
        return failure("codex", engineError(abortKind(signal), `codex ${abortKind(signal)}`), stats());
      }
      return failure("codex", engineError("invalid_output", `codex: invalid output twice: ${lastError}`), stats());
    },
  };
}

// Claude Agent SDK adapter (design.md §9, R2 §1, R3 §6 #3).
//
// Read-only reviewer: only Read/Grep/Glob exist, writers/shell/web/Agent are removed, path deny
// rules keep the read tools out of system and runner directories (second line of defence; the
// primary one is running the CLI as myrabbit-claude through bin/as-agent-claude, §9.2), and no
// settings, MCP servers or sessions are loaded from the untrusted checkout.

import { query as sdkQuery, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync } from "node:fs";
import type { EngineEnv } from "../env.js";
import type { ClaudeEngineConfig, Engine, EngineInput, EngineResult, EngineUsage } from "../types.js";
import { abortKind, classifyUnavailable, engineError, failure, safeMessage, sdkErrorKind } from "./common.js";

export const CLAUDE_TOOLS = ["Read", "Grep", "Glob"] as const;
export const CLAUDE_DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent"] as const;

/** Absolute roots the read tools may never touch (§9). `~` is the engine's own HOME. */
export const CLAUDE_DENIED_ROOTS = ["/proc", "/sys", "/etc", "/home", "/root", "/tmp", "~"] as const;

/** The SDK tool that carries structured output; not counted as a tool call. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function normalizeDir(dir: string): string {
  if (dir === "~") return dir;
  if (!dir.startsWith("/")) throw new Error(`denied directory must be absolute: ${dir}`);
  const trimmed = dir.replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return trimmed === "" ? "/" : trimmed;
}

/** True when `cwd` is `root` or below it. */
function contains(root: string, cwd: string): boolean {
  return root === "/" || cwd === root || cwd.startsWith(`${root}/`);
}

/** Directory entry names; null when the directory cannot be listed. */
export type ListDir = (dir: string) => string[] | null;

const defaultListDir: ListDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
};

/** Names that can be written into a permission rule without glob or rule-syntax meaning. */
const SAFE_NAME = /^[A-Za-z0-9._@+-]+$/;

/** Runner files that hold credentials, config or logs; always denied when the runner dir is known (§9). */
export const RUNNER_SECRET_ENTRIES = [".runner", ".credentials*", ".env", ".path", "_diag/**", "_temp/**"] as const;

/**
 * The runner root from $RUNNER_TEMP (`<root>/_work/_temp` on standard runners), or null when the
 * layout is not the standard one; the caller then passes the runner dir explicitly or relies on
 * extraDirs.
 */
export function runnerRootFromTemp(runnerTemp: string): string | null {
  const parts = normalizeDir(runnerTemp).split("/");
  if (parts.length < 4 || parts.at(-1) !== "_temp" || parts.at(-2) !== "_work") return null;
  return parts.slice(0, -2).join("/");
}

export interface DenyRules {
  rules: string[];
  /**
   * Roots that contain the checkout, so they could not be denied whole (deny rules win over
   * allow and would also deny the checkout). For these, every sibling entry on the way down to the
   * checkout is denied instead. Reported for logging.
   */
  skipped: string[];
  /**
   * Gaps in that sibling walk: directories that could not be listed, or entry names that cannot be
   * written into a rule. §9.2 (separate user) is the control that still applies there.
   */
  unlisted: string[];
}

export interface DenyRuleOptions {
  /** Extra denied directories, e.g. $RUNNER_TEMP. */
  extraDirs?: readonly string[];
  /** The runner directory: denied, and its credential files always get explicit rules. */
  runnerDir?: string;
  /** Default fs.readdirSync; injected in tests. */
  listDir?: ListDir;
}

/**
 * `Read(//proc/**)`, `Grep(//proc/**)`, `Glob(//proc/**)`, … for every denied root, the runner
 * directory and `extraDirs`. `//x` is the absolute path /x in permission-rule syntax.
 *
 * A root that contains the checkout (e.g. /home and the runner directory, when the checkout is
 * /home/runner/actions-runner/_work/r/r) is walked instead: at each level from the root down to
 * the checkout, every sibling entry other than the next path component is denied.
 */
export function claudeDenyRules(cwd: string, options: DenyRuleOptions = {}): DenyRules {
  const checkout = normalizeDir(cwd);
  const listDir = options.listDir ?? defaultListDir;
  const patterns = new Set<string>();
  const skipped: string[] = [];
  const unlisted: string[] = [];
  const runnerDir = options.runnerDir === undefined ? undefined : normalizeDir(options.runnerDir);

  const roots = [
    ...new Set([...CLAUDE_DENIED_ROOTS, ...(runnerDir === undefined ? [] : [runnerDir]), ...(options.extraDirs ?? [])].map(normalizeDir)),
  ];
  for (const root of roots) {
    if (root === "~") {
      patterns.add("~/**");
      continue;
    }
    if (!contains(root, checkout)) {
      patterns.add(`/${root}/**`);
      continue;
    }
    skipped.push(root);
    if (root === checkout) continue;
    // Walk root → checkout, denying the siblings of the path at each level.
    const rest = checkout.slice(root === "/" ? 1 : root.length + 1).split("/");
    let level = root;
    for (const next of rest) {
      const entries = listDir(level);
      if (entries === null) {
        unlisted.push(level);
      } else {
        for (const name of entries) {
          if (name === next) continue;
          if (!SAFE_NAME.test(name)) {
            unlisted.push(`${level}/${name}`);
            continue;
          }
          const path = level === "/" ? `/${name}` : `${level}/${name}`;
          patterns.add(`/${path}`);
          patterns.add(`/${path}/**`);
        }
      }
      level = level === "/" ? `/${next}` : `${level}/${next}`;
    }
  }
  if (runnerDir !== undefined && runnerDir !== "/") {
    for (const entry of RUNNER_SECRET_ENTRIES) patterns.add(`/${runnerDir}/${entry}`);
  }

  const rules: string[] = [];
  for (const pattern of patterns) for (const tool of CLAUDE_TOOLS) rules.push(`${tool}(${pattern})`);
  return { rules, skipped, unlisted };
}

export type ClaudeQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeEngineOptions {
  config: Pick<ClaudeEngineConfig, "model" | "effort" | "max_turns" | "max_budget_usd">;
  /** From claudeEnv() in src/env.ts: the complete env for the wrapper. */
  env: EngineEnv;
  /** Absolute path of bin/as-agent-claude. */
  executable: string;
  /** The runner directory, denied to the read tools (credential files always explicitly). */
  runnerDir?: string;
  /** Other denied directories, e.g. $RUNNER_TEMP. */
  deniedDirs?: readonly string[];
  /** Default fs.readdirSync; injected in tests. */
  listDir?: ListDir;
  /** Injected for tests; default is the SDK's query(). */
  query?: ClaudeQuery;
  now?: () => number;
}

/** The exact SDK options for one call (§9). Exported for tests and audit. */
export function claudeOptions(
  opts: ClaudeEngineOptions,
  input: Pick<EngineInput<unknown>, "systemPrompt" | "outputSchema" | "cwd">,
  abortController: AbortController,
): Options {
  const deny = claudeDenyRules(input.cwd, {
    extraDirs: opts.deniedDirs ?? [],
    ...(opts.runnerDir !== undefined ? { runnerDir: opts.runnerDir } : {}),
    ...(opts.listDir !== undefined ? { listDir: opts.listDir } : {}),
  });
  return {
    cwd: input.cwd,
    model: opts.config.model,
    effort: opts.config.effort,
    systemPrompt: input.systemPrompt,
    tools: [...CLAUDE_TOOLS],
    allowedTools: [...CLAUDE_TOOLS],
    disallowedTools: [...CLAUDE_DISALLOWED_TOOLS, ...deny.rules],
    permissionMode: "dontAsk",
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: opts.config.max_turns,
    maxBudgetUsd: opts.config.max_budget_usd,
    abortController,
    outputFormat: { type: "json_schema", schema: input.outputSchema },
    pathToClaudeCodeExecutable: opts.executable,
    env: { ...opts.env },
  };
}

function usageOf(result: SDKResultMessage): EngineUsage {
  const u: EngineUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
  for (const m of Object.values(result.modelUsage)) {
    u.inputTokens += m.inputTokens;
    u.outputTokens += m.outputTokens;
    u.cachedInputTokens += m.cacheReadInputTokens;
    u.cacheWriteInputTokens += m.cacheCreationInputTokens;
    u.reasoningOutputTokens += m.thinkingTokens ?? 0;
  }
  return u;
}

export function createClaudeEngine(opts: ClaudeEngineOptions): Engine {
  const run = opts.query ?? (sdkQuery as ClaudeQuery);
  const now = opts.now ?? Date.now;

  return {
    name: "claude",
    async review<T>(input: EngineInput<T>, signal: AbortSignal): Promise<EngineResult<T>> {
      const startedAt = now();
      let model: string | null = null;
      let toolCalls = 0;
      let result: SDKResultMessage | undefined;
      let thrown: unknown;

      const ac = new AbortController();
      const onAbort = (): void => {
        ac.abort(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (!ac.signal.aborted) {
          for await (const msg of run({ prompt: input.prompt, options: claudeOptions(opts, input, ac) })) {
            if (msg.type === "assistant") {
              model ??= msg.message.model;
              for (const block of msg.message.content) {
                if (block.type === "tool_use" && block.name !== STRUCTURED_OUTPUT_TOOL) toolCalls++;
              }
            } else if (msg.type === "result") {
              result = msg;
            }
          }
        }
      } catch (err) {
        // A single-shot query() throws after yielding an error result; keep the result if any.
        thrown = err;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      const stats = {
        model: result !== undefined ? (Object.keys(result.modelUsage)[0] ?? model) : model,
        usage: result !== undefined ? usageOf(result) : null,
        costUsd: result !== undefined ? result.total_cost_usd : null,
        startedAt,
        now: now(),
        toolCalls,
        denials: result?.permission_denials.length ?? 0,
      };

      if (signal.aborted) {
        return failure("claude", engineError(abortKind(signal), `claude ${abortKind(signal)}`), stats);
      }
      if (result === undefined) {
        const message = `claude: ${thrown === undefined ? "no result message" : safeMessage(thrown)}`;
        return failure("claude", engineError(sdkErrorKind(message), message), stats);
      }
      if (result.subtype !== "success") {
        const detail = result.errors.length > 0 ? `: ${result.errors.join("; ")}` : "";
        const message = `claude ${result.subtype}${detail}`;
        const kind =
          result.subtype === "error_max_budget_usd" || result.subtype === "error_max_turns"
            ? "budget"
            : result.subtype === "error_max_structured_output_retries"
              ? "invalid_output"
              : sdkErrorKind(message);
        return failure("claude", engineError(kind, message), stats);
      }
      if (result.is_error) {
        // A turn that ended on an API error (usage limit, 401, …) is a "success" result with
        // is_error and the error text in `result` (SDKResultSuccess), not an error subtype. Only an
        // unavailable account is reclassified; any other error text keeps the invalid_output below.
        const message = `claude: ${safeMessage(result.result)}`;
        const unavailable = classifyUnavailable(message);
        if (unavailable !== null) return failure("claude", engineError(unavailable, message), stats);
      }
      if (result.structured_output === undefined || result.structured_output === null) {
        return failure("claude", engineError("invalid_output", "claude: run ended without structured output"), stats);
      }
      let output: T;
      try {
        output = input.parse(result.structured_output);
      } catch (err) {
        return failure("claude", engineError("invalid_output", `claude: ${safeMessage(err)}`), stats);
      }
      return {
        ok: true,
        engine: "claude",
        output,
        model: stats.model,
        usage: stats.usage,
        costUsd: stats.costUsd,
        durationMs: Math.max(0, stats.now - startedAt),
        toolCalls,
        denials: stats.denials,
      };
    },
  };
}

// USD price table for engines whose SDK reports tokens only (Codex, design.md §9).
// Claude's cost comes from the SDK's own estimate (`total_cost_usd`).
//
// Rates are USD per 1M tokens. Add a row only from a verified, dated source (the provider's API
// pricing page); an unknown model costs `null`, never a guess. Codex runs on subscription auth
// (§9.1), where a USD figure is not meaningful, so it has no rows: it reports tokens and a null
// cost.

import type { EngineUsage } from "../types.js";

export interface TokenRates {
  /** Uncached input tokens. */
  input: number;
  cachedInput: number;
  /** Cache writes; 0 where the provider does not charge them separately. */
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  output: number;
}

/** model id → rates. Keys are exact, lowercase model ids. */
export const PRICES: Readonly<Record<string, TokenRates>> = Object.freeze({});

/**
 * Tokens × rate, or null when the model or usage is unknown.
 * `inputTokens` is the total input count and includes cached tokens (Codex `input_tokens`).
 */
export function costUsd(
  model: string | null,
  usage: EngineUsage | null,
  prices: Readonly<Record<string, TokenRates>> = PRICES,
): number | null {
  if (model === null || usage === null) return null;
  const rates = prices[model.toLowerCase()];
  if (rates === undefined) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const total =
    uncached * rates.input +
    usage.cachedInputTokens * rates.cachedInput +
    usage.cacheWriteInputTokens * rates.cacheWrite +
    usage.outputTokens * rates.output;
  return Math.round((total / 1_000_000) * 1e6) / 1e6;
}

// Helpers shared by the engine adapters.

import { redact } from "../env.js";
import type { EngineError, EngineFailure, EngineName, EngineUsage } from "../types.js";

/** Longest error message an adapter reports (after redaction). */
export const MAX_ERROR_MESSAGE = 500;

export function emptyUsage(): EngineUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
}

export function addUsage(a: EngineUsage | null, b: EngineUsage | null): EngineUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/** Redacted, single-line, length-capped message. Never includes stack traces. */
export function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const line = redact(raw).replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_MESSAGE ? `${line.slice(0, MAX_ERROR_MESSAGE - 1)}…` : line;
}

/** "timeout" when the signal fired because of AbortSignal.timeout(), "aborted" otherwise. */
export function abortKind(signal: AbortSignal): "timeout" | "aborted" {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "aborted";
}

/** Kinds that mean the engine's account is unusable for this run, not that one call went wrong. */
export const UNAVAILABLE_KINDS = ["credential", "quota", "rate_limit", "auth"] as const satisfies readonly EngineError["kind"][];
export type UnavailableKind = (typeof UNAVAILABLE_KINDS)[number];

export function isUnavailableKind(kind: string | null | undefined): kind is UnavailableKind {
  return (UNAVAILABLE_KINDS as readonly string[]).includes(kind ?? "");
}

// Error texts from the Codex CLI (codex-rs protocol/error.rs, login refresh) and the OpenAI and
// Anthropic APIs. Checked in this order: a 429 that says "insufficient_quota" is a quota.
const QUOTA_RE =
  /usage limit|quota exceeded|exceeded your current quota|insufficient_quota|out of credits|spend cap|credit balance is too low|upgrade to (plus|pro)\b|(plan|subscription) (has )?expired/i;
const AUTH_RE =
  /\b40[13] (unauthorized|forbidden)\b|\bstatus:? 40[13]\b|\bunauthori[sz]ed\b|authentication_error|permission_error|invalid[ _-]api[ _-]key|incorrect api key|could not be refreshed|refresh token|(access|oauth) token (has )?expired|token_expired|invalid_grant|log out and sign in again|not logged in|please run \/login/i;
const RATE_RE = /rate[ _-]?limit|too many requests|\b429\b/i;

/** quota / auth / rate_limit from an SDK error text, or null for any other failure. */
export function classifyUnavailable(message: string): Exclude<UnavailableKind, "credential"> | null {
  if (QUOTA_RE.test(message)) return "quota";
  if (AUTH_RE.test(message)) return "auth";
  if (RATE_RE.test(message)) return "rate_limit";
  return null;
}

/** The kind for an SDK error: the classified unavailability, else "sdk_error". */
export function sdkErrorKind(message: string): EngineError["kind"] {
  return classifyUnavailable(message) ?? "sdk_error";
}

export function engineError(kind: EngineError["kind"], message: string): EngineError {
  return { kind, message: safeMessage(message) };
}

export interface FailureStats {
  model: string | null;
  usage: EngineUsage | null;
  costUsd: number | null;
  startedAt: number;
  now: number;
  toolCalls: number;
  denials: number;
}

export function failure(engine: EngineName, error: EngineError, s: FailureStats): EngineFailure {
  return {
    ok: false,
    engine,
    error,
    model: s.model,
    usage: s.usage,
    costUsd: s.costUsd,
    durationMs: Math.max(0, s.now - s.startedAt),
    toolCalls: s.toolCalls,
    denials: s.denials,
  };
}

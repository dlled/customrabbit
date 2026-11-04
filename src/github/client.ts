// GitHub client (design §8.1, §8.5 item 4).
//
// One Octokit instance authenticated with the App installation token (MYRABBIT_GITHUB_TOKEN,
// read once by src/env.ts). GITHUB_TOKEN is never used. A `request` wrap hook retries rate-limited
// calls, honouring `retry-after` and `x-ratelimit-reset`. Both REST and `octokit.graphql` go through
// the hook. A per-request `request: { signal }` aborts the fetch and any rate-limit wait.

import { Octokit } from "@octokit/rest";

import type { Secrets } from "../env.js";

export type GitHub = Octokit;

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RateLimitOptions {
  /** Retries per request after a rate-limit response (default 3). */
  maxRetries?: number;
  /** Longest single wait we accept; a longer one fails the call instead (default 120 s). */
  maxWaitMs?: number;
}

export interface GitHubClientOptions extends RateLimitOptions {
  /** API base URL (default https://api.github.com). */
  baseUrl?: string;
  /** Injected fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock in ms (tests). */
  now?: () => number;
  /** Called before each rate-limit wait; never receives headers or tokens. */
  onRateLimit?: (info: { method: string; url: string; waitMs: number; attempt: number }) => void;
}

export class RateLimitError extends Error {
  readonly waitMs: number;
  constructor(message: string, waitMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.waitMs = waitMs;
  }
}

const DEFAULT_SECONDARY_WAIT_MS = 60_000;

type Headers = Record<string, string | number | undefined>;

function header(headers: Headers | undefined, name: string): string | undefined {
  const v = headers?.[name];
  return v === undefined ? undefined : String(v);
}

/**
 * How long to wait before retrying, or null when the failure is not a rate limit.
 * - `retry-after` (seconds or HTTP date) wins;
 * - else `x-ratelimit-remaining: 0` + `x-ratelimit-reset` (epoch seconds): wait until reset + 1 s;
 * - else a 403/429 whose message mentions a (secondary) rate limit: 60 s, as GitHub documents.
 */
export function rateLimitDelayMs(
  status: number,
  headers: Headers | undefined,
  message: string,
  nowMs: number,
): number | null {
  if (status !== 403 && status !== 429 && status !== 200) return null;
  const retryAfter = header(headers, "retry-after");
  if (retryAfter !== undefined && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  const remaining = header(headers, "x-ratelimit-remaining");
  const reset = header(headers, "x-ratelimit-reset");
  if (remaining === "0" && reset !== undefined && /^\d+$/.test(reset)) {
    return Math.max(1000, Number(reset) * 1000 - nowMs + 1000);
  }
  if (status === 200) return null;
  if (status === 429 || /rate limit/i.test(message)) return DEFAULT_SECONDARY_WAIT_MS;
  return null;
}

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  response?: { headers?: Headers; data?: unknown };
}

function errorRateLimitDelay(e: unknown, nowMs: number): number | null {
  if (typeof e !== "object" || e === null) return null;
  const err = e as ErrorLike;
  if (typeof err.status !== "number") return null;
  const data = err.response?.data;
  const dataMessage =
    typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : "";
  const message = `${typeof err.message === "string" ? err.message : ""} ${dataMessage}`;
  return rateLimitDelayMs(err.status, err.response?.headers, message, nowMs);
}

/** GraphQL reports rate limits as HTTP 200 with `errors[].type == "RATE_LIMITED"`. */
function graphqlRateLimitDelay(response: { status: number; headers: Headers; data: unknown }, nowMs: number): number | null {
  const data = response.data;
  if (typeof data !== "object" || data === null) return null;
  const errors = (data as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  const limited = errors.some(
    (x) => typeof x === "object" && x !== null && (x as { type?: unknown }).type === "RATE_LIMITED",
  );
  if (!limited) return null;
  return rateLimitDelayMs(200, response.headers, "rate limit", nowMs) ?? DEFAULT_SECONDARY_WAIT_MS;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The error a request aborted by its own `request.signal` rejects with. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error("GitHub request aborted");
  e.name = "AbortError";
  return e;
}

/** `sleep(ms)`, cut short (rejecting) when `signal` aborts. The injected sleep need not know signals. */
async function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Build the client from the App installation token held in `secrets` (src/env.ts). */
export function createGitHubClient(secrets: Secrets, options: GitHubClientOptions = {}): GitHub {
  return createGitHubClientWithToken(secrets.githubToken, options);
}

/** Same as createGitHubClient, from a raw token (tests pass an obviously fake value). */
export function createGitHubClientWithToken(token: string, options: GitHubClientOptions = {}): GitHub {
  if (token.trim() === "") throw new Error("missing secret MYRABBIT_GITHUB_TOKEN");
  const maxRetries = options.maxRetries ?? 3;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const noop = (): void => undefined;

  const octokit = new Octokit({
    auth: token,
    userAgent: "myrabbit",
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch !== undefined ? { request: { fetch: options.fetch } } : {}),
    // Octokit's default logger writes to the console; myrabbit logs only through redacting helpers.
    log: { debug: noop, info: noop, warn: noop, error: noop },
  });

  octokit.hook.wrap("request", async (request, opts) => {
    // A per-request `request: { signal }` also cuts the rate-limit waits between retries.
    const signal = (opts.request as { signal?: AbortSignal } | undefined)?.signal;
    for (let attempt = 1; ; attempt++) {
      let waitMs: number | null;
      try {
        const response = await request(opts);
        waitMs = graphqlRateLimitDelay(response as { status: number; headers: Headers; data: unknown }, now());
        if (waitMs === null || attempt > maxRetries) return response;
      } catch (e) {
        waitMs = errorRateLimitDelay(e, now());
        if (waitMs === null || attempt > maxRetries) throw e;
      }
      if (waitMs > maxWaitMs) {
        throw new RateLimitError(
          `GitHub rate limit: retry in ${Math.ceil(waitMs / 1000)} s exceeds the ${Math.ceil(maxWaitMs / 1000)} s cap`,
          waitMs,
        );
      }
      options.onRateLimit?.({ method: opts.method, url: opts.url, waitMs, attempt });
      await abortableSleep(sleep, waitMs, signal);
    }
  });

  return octokit;
}

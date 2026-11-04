import { describe, expect, it } from "vitest";

import { RateLimitError, createGitHubClient, createGitHubClientWithToken, rateLimitDelayMs } from "../../src/github/client.js";
import { Secrets } from "../../src/env.js";
import { FAKE_TOKEN, REPO, prJson, testClient, type Reply } from "./helpers.js";

const NOW = 1_700_000_000_000;
const PR_PATH = "/repos/acme/widgets/pulls/7";

describe("rateLimitDelayMs", () => {
  it("prefers retry-after (seconds or date)", () => {
    expect(rateLimitDelayMs(403, { "retry-after": "7" }, "", NOW)).toBe(7000);
    expect(rateLimitDelayMs(429, { "retry-after": new Date(NOW + 3000).toUTCString() }, "", NOW)).toBe(3000);
  });

  it("waits until x-ratelimit-reset + 1 s when the quota is exhausted", () => {
    const reset = String(NOW / 1000 + 30);
    expect(rateLimitDelayMs(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "", NOW)).toBe(31_000);
    // A reset in the past still waits a little.
    expect(rateLimitDelayMs(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }, "", NOW)).toBe(1000);
  });

  it("uses 60 s for secondary limits without headers", () => {
    expect(rateLimitDelayMs(403, {}, "You have exceeded a secondary rate limit", NOW)).toBe(60_000);
    expect(rateLimitDelayMs(429, {}, "", NOW)).toBe(60_000);
  });

  it("is null for other failures", () => {
    expect(rateLimitDelayMs(403, {}, "Resource not accessible by integration", NOW)).toBeNull();
    expect(rateLimitDelayMs(404, { "retry-after": "1" }, "", NOW)).toBeNull();
    expect(rateLimitDelayMs(500, {}, "rate limit", NOW)).toBeNull();
    expect(rateLimitDelayMs(403, { "x-ratelimit-remaining": "10", "x-ratelimit-reset": "1" }, "Forbidden", NOW)).toBeNull();
  });
});

describe("GitHub client", () => {
  it("authenticates with the App token from Secrets, never GITHUB_TOKEN", async () => {
    const { server } = testClient();
    const secrets = new Secrets({ githubToken: FAKE_TOKEN, claudeOauthToken: "x", codexAuthJson: "{}" });
    const gh = createGitHubClient(secrets, { fetch: server.fetch });
    server.on("GET", PR_PATH, { body: prJson() });
    await gh.rest.pulls.get({ ...REPO, pull_number: 7 });
    expect(server.calls[0]?.headers.get("authorization")).toBe(`token ${FAKE_TOKEN}`);
    expect(server.calls[0]?.headers.get("user-agent")).toMatch(/^myrabbit/);
  });

  it("refuses an empty token", () => {
    expect(() => createGitHubClientWithToken(" ")).toThrow(/missing secret MYRABBIT_GITHUB_TOKEN/);
  });

  it("retries a rate-limited REST call after retry-after", async () => {
    const waits: number[] = [];
    const { gh, server, sleeps } = testClient({ onRateLimit: (i) => waits.push(i.waitMs) });
    server.on(
      "GET",
      PR_PATH,
      { status: 429, headers: { "retry-after": "2" }, body: { message: "slow down" } },
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 5) }, body: { message: "API rate limit exceeded" } },
      { body: prJson() },
    );
    const { data } = await gh.rest.pulls.get({ ...REPO, pull_number: 7 });
    expect(data.number).toBe(7);
    expect(sleeps).toEqual([2000, 6000]);
    expect(waits).toEqual([2000, 6000]);
    expect(server.calls).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const { gh, server, sleeps } = testClient({ maxRetries: 2 });
    server.on("GET", PR_PATH, { status: 429, headers: { "retry-after": "1" }, body: { message: "x" } });
    await expect(gh.rest.pulls.get({ ...REPO, pull_number: 7 })).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toEqual([1000, 1000]);
    expect(server.calls).toHaveLength(3);
  });

  it("fails fast when the wait exceeds the cap", async () => {
    const { gh, server, sleeps } = testClient({ maxWaitMs: 10_000 });
    server.on("GET", PR_PATH, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 3600) }, body: { message: "API rate limit exceeded" } });
    await expect(gh.rest.pulls.get({ ...REPO, pull_number: 7 })).rejects.toBeInstanceOf(RateLimitError);
    expect(sleeps).toEqual([]);
  });

  it("does not retry non-rate-limit errors", async () => {
    const { gh, server, sleeps } = testClient();
    server.on("GET", PR_PATH, { status: 403, body: { message: "Resource not accessible by integration" } });
    await expect(gh.rest.pulls.get({ ...REPO, pull_number: 7 })).rejects.toMatchObject({ status: 403 });
    expect(sleeps).toEqual([]);
    expect(server.calls).toHaveLength(1);
  });

  it("retries GraphQL RATE_LIMITED (HTTP 200 with errors)", async () => {
    const { gh, server, sleeps } = testClient();
    server.on(
      "POST",
      "/graphql",
      { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 9) }, body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } },
      { body: { data: { viewer: { login: "x" } } } },
    );
    const res = await gh.graphql<{ viewer: { login: string } }>("query { viewer { login } }");
    expect(res.viewer.login).toBe("x");
    expect(sleeps).toEqual([10_000]);
  });
});

describe("GitHub client abort (request.signal)", () => {
  /** A fetch that never answers until its signal aborts, as a slow network would. */
  function hangingFetch(seen: (AbortSignal | null | undefined)[]): typeof globalThis.fetch {
    return (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        seen.push(init?.signal);
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
  }

  it("aborts a request in flight", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const { gh } = testClient({ fetch: hangingFetch(seen) });
    const ac = new AbortController();
    const p = gh.rest.pulls.get({ ...REPO, pull_number: 7, request: { signal: ac.signal } });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("aborts a rate-limit wait and never retries", async () => {
    let sleeping: (() => void) | undefined;
    const started = new Promise<void>((r) => (sleeping = r));
    const { gh, server } = testClient({
      // Never resolves on its own: only the abort can end the wait.
      sleep: () => {
        sleeping?.();
        return new Promise<void>(() => undefined);
      },
    });
    server.on("GET", PR_PATH, { status: 429, headers: { "retry-after": "60" }, body: { message: "slow down" } }, { body: prJson() });
    const ac = new AbortController();
    const p = gh.rest.pulls.get({ ...REPO, pull_number: 7, request: { signal: ac.signal } });
    await started;
    ac.abort(new Error("budget spent"));
    await expect(p).rejects.toThrow("budget spent");
    expect(server.calls).toHaveLength(1);
  });

  it("a signal aborted during the request skips the wait", async () => {
    const { gh, server, sleeps } = testClient();
    const ac = new AbortController();
    server.on("GET", PR_PATH, (): Reply => {
      ac.abort();
      return { status: 429, headers: { "retry-after": "1" }, body: { message: "x" } };
    });
    await expect(gh.rest.pulls.get({ ...REPO, pull_number: 7, request: { signal: ac.signal } })).rejects.toThrow();
    expect(sleeps).toEqual([]);
    expect(server.calls).toHaveLength(1);
  });

  it("without a signal the wait is unchanged", async () => {
    const { gh, server, sleeps } = testClient();
    server.on("GET", PR_PATH, { status: 429, headers: { "retry-after": "1" }, body: { message: "x" } }, { body: prJson() });
    await gh.rest.pulls.get({ ...REPO, pull_number: 7 });
    expect(sleeps).toEqual([1000]);
  });
});

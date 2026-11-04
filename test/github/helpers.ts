// Offline HTTP mock for Octokit: an injected fetch that routes by method + path.
import { createGitHubClientWithToken, type GitHub, type GitHubClientOptions } from "../../src/github/client.js";

/** Obviously fake; never a real credential shape. */
export const FAKE_TOKEN = "fake-test-token-not-real";
export const REPO = { owner: "acme", repo: "widgets" };
export const BOT = "myrabbit[bot]";
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const OLD = "c".repeat(40);

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type Handler = (call: Call) => Reply | undefined;

export interface FakeServer {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  /** Add a handler for `METHOD /path` (string = exact path, RegExp = test); the newest matching handler wins. Replies are used in order; the last one repeats. */
  on(method: string, path: string | RegExp, ...replies: (Reply | Handler)[]): void;
}

export function fakeServer(): FakeServer {
  const routes: { method: string; path: string | RegExp; replies: (Reply | Handler)[]; used: number }[] = [];
  const calls: Call[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: raw !== undefined ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const route = routes.findLast(
      (r) => r.method === call.method && (typeof r.path === "string" ? r.path === call.path : r.path.test(call.path)),
    );
    if (!route) return Promise.resolve(new Response(JSON.stringify({ message: `no route ${call.method} ${call.path}` }), { status: 599 }));
    const next = route.replies[Math.min(route.used, route.replies.length - 1)];
    route.used++;
    const reply = (typeof next === "function" ? next(call) : next) ?? {};
    const status = reply.status ?? 200;
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...reply.headers },
    }));
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    on(method, path, ...replies) {
      routes.push({ method, path, replies, used: 0 });
    },
  };
}

export interface TestClient {
  gh: GitHub;
  server: FakeServer;
  sleeps: number[];
}

export function testClient(options: Partial<GitHubClientOptions> = {}): TestClient {
  const server = fakeServer();
  const sleeps: number[] = [];
  const gh = createGitHubClientWithToken(FAKE_TOKEN, {
    fetch: server.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 1_700_000_000_000,
    ...options,
  });
  return { gh, server, sleeps };
}

export function prJson(overrides: {
  state?: string;
  merged?: boolean;
  head?: string;
  headRepo?: string | null;
  author?: string;
} = {}): Record<string, unknown> {
  return {
    number: 7,
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    draft: false,
    title: "Add widgets",
    labels: [{ name: "enhancement" }],
    user: { login: overrides.author ?? "dlled" },
    html_url: "https://github.com/acme/widgets/pull/7",
    head: {
      sha: overrides.head ?? HEAD,
      ref: "feature",
      repo: overrides.headRepo === null ? null : { full_name: overrides.headRepo ?? "acme/widgets" },
    },
    base: { sha: BASE, ref: "main", repo: { full_name: "acme/widgets" } },
  };
}

// Shared fakes for the engine tests. Every credential here is an obviously fake value.

import { readFileSync } from "node:fs";
import { Secrets } from "../../src/env.js";
import type { EngineInput, EngineOutput } from "../../src/types.js";
import { parseEngineOutput, REVIEW_OUTPUT_SCHEMA } from "../../src/engines/schema.js";

export const FIXTURES = new URL("./fixtures/", import.meta.url);

export function reviewOutputFixture(): EngineOutput {
  return JSON.parse(readFileSync(new URL("review-output.json", FIXTURES), "utf8")) as EngineOutput;
}

/** An unsigned JWT-shaped string with the given exp (seconds). Not a real token. */
export function fakeJwt(expSeconds: number): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ exp: expSeconds, sub: "fake-user-0000" })}.fake-signature-0000`;
}

export const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

export function fakeSecrets(accessTokenExpMs: number = NOW_MS + 6 * 3600_000): Secrets {
  return new Secrets({
    githubToken: "fake-github-app-token-0000",
    claudeOauthToken: "fake-claude-oauth-token-0000",
    codexAuthJson: JSON.stringify({
      auth_mode: "chatgptAuthTokens",
      tokens: { access_token: fakeJwt(Math.floor(accessTokenExpMs / 1000)), refresh_token: "", account_id: "acct-fake-0000" },
    }),
  });
}

export function reviewEngineInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    task: "review",
    systemPrompt: "SYSTEM PART",
    prompt: "REVIEW PART",
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    parse: parseEngineOutput,
    cwd: "/work/repo",
    ...overrides,
  };
}

// Types for scripts/codex-auth.mjs (kept as plain JS so it runs on the Mac without a build).

export declare const MIN_PUBLISH_LIFETIME_MS: number;

export declare class CodexAuthError extends Error {
  constructor(message: string);
}

export interface DerivedCodexAuth {
  auth_mode: "chatgptAuthTokens";
  OPENAI_API_KEY: null;
  tokens: { id_token: string; access_token: string; refresh_token: ""; account_id: string };
  last_refresh: string;
}

export declare function jwtClaims(jwt: string): Record<string, unknown> | null;

export declare function deriveAccessTokenAuth(
  authJsonText: string,
  options?: { nowMs?: number; minLifetimeMs?: number },
): { json: DerivedCodexAuth; expiresAtMs: number };

export declare function fakeShape(derived: DerivedCodexAuth): DerivedCodexAuth;

export declare function refreshLogin(options: { codexBin?: string; codexHome: string; timeoutMs?: number }): Promise<void>;

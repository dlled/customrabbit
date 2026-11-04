// Secret and environment handling (design.md §2.2, §8.1, §9, §9.1).
//
// - The orchestrator reads its inputs exactly once:
//     MYRABBIT_GITHUB_TOKEN    GitHub App installation token (secret)
//     MYRABBIT_BOT_LOGIN       the App's bot login, e.g. "myrabbit[bot]"
//     CLAUDE_CODE_OAUTH_TOKEN  Claude subscription token (secret)    } exactly one of the two
//     ANTHROPIC_API_KEY        Anthropic API key (secret)            } when claude is selected
//     CODEX_AUTH_JSON          Codex auth.json, access-token-only form (secret) } exactly one of the
//     OPENAI_API_KEY           OpenAI API key (secret)                          } two for codex
//     MYRABBIT_ENGINES         optional "both" (default) | "claude" | "codex"
//     MYRABBIT_ISOLATION       optional "guest-users" (default) | "none"
//     MYRABBIT_PR              optional PR number override
//     MYRABBIT_TRUSTED_AUTHORS required comma-separated logins, no default (not a secret)
//   GITHUB_TOKEN is never read as an input.
// - A missing or empty required value fails closed before any model call; values are never printed.
//   Both credentials of one engine set at once is an error too: a repository never switches
//   between subscription and API billing silently.
// - The secrets are deleted from process.env immediately, so nothing spawned later inherits them.
// - Each engine gets an allowlisted env with only its own credential: never the App token,
//   GITHUB_TOKEN, the other engine's credential, or ACTIONS_* / GITHUB_* / RUNNER_* variables.
// - redact() replaces every captured secret value (and common token shapes) with ***.

import { lstatSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { inspect } from "node:util";

export const SECRET_NAMES = [
  "MYRABBIT_GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CODEX_AUTH_JSON",
  "OPENAI_API_KEY",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * What a MissingSecretError names: a single variable, or an engine's two alternatives
 * ("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY").
 */
export type RequiredName = string;

/** The credential pair of each engine: [subscription form, API key]. Exactly one is used. */
export const ENGINE_CREDENTIALS = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_AUTH_JSON", "OPENAI_API_KEY"],
} as const satisfies Record<string, readonly [SecretName, SecretName]>;

export type SelectedEngine = keyof typeof ENGINE_CREDENTIALS;
/** MYRABBIT_ENGINES values. */
export const ENGINE_SELECTIONS = ["both", "claude", "codex"] as const;
/** MYRABBIT_ISOLATION values (design.md §9.2; "none" runs the engines as the runner user). */
export const ISOLATION_MODES = ["guest-users", "none"] as const;
export type Isolation = (typeof ISOLATION_MODES)[number];

/** Runner credentials we never use but must never leak; captured for redaction only. */
export const AMBIENT_SECRET_NAMES = [
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_TOKEN",
] as const;

/** Any other env var whose name looks like a credential is also captured for redaction. */
export const SECRET_LIKE_NAME = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)$/i;

export const REDACTED = "***";

/** Codex is skipped when its access token expires within this window (§9.1 step 4). */
export const CODEX_MIN_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

export class MissingSecretError extends Error {
  readonly names: RequiredName[];
  constructor(names: RequiredName[]) {
    super(`missing secret ${names.join(", ")}`);
    this.name = "MissingSecretError";
    this.names = names;
  }
}

export class InvalidEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvError";
  }
}

/** The loud error for an engine given both of its credentials. Names only, never values. */
export function bothSetMessage(engine: SelectedEngine): string {
  const [subscription, apiKey] = ENGINE_CREDENTIALS[engine];
  return `both ${apiKey} and ${subscription} are set; pass exactly one`;
}

/**
 * Holds the secrets. Values are only reachable through getters, so JSON.stringify,
 * util.inspect, console.log and spreading never reveal them.
 */
export class Secrets {
  readonly #githubToken: string;
  readonly #claudeOauthToken: string;
  readonly #anthropicApiKey: string;
  readonly #codexAuthJson: string;
  readonly #openaiApiKey: string;

  /** Each engine has at most one credential (loadRuntimeEnv enforces it with a clear error). */
  constructor(values: {
    githubToken: string;
    claudeOauthToken?: string;
    anthropicApiKey?: string;
    codexAuthJson?: string;
    openaiApiKey?: string;
  }) {
    this.#githubToken = values.githubToken;
    this.#claudeOauthToken = values.claudeOauthToken ?? "";
    this.#anthropicApiKey = values.anthropicApiKey ?? "";
    this.#codexAuthJson = values.codexAuthJson ?? "";
    this.#openaiApiKey = values.openaiApiKey ?? "";
    if (this.#claudeOauthToken !== "" && this.#anthropicApiKey !== "") throw new InvalidEnvError(bothSetMessage("claude"));
    if (this.#codexAuthJson !== "" && this.#openaiApiKey !== "") throw new InvalidEnvError(bothSetMessage("codex"));
  }

  /** GitHub App installation token; orchestrator only, never given to an engine. */
  get githubToken(): string {
    return this.#githubToken;
  }
  /** CLAUDE_CODE_OAUTH_TOKEN, or ""; Claude engine only. */
  get claudeOauthToken(): string {
    return this.#claudeOauthToken;
  }
  /** ANTHROPIC_API_KEY, or ""; Claude engine only. */
  get anthropicApiKey(): string {
    return this.#anthropicApiKey;
  }
  /** Raw CODEX_AUTH_JSON, or "", to be written to $CODEX_HOME/auth.json (0600); Codex engine only. */
  get codexAuthJson(): string {
    return this.#codexAuthJson;
  }
  /** OPENAI_API_KEY, or "", given to `codex login --with-api-key` on stdin; Codex engine only. */
  get openaiApiKey(): string {
    return this.#openaiApiKey;
  }
  /** Which Claude credential is present, if any. */
  get claudeAuth(): "oauth" | "api_key" | null {
    return this.#anthropicApiKey !== "" ? "api_key" : this.#claudeOauthToken !== "" ? "oauth" : null;
  }
  /** Which Codex credential is present, if any. */
  get codexAuth(): "auth_json" | "api_key" | null {
    return this.#openaiApiKey !== "" ? "api_key" : this.#codexAuthJson !== "" ? "auth_json" : null;
  }

  toJSON(): string {
    return "[Secrets]";
  }
  toString(): string {
    return "[Secrets]";
  }
  [inspect.custom](): string {
    return "[Secrets]";
  }
}

export interface RuntimeEnv {
  secrets: Secrets;
  /** Login of the bot whose reviews are ours (§8.1). */
  botLogin: string;
  /** MYRABBIT_PR, when set; otherwise the PR comes from the event payload. */
  prNumber: number | null;
  /** MYRABBIT_TRUSTED_AUTHORS (comma-separated logins), required: no author is trusted by default (§10.1). */
  trustedAuthors: string[];
  /** MYRABBIT_ENGINES: the engines this job may run (each has exactly one credential). */
  engines: SelectedEngine[];
  /** MYRABBIT_ISOLATION, default "guest-users". */
  isolation: Isolation;
}

/**
 * Unset or empty → `fallback`; any other value must be one of `allowed` exactly, untrimmed: the
 * action's `if: inputs.isolation != 'none'` compares exactly too, so " none" must not mean none.
 */
function parseChoice<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new InvalidEnvError(`invalid ${name}: expected one of ${allowed.join(", ")}`);
  return raw as T;
}

/** Names the secrets file written by the action's node step (action.yml). */
export const SECRETS_FILE_VAR = "MYRABBIT_SECRETS_FILE";

/** The loud error for isolation "none" with both engines (may be relaxed later). */
export const NONE_NEEDS_ONE_ENGINE =
  "isolation none allows one engine: set engines to claude or codex (with both, the two engines would run as the same user and could read each other's credentials)";

/**
 * Reads and removes the secrets file (NUL-separated `NAME=value` records; a value may contain
 * newlines, never NUL). The file and its fresh directory are removed before anything is parsed,
 * so a malformed file is never left behind for a same-user engine (isolation "none") to read.
 * Only SECRET_NAMES are accepted.
 */
function readSecretsFile(path: string): Partial<Record<SecretName, string>> {
  let raw: string | null = null;
  try {
    // A regular file, not a symlink to something else.
    if (lstatSync(path).isFile()) raw = readFileSync(path, "utf8");
  } catch {
    raw = null;
  } finally {
    rmSync(path, { force: true });
    // Its directory is the step's fresh mktemp dir; rmdir only removes it when empty.
    if (basename(dirname(path)).startsWith("myrabbit-secrets.")) {
      try {
        rmdirSync(dirname(path));
      } catch {
        // not empty or already gone: left alone
      }
    }
  }
  if (raw === null) throw new InvalidEnvError(`${SECRETS_FILE_VAR} could not be read`);
  const out: Partial<Record<SecretName, string>> = {};
  for (const record of raw.split("\0")) {
    if (record === "") continue;
    const eq = record.indexOf("=");
    const name = eq < 0 ? record : record.slice(0, eq);
    if (eq < 0 || !(SECRET_NAMES as readonly string[]).includes(name)) {
      throw new InvalidEnvError(`${SECRETS_FILE_VAR} has an unexpected record`);
    }
    out[name as SecretName] = record.slice(eq + 1);
  }
  return out;
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** The loud error for an unset or empty MYRABBIT_TRUSTED_AUTHORS: nobody is trusted by default. */
export const TRUSTED_AUTHORS_REQUIRED = "MYRABBIT_TRUSTED_AUTHORS is required: the comma-separated PR authors to review";

/**
 * Required, with no default: a composite action's `required: true` is not enforced by GitHub, so a
 * missing input arrives as "" and must fail here, never fall back to some login. Whitespace around
 * entries and empty entries are ignored; nothing left (e.g. "  , ") is the same error.
 */
function parseTrustedAuthors(raw: string | undefined): string[] {
  const logins = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (logins.length === 0) throw new InvalidEnvError(TRUSTED_AUTHORS_REQUIRED);
  if (!logins.every((l) => LOGIN.test(l))) {
    throw new InvalidEnvError("invalid MYRABBIT_TRUSTED_AUTHORS");
  }
  return [...new Set(logins)];
}

// ---------------------------------------------------------------------------
// Redaction registry
// ---------------------------------------------------------------------------

const knownSecrets = new Set<string>();
let loaded = false;

/** Shapes of credentials we never want in a log, even if they were not captured here. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic PAT / OAuth / user-to-server / server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic API key / OAuth token
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI (sk-, sk-proj-, sk-svcacct-, …)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Values shorter than this (after trimming) are never registered: masking "1" or "true" would
 * mangle line numbers and anchors everywhere. Real credentials are far longer, and token patterns
 * still apply regardless.
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * Adds a value to the redaction set, e.g. a credential minted at runtime.
 * Values shorter than MIN_SECRET_LENGTH after trimming are ignored.
 */
export function registerSecret(value: string): void {
  if (value.trim().length >= MIN_SECRET_LENGTH) knownSecrets.add(value);
}

/** Every secret value captured so far (inputs, their JSON sub-tokens, runner credentials). */
export function secretValues(): string[] {
  return [...knownSecrets];
}

/** Replaces every captured secret value and every known token shape with `***`. */
export function redact(text: string): string {
  let out = text;
  // Longest first, so a secret that contains another is removed whole.
  const values = [...knownSecrets].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(REDACTED);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Test-only: forget captured secrets so loadRuntimeEnv() can run again. */
export function resetSecretsForTests(): void {
  knownSecrets.clear();
  loaded = false;
}

// ---------------------------------------------------------------------------
// Codex auth.json
// ---------------------------------------------------------------------------

interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token: string | null;
}

/** Extracts the token strings from auth.json (`{ tokens: { access_token, … } }`), or null. */
function parseCodexTokens(authJson: string): CodexTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (typeof tokens !== "object" || tokens === null) return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token === "") return null;
  return {
    access_token: t.access_token,
    refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
    // id_token is a JWT string on disk.
    id_token: typeof t.id_token === "string" ? t.id_token : null,
  };
}

/** JWT `exp` in ms, or null. Never logs or returns the token. */
function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (payload === undefined || payload === "") return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export type CodexCredentialStatus =
  | { usable: true; expiresAtMs: number }
  | { usable: false; reason: "malformed" | "expired" | "expiring" };

/**
 * Checks CODEX_AUTH_JSON before starting Codex (§9.1 step 4). Not usable if malformed, expired,
 * or expiring within 15 minutes; the caller then skips Codex as an engine failure.
 */
export function codexCredentialStatus(secrets: Secrets, nowMs: number): CodexCredentialStatus {
  // An API key does not expire on a schedule we can read; Codex checks it on the first request.
  if (secrets.codexAuth === "api_key") return { usable: true, expiresAtMs: Number.POSITIVE_INFINITY };
  const tokens = parseCodexTokens(secrets.codexAuthJson);
  if (tokens === null) return { usable: false, reason: "malformed" };
  const exp = jwtExpiryMs(tokens.access_token);
  if (exp === null) return { usable: false, reason: "malformed" };
  if (exp <= nowMs) return { usable: false, reason: "expired" };
  if (exp - nowMs < CODEX_MIN_TOKEN_LIFETIME_MS) return { usable: false, reason: "expiring" };
  return { usable: true, expiresAtMs: exp };
}

export function codexTokenUsable(secrets: Secrets, nowMs: number): boolean {
  return codexCredentialStatus(secrets, nowMs).usable;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * Reads the runtime inputs once, deletes the secrets from `env`, and captures every secret value
 * (plus runner credentials such as GITHUB_TOKEN, if present) for redaction.
 * Throws MissingSecretError (naming, never printing) if a required value is missing, empty or
 * whitespace, and InvalidEnvError for a malformed MYRABBIT_BOT_LOGIN or MYRABBIT_PR.
 * The secrets are deleted from `env` even when it throws.
 */
export function loadRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  if (loaded) throw new Error("secrets already loaded");

  // The action passes the secrets in a file, never in the process environment (action.yml). Without
  // MYRABBIT_SECRETS_FILE (tests, a local run) they come from `env`. With it, `env` copies are only
  // deleted and redacted, never used.
  const filePath = env[SECRETS_FILE_VAR];
  Reflect.deleteProperty(env, SECRETS_FILE_VAR);
  let fromFile: Partial<Record<SecretName, string>> | null = null;
  let fileError: InvalidEnvError | null = null;
  if (filePath !== undefined && filePath !== "") {
    try {
      fromFile = readSecretsFile(filePath);
    } catch (err) {
      // Thrown once the env copies are deleted and redacted below; never a silent fallback to env.
      fileError = err instanceof InvalidEnvError ? err : new InvalidEnvError(`${SECRETS_FILE_VAR} could not be read`);
      fromFile = {};
    }
  }

  const take = (name: SecretName): string => {
    const inEnv = env[name] ?? "";
    Reflect.deleteProperty(env, name);
    registerSecret(inEnv);
    registerSecret(inEnv.trim());
    const raw = fromFile === null ? inEnv : (fromFile[name] ?? "");
    // A pasted secret often carries a trailing newline: use the trimmed value, redact both forms.
    registerSecret(raw);
    return raw.trim();
  };
  const values = {
    MYRABBIT_GITHUB_TOKEN: take("MYRABBIT_GITHUB_TOKEN"),
    CLAUDE_CODE_OAUTH_TOKEN: take("CLAUDE_CODE_OAUTH_TOKEN"),
    ANTHROPIC_API_KEY: take("ANTHROPIC_API_KEY"),
    CODEX_AUTH_JSON: take("CODEX_AUTH_JSON"),
    OPENAI_API_KEY: take("OPENAI_API_KEY"),
  } satisfies Record<SecretName, string>;

  // Capture before validating, so a partially provided set is still redacted.
  for (const value of Object.values(values)) registerSecret(value);
  const codexTokens = parseCodexTokens(values.CODEX_AUTH_JSON);
  if (codexTokens !== null) {
    registerSecret(codexTokens.access_token);
    registerSecret(codexTokens.refresh_token);
    if (codexTokens.id_token !== null) registerSecret(codexTokens.id_token);
  }
  // Runner credentials stay in env (the runner may need them) but are captured for redaction:
  // an engine could read them from the parent process and echo them into a finding.
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((AMBIENT_SECRET_NAMES as readonly string[]).includes(name) || SECRET_LIKE_NAME.test(name)) {
      registerSecret(value);
      registerSecret(value.trim());
    }
  }
  if (fileError !== null) throw fileError;

  const selection = parseChoice("MYRABBIT_ENGINES", env.MYRABBIT_ENGINES, ENGINE_SELECTIONS, "both");
  const engines: SelectedEngine[] = selection === "both" ? ["claude", "codex"] : [selection];
  const isolation = parseChoice("MYRABBIT_ISOLATION", env.MYRABBIT_ISOLATION, ISOLATION_MODES, "guest-users");
  // Under isolation none both engines would share the runner user, so either could read the other's
  // credential from /proc or its CODEX_HOME: one engine only, chosen explicitly.
  if (isolation === "none" && engines.length > 1) throw new InvalidEnvError(NONE_NEEDS_ONE_ENGINE);

  // Each selected engine needs exactly one of its two credentials. Both set is never resolved by
  // picking one: the run fails before any model call. An unselected engine's credentials are
  // still deleted and redacted above, and never reach anything.
  for (const engine of engines) {
    const [subscription, apiKey] = ENGINE_CREDENTIALS[engine];
    if (values[subscription] !== "" && values[apiKey] !== "") throw new InvalidEnvError(bothSetMessage(engine));
  }
  const botLogin = (env.MYRABBIT_BOT_LOGIN ?? "").trim();
  const missing: RequiredName[] = [];
  if (values.MYRABBIT_GITHUB_TOKEN === "") missing.push("MYRABBIT_GITHUB_TOKEN");
  for (const engine of engines) {
    const [subscription, apiKey] = ENGINE_CREDENTIALS[engine];
    if (values[subscription] === "" && values[apiKey] === "") missing.push(`${subscription} or ${apiKey}`);
  }
  if (botLogin === "") missing.push("MYRABBIT_BOT_LOGIN");
  if (missing.length > 0) throw new MissingSecretError(missing);
  if (!BOT_LOGIN.test(botLogin)) throw new InvalidEnvError("invalid MYRABBIT_BOT_LOGIN");

  const prRaw = (env.MYRABBIT_PR ?? "").trim();
  let prNumber: number | null = null;
  if (prRaw !== "") {
    if (!/^[1-9][0-9]{0,9}$/.test(prRaw)) throw new InvalidEnvError("invalid MYRABBIT_PR");
    prNumber = Number(prRaw);
  }
  const trustedAuthors = parseTrustedAuthors(env.MYRABBIT_TRUSTED_AUTHORS);

  loaded = true;
  return {
    secrets: new Secrets({
      githubToken: values.MYRABBIT_GITHUB_TOKEN,
      ...(engines.includes("claude") ? { claudeOauthToken: values.CLAUDE_CODE_OAUTH_TOKEN, anthropicApiKey: values.ANTHROPIC_API_KEY } : {}),
      ...(engines.includes("codex") ? { codexAuthJson: values.CODEX_AUTH_JSON, openaiApiKey: values.OPENAI_API_KEY } : {}),
    }),
    botLogin,
    prNumber,
    trustedAuthors,
    engines,
    isolation,
  };
}

// ---------------------------------------------------------------------------
// Per-engine envs (§9, §9.2). Both SDKs REPLACE the child env with what they are given, so the
// objects below are the complete env handed to the engine's wrapper (bin/as-agent-{claude,codex}).
// The wrapper reads MYRABBIT_{CLAUDE,CODEX}_BIN for the real binary, then runs it as that engine's
// own guest user (myrabbit-claude / myrabbit-codex) through `sudo --preserve-env=<allowlist>`, so
// only the allowlisted variables reach the engine. With isolation "none" there is no wrapper: the
// SDK runs the real binary as the runner user with the same env minus the *_BIN variable.
// ---------------------------------------------------------------------------

export type EngineEnv = Record<string, string>;

/** Default HOME for claudeEnv: myrabbit-claude's own home, never the runner's HOME. */
export const CLAUDE_AGENT_HOME = "/home/myrabbit-claude";
/** Default HOME for codexEnv: myrabbit-codex's own home, never the runner's HOME. */
export const CODEX_AGENT_HOME = "/home/myrabbit-codex";

/**
 * Variables `bin/as-agent-claude` passes to the Claude CLI via `sudo --preserve-env`. Exactly one
 * of CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY is ever set (Secrets enforces it).
 */
export const CLAUDE_AGENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
] as const;

/** Variables `bin/as-agent-codex` passes to the Codex CLI via `sudo --preserve-env`. */
export const CODEX_AGENT_ENV_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME"] as const;

/** Wrapper-only variables naming the real binary; never in an allowlist. */
export const CLAUDE_BIN_VAR = "MYRABBIT_CLAUDE_BIN";
export const CODEX_BIN_VAR = "MYRABBIT_CODEX_BIN";

export interface AgentEnvOptions {
  /** Absolute path of the real native CLI binary in node_modules. */
  realBin: string;
  /** Default CLAUDE_AGENT_HOME (claudeEnv) or CODEX_AGENT_HOME (codexEnv). */
  agentHome?: string;
  /** Source of PATH only; default process.env. */
  parent?: NodeJS.ProcessEnv;
  /**
   * Default true: the env is for bin/as-agent-*, so it names the real binary in *_BIN. False
   * (isolation "none"): the SDK runs `realBin` itself and the variable is left out.
   */
  wrapper?: boolean;
}

function absolute(name: string, value: string): string {
  if (!value.startsWith("/")) throw new InvalidEnvError(`${name} must be an absolute path`);
  return value;
}

/** PATH from the parent, HOME = agent home. Nothing else is ever copied from the parent env. */
function baseEnv(options: AgentEnvOptions, defaultHome: string): { PATH: string; HOME: string } {
  const parent = options.parent ?? process.env;
  return {
    PATH: parent.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: absolute("agentHome", options.agentHome ?? defaultHome),
  };
}

/**
 * Claude Agent SDK `options.env`: CLAUDE_AGENT_ENV_ALLOWLIST plus MYRABBIT_CLAUDE_BIN (wrapper only).
 * Exactly one credential: ANTHROPIC_API_KEY when the job passed one, otherwise
 * CLAUDE_CODE_OAUTH_TOKEN (the API key would take precedence over the token, so never both).
 * ANTHROPIC_AUTH_TOKEN is never present.
 */
export function claudeEnv(secrets: Secrets, options: AgentEnvOptions & { clientApp: string }): EngineEnv {
  const auth = secrets.claudeAuth;
  if (auth === null) throw new InvalidEnvError("claude has no credential");
  const credential: Partial<Record<(typeof CLAUDE_AGENT_ENV_ALLOWLIST)[number], string>> =
    auth === "api_key" ? { ANTHROPIC_API_KEY: secrets.anthropicApiKey } : { CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeOauthToken };
  return {
    ...baseEnv(options, CLAUDE_AGENT_HOME),
    ...credential,
    CLAUDE_AGENT_SDK_CLIENT_APP: options.clientApp,
    ...(options.wrapper === false ? {} : { [CLAUDE_BIN_VAR]: absolute("realBin", options.realBin) }),
  };
}

/**
 * Codex SDK `new Codex({ env })` (no apiKey): CODEX_AGENT_ENV_ALLOWLIST plus MYRABBIT_CODEX_BIN
 * (wrapper only). The credential reaches Codex only as $CODEX_HOME/auth.json: written from
 * `secrets.codexAuthJson`, or by `codex login --with-api-key` from `secrets.openaiApiKey`.
 * `codexHome` must be a fresh mkdtemp directory so no user config or AGENTS.md is loaded.
 */
export function codexEnv(options: AgentEnvOptions & { codexHome: string }): EngineEnv {
  if (options.codexHome.trim() === "") throw new Error("codexHome must be a fresh temp directory");
  return {
    ...baseEnv(options, CODEX_AGENT_HOME),
    CODEX_HOME: absolute("codexHome", options.codexHome),
    ...(options.wrapper === false ? {} : { [CODEX_BIN_VAR]: absolute("realBin", options.realBin) }),
  } satisfies Partial<Record<(typeof CODEX_AGENT_ENV_ALLOWLIST)[number] | typeof CODEX_BIN_VAR, string>>;
}

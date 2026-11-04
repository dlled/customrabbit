// Public surface of the engines module (design.md §5.1, §9).

export {
  createClaudeEngine,
  claudeOptions,
  claudeDenyRules,
  runnerRootFromTemp,
  RUNNER_SECRET_ENTRIES,
  type ClaudeEngineOptions,
  type ClaudeQuery,
  type DenyRuleOptions,
  type DenyRules,
  type ListDir,
} from "./claude.js";
export { CLAUDE_AGENT_HOME, CLAUDE_AGENT_USER, CODEX_AGENT_HOME, CODEX_AGENT_USER } from "./users.js";
export {
  createCodexEngine,
  codexClientOptions,
  codexThreadOptions,
  CODEX_CONFIG,
  type CodexEngineOptions,
  type CodexFactory,
} from "./codex.js";
export { CODEX_API_KEY_CONFIG, prepareCodexHome, type CodexHome, type PrepareCodexHomeOptions } from "./codex-home.js";
export { costUsd, PRICES, type TokenRates } from "./prices.js";
export {
  engineTimeoutMs,
  resolveFinding,
  reviewInput,
  runBoth,
  runEngine,
  verifierFor,
  verifyFinding,
  type CallOptions,
  type RunOptions,
} from "./run.js";
export {
  parseEngineOutput,
  parseResolveOutput,
  parseVerifyOutput,
  OutputValidationError,
  RESOLVE_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  VERIFY_OUTPUT_SCHEMA,
} from "./schema.js";

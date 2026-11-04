// Guest users the engine CLIs run as (design.md §9.2): one per engine, so neither engine can read
// the other's /proc/<pid>/environ or credential files. Single source for bin/as-agent-*,
// action.yml (useradd, setfacl) and the S1 checks; test/engines/wrappers.test.ts keeps the
// wrappers in sync.

export const CLAUDE_AGENT_USER = "myrabbit-claude";
export const CODEX_AGENT_USER = "myrabbit-codex";

/**
 * design-v2 §7.3: the static-analysis tools run as a third guest user through bin/as-tools. It has
 * no access to the workspace, $RUNNER_TEMP or the runner directory (action.yml "Create
 * static-analysis guest user"), only read/execute on the staging and tool dirs under /tmp.
 */
export const TOOLS_USER = "myrabbit-tools";

/** Each user's own HOME: the claudeEnv / codexEnv defaults, defined in src/env.ts. */
export { CLAUDE_AGENT_HOME, CODEX_AGENT_HOME } from "../env.js";

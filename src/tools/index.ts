// Static analysis (design-v2 §7). Owned by P6.
//
// Pinned linters run as the `myrabbit-tools` guest user over changed files staged from git blobs.
// The result feeds three generic contracts that P0 added:
// - `info.hits` go to the engines as the untrusted `<static-analysis>` block (and the run document);
// - `support` goes to mergeReview's `externalSupport` (§7.4.3);
// - `blockers` go to computeVerdict's `syntheticBlockers` (§7.5: secret hit, secret scan not run).
//
// Flow, per enabled tool that understands at least one staged file:
//   install manifest → §7.1 command → bin/as-tools (60 s) → exit-code check → parse → normalise.
// Then: keep hits on the diff's added/context lines (§7.4.1); drop every other tool's hit on a line
// gitleaks flagged (§7.4.5); a gitleaks hit on an added line is a critical secret blocker (§7.5);
// order by tool severity and cap at 50. gitleaks fails closed: when it is enabled and files are in
// scope, any failure to install or run it is a blocking coverage item, and so is a changed regular
// file it could not see (over 1 MiB, unreadable, unstageable path) or a leak it reports that
// cannot be placed. Every other tool fails soft.

import type { TreeIndex } from "../context/git.js";
import type { GitRunner } from "../github/git.js";
import type { ExternalSupport } from "../merge/types.js";
import type { SyntheticBlocker } from "../merge/verdict.js";
import {
  MAX_RUN_TOOL_HITS,
  TOOL_NAMES,
  type MergedFinding,
  type RunToolsInfo,
  type ToolHit,
  type ToolName,
  type ToolRun,
  type ToolsConfig,
} from "../types.js";
import { OK_EXIT_CODES, toolCommand, toolHandles } from "./commands.js";
import { execTool, type ToolExec } from "./exec.js";
import type { InstallFailure, ToolsManifest } from "./install.js";
import { parseToolOutput, ParseError, type RawHit } from "./normalise.js";
import { removeStage, stageFiles } from "./stage.js";

export { installTools, readToolsManifest, removeTools, type ToolsManifest } from "./install.js";
export { parseToolsLock, type ToolsLock } from "./lock.js";

/** A leak flags at most this many lines after its first (§7.4.5). */
const MAX_FLAGGED_SPAN = 200;

/** §7.1 per-tool timeout. */
export const TOOL_TIMEOUT_MS = 60_000;

export interface StaticAnalysisInput {
  config: ToolsConfig;
  /** Head tree: files are read only as blobs (§1.1). */
  tree: TreeIndex;
  /** The checkout's git (the one `tree` was listed with): tells binary blobs from unreadable ones. */
  git: GitRunner;
  /** Changed paths in review scope (after path_filters). */
  paths: readonly string[];
  /** From the install process; null when the install did not produce one (every tool failed). */
  manifest: ToolsManifest | null;
  /** Absolute path of bin/as-tools. */
  asTools: string;
  /** Contents of tools/config/ruff-select.txt. */
  ruffSelect: string;
  /** Head-side (RIGHT) line is an added or context line of the reviewed diff. */
  inDiff: (path: string, line: number) => boolean;
  /** Head-side line is an added line. */
  isAdded: (path: string, line: number) => boolean;
  signal?: AbortSignal;
  /** Injected for tests. */
  exec?: ToolExec;
  /** Parent of the staging mkdtemp; default /tmp. */
  tmpBase?: string;
}

export interface StaticAnalysisResult {
  /** Run-document `tools` field. */
  info: RunToolsInfo;
  support: ExternalSupport[];
  blockers: SyntheticBlocker[];
  /** One-line body notes for tools that failed soft. */
  notes: string[];
}

/** Tools on in the config (all off when `tools.enabled` is false). */
export function enabledTools(config: ToolsConfig): ToolName[] {
  return config.enabled ? TOOL_NAMES.filter((t) => config[t].enabled) : [];
}

const INSTALL_REASON: Record<InstallFailure, string> = {
  download: "download failed",
  sha256: "sha256 mismatch against tools.lock",
  extract: "install failed",
};

const TOOL_ORDER = new Map(TOOL_NAMES.map((t, i) => [t, i]));

/** Strips what could break a code span or a line from a PR path shown in a title. */
const titlePath = (p: string): string => p.replace(/[`\r\n\0]/g, "");

interface ToolOutcome {
  run: ToolRun;
  hits: RawHit[];
  /** Set when the tool did not run or its output is unusable. */
  failure: string | null;
}

/**
 * Runs the enabled tools over the changed files. Returns null when static analysis is off. Never
 * throws for a tool failure; the staging dir is always removed.
 */
export async function runStaticAnalysis(input: StaticAnalysisInput): Promise<StaticAnalysisResult | null> {
  const tools = enabledTools(input.config);
  if (tools.length === 0) return null;
  const exec = input.exec ?? execTool;
  const stage = await stageFiles(input.tree, input.paths, input.git, input.tmpBase);
  try {
    const outcomes = new Map<ToolName, ToolOutcome>();
    for (const tool of tools) {
      outcomes.set(tool, await runOne(tool, input, stage.root, [...stage.files.entries()], exec));
    }
    return assemble(input, outcomes, tools.includes("gitleaks") ? stage.uncovered.length : 0);
  } finally {
    await removeStage(stage.root);
  }
}

async function runOne(
  tool: ToolName,
  input: StaticAnalysisInput,
  stageRoot: string,
  staged: [string, { abs: string; firstLine: string }][],
  exec: ToolExec,
): Promise<ToolOutcome> {
  const files = staged.filter(([p, f]) => toolHandles(tool, p, f.firstLine)).map(([, f]) => f.abs);
  if (files.length === 0) return { run: { tool, status: "skipped", files: 0 }, hits: [], failure: null };
  const m = input.manifest;
  const failed = m?.failed[tool];
  if (m === null || failed !== undefined || m.installed[tool] === undefined) {
    const status = failed === "sha256" ? "unverified" : "error";
    return { run: { tool, status, files: files.length }, hits: [], failure: failed ? INSTALL_REASON[failed] : "not installed" };
  }
  const cmd = toolCommand(
    tool,
    { root: m.root, stage: stageRoot, files, shellcheck: m.installed.shellcheck ?? null },
    input.ruffSelect,
  );
  const cwd = `${m.root}/cwd`;
  const r = await exec(cmd, { asTools: input.asTools, cwd, timeoutMs: TOOL_TIMEOUT_MS, signal: input.signal });
  const run = (status: ToolRun["status"]): ToolRun => ({ tool, status, files: files.length });
  if (r.timedOut) return { run: run("timeout"), hits: [], failure: "timeout" };
  if (r.failed || r.code === null) return { run: run("error"), hits: [], failure: "crashed" };
  if (!OK_EXIT_CODES[tool].includes(r.code)) return { run: run("error"), hits: [], failure: `crashed (exit ${r.code})` };
  try {
    return { run: run("ok"), hits: parseToolOutput(tool, r.stdout, { stage: stageRoot, cwd }), failure: null };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { run: run("error"), hits: [], failure: "unparsable output" };
  }
}

function assemble(input: StaticAnalysisInput, outcomes: Map<ToolName, ToolOutcome>, uncovered: number): StaticAnalysisResult {
  const runs = [...outcomes.values()].map((o) => o.run);
  const notes: string[] = [];
  const blockers: SyntheticBlocker[] = [];

  const leaks = outcomes.get("gitleaks");
  if (leaks?.failure) {
    // §7.5: the secret scan fails closed.
    blockers.push({ kind: "coverage", severity: "critical", title: `Secret scan did not run (${leaks.failure})` });
  } else if (uncovered > 0) {
    // §7.5: a changed regular file no tool could read (over 1 MiB, unreadable) was not scanned.
    blockers.push({
      kind: "coverage",
      severity: "critical",
      title: `Secret scan did not cover ${uncovered} file(s): too large or unreadable`,
    });
  }
  for (const [tool, o] of outcomes) if (o.failure && tool !== "gitleaks") notes.push(`${tool}: ${o.failure}`);

  const key = (h: { path: string; line: number }): string => `${h.path}\0${h.line}`;
  const secretHits = leaks?.hits ?? [];
  // A leak spans StartLine..EndLine (a private key block); every line of it is flagged.
  const flagged = new Set(
    secretHits.flatMap((h) => {
      const last = Math.min(h.endLine ?? h.line, h.line + MAX_FLAGGED_SPAN);
      return Array.from({ length: last - h.line + 1 }, (_, i) => key({ path: h.path, line: h.line + i }));
    }),
  );
  const seenSecret = new Set<string>();
  for (const h of secretHits) {
    if (!input.isAdded(h.path, h.line)) continue;
    const k = `${key(h)}\0${h.rule}`;
    if (seenSecret.has(k)) continue;
    seenSecret.add(k);
    blockers.push({
      kind: "secret",
      severity: "critical",
      title: `Possible secret committed (\`${h.rule}\`) at \`${titlePath(h.path)}:${h.line}\``,
    });
  }

  const seen = new Set<string>();
  const kept = [...outcomes.values()]
    .flatMap((o) => o.hits)
    .filter((h) => input.inDiff(h.path, h.line))
    .filter((h) => h.tool === "gitleaks" || !flagged.has(key(h)))
    .filter((h) => {
      const k = `${h.tool}\0${h.rule}\0${key(h)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (TOOL_ORDER.get(a.tool) ?? 0) - (TOOL_ORDER.get(b.tool) ?? 0) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.rule.localeCompare(b.rule),
    )
    .slice(0, MAX_RUN_TOOL_HITS);

  const hits: ToolHit[] = kept.map(({ tool, rule, path, line, message }) => ({ tool, rule, path, line, message }));
  const support: ExternalSupport[] = kept
    .filter((h) => h.tool !== "gitleaks")
    .map((h) => ({ path: h.path, line: h.line, rule: `${h.tool}:${h.rule}` }));
  return { info: { runs, hits }, support, blockers, notes };
}

/**
 * §7.4.4: marks the hits some engine reported as a finding with `rule` = `<tool>:<rule>` on the same
 * path and a RIGHT-side range holding the hit's line. Returns new objects; unconfirmed hits are
 * the collapsed "Static analysis (not confirmed)" list.
 */
export function markConfirmed(hits: readonly ToolHit[], findings: readonly MergedFinding[]): ToolHit[] {
  return hits.map((h) => {
    const rule = `${h.tool}:${h.rule}`;
    const confirmed = findings.some(
      (f) =>
        f.rule === rule &&
        f.path === h.path &&
        f.side === "RIGHT" &&
        f.line <= h.line &&
        h.line <= (f.end_line ?? f.line),
    );
    return { ...h, confirmed };
  });
}

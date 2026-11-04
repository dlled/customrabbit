// design-v2 §7 wiring: install the pinned tools in a separate minimal-env process, run them over the
// reviewed files, and remove the install dir in a finally. Off by default (`tools.enabled`).
//
// Only tools that understand a reviewed file are installed (gitleaks understands every file). An
// install that fails as a whole gives a null manifest, so runStaticAnalysis reports every tool as
// not installed: gitleaks fails closed (§7.5), the others are body notes.
//
// The tools run as myrabbit-tools through bin/as-tools; with isolation "none" (an explicit opt-in)
// they run as the runner user through bin/as-runner-tools instead, and the pipeline warns.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import { listTree } from "../context/git.js";
import type { DiffFile } from "../github/diff.js";
import type { GitRunner } from "../github/git.js";
import { toolHandles } from "../tools/commands.js";
import type { ToolExec } from "../tools/exec.js";
import { enabledTools, readToolsManifest, removeTools, runStaticAnalysis, type StaticAnalysisResult, type ToolsManifest } from "../tools/index.js";
import { SYSTEM_PATH } from "../tools/install.js";
import type { ToolName, ToolsConfig } from "../types.js";
import type { Isolation } from "../env.js";
import type { Log } from "./log.js";

/** The `::warning::` printed when static analysis runs with isolation "none". */
export const TOOLS_ISOLATION_NONE_WARNING =
  "::warning::myrabbit: isolation is none: the static-analysis tools run as the runner user and can read everything it can (the checkout, $RUNNER_TEMP, the runner's files)";

const execFileAsync = promisify(execFile);

/** Whole install (up to 8 sequential downloads, each with its own 120 s limit). */
export const TOOLS_INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface ToolsDeps {
  /** Installs `tools`; null when the install as a whole failed. Never rejects. */
  install: (tools: readonly ToolName[], signal: AbortSignal) => Promise<ToolsManifest | null>;
  remove: (root: string) => Promise<void>;
  /** Absolute path of bin/as-tools. */
  asTools: string;
  /** Absolute path of bin/as-runner-tools (isolation "none"). */
  asRunnerTools: string;
  /** tools/config/ruff-select.txt. */
  ruffSelect: () => Promise<string>;
  /** Test hooks. */
  exec?: ToolExec;
  tmpBase?: string;
}

/** The production deps, from the action root (holds dist/, bin/ and tools/). */
export function realToolsDeps(actionRoot: string, log: Log): ToolsDeps {
  return {
    install: async (tools, signal) => {
      const request = JSON.stringify({ tools, lockPath: join(actionRoot, "tools/tools.lock"), configDir: join(actionRoot, "tools/config") });
      try {
        // Minimal env as for the engines (§7.2): no secrets, no ACTIONS_*/GITHUB_*.
        const { stdout } = await execFileAsync(process.execPath, [join(actionRoot, "dist/tools-install.js"), request], {
          env: { PATH: SYSTEM_PATH, LANG: "C.UTF-8" },
          timeout: TOOLS_INSTALL_TIMEOUT_MS,
          killSignal: "SIGKILL",
          signal,
          maxBuffer: 64 * 1024,
        });
        const line = stdout.trim().split("\n").at(-1) ?? "";
        const out = JSON.parse(line) as { root?: unknown };
        if (typeof out.root !== "string") return null;
        return await readToolsManifest(out.root);
      } catch (e) {
        log(`tools: install failed (${e instanceof Error ? e.message.split("\n")[0] ?? "" : "unknown"})`);
        return null;
      }
    },
    remove: removeTools,
    asTools: join(actionRoot, "bin/as-tools"),
    asRunnerTools: join(actionRoot, "bin/as-runner-tools"),
    ruffSelect: () => readFile(join(actionRoot, "tools/config/ruff-select.txt"), "utf8"),
  };
}

/** Enabled tools that may have a file to check; shellcheck also takes extensionless (shebang) files. */
export function toolsToRun(config: ToolsConfig, paths: readonly string[]): ToolName[] {
  return enabledTools(config).filter((t) =>
    paths.some((p) => toolHandles(t, p, "") || (t === "shellcheck" && !posix.basename(p).includes("."))),
  );
}

export interface ToolsStepInput {
  config: ToolsConfig;
  /** Absent: tools cannot be installed here (the run behaves as if every install failed). */
  deps: ToolsDeps | undefined;
  git: GitRunner;
  headSha: string;
  /** Reviewed files of the reviewed diff. */
  files: readonly DiffFile[];
  signal: AbortSignal;
  log: Log;
  /** Default "guest-users": the tools run as myrabbit-tools. */
  isolation?: Isolation;
}

/** Added and context (RIGHT) lines, and added lines only, of the reviewed diff. */
export function diffLines(files: readonly DiffFile[]): { inDiff: (p: string, l: number) => boolean; isAdded: (p: string, l: number) => boolean } {
  const right = new Set<string>();
  const added = new Set<string>();
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "del" || l.newLine === null) continue;
        right.add(`${f.path}\0${l.newLine}`);
        if (l.kind === "add") added.add(`${f.path}\0${l.newLine}`);
      }
    }
  }
  return { inDiff: (p, l) => right.has(`${p}\0${l}`), isAdded: (p, l) => added.has(`${p}\0${l}`) };
}

/**
 * §7 step: null when static analysis is off. Never rejects: an unexpected error (staging, listing
 * the head tree) is a soft note, and with gitleaks on also the §7.5 fail-closed coverage blocker.
 */
export async function staticAnalysisStep(input: ToolsStepInput): Promise<StaticAnalysisResult | null> {
  const tools = enabledTools(input.config);
  if (tools.length === 0) return null;
  try {
    return await analyse(input);
  } catch (e) {
    input.log(`tools: failed (${e instanceof Error ? e.message.split("\n")[0] ?? "" : "unknown"})`);
    return {
      info: { runs: tools.map((tool) => ({ tool, status: "error" as const })), hits: [] },
      support: [],
      blockers: tools.includes("gitleaks") ? [{ kind: "coverage", severity: "critical", title: "Secret scan did not run (error)" }] : [],
      notes: ["static analysis failed"],
    };
  }
}

/** The install dir is always removed. */
async function analyse(input: ToolsStepInput): Promise<StaticAnalysisResult | null> {
  const files = input.files.filter((f) => !f.binary && f.status !== "deleted");
  const paths = files.map((f) => f.path);
  const wanted = toolsToRun(input.config, paths);
  const manifest = wanted.length > 0 && input.deps !== undefined && !input.signal.aborted ? await input.deps.install(wanted, input.signal) : null;
  try {
    const tree = await listTree(input.git, input.headSha);
    // listTree gives an empty index when git fails: that must not read as "nothing to scan".
    if (tree.files.size === 0 && paths.length > 0) throw new Error("head tree could not be listed");
    const lines = diffLines(files);
    const result = await runStaticAnalysis({
      config: input.config,
      tree,
      git: input.git,
      paths,
      manifest,
      asTools: (input.isolation === "none" ? input.deps?.asRunnerTools : input.deps?.asTools) ?? "/nonexistent/as-tools",
      ruffSelect: input.deps === undefined ? "" : await input.deps.ruffSelect().catch(() => ""),
      inDiff: lines.inDiff,
      isAdded: lines.isAdded,
      signal: input.signal,
      ...(input.deps?.exec === undefined ? {} : { exec: input.deps.exec }),
      ...(input.deps?.tmpBase === undefined ? {} : { tmpBase: input.deps.tmpBase }),
    });
    if (result !== null) {
      const ran = result.info.runs.filter((r) => r.status !== "skipped").map((r) => `${r.tool}=${r.status}`);
      input.log(`tools: ${ran.length === 0 ? "nothing to check" : ran.join(", ")}; ${result.info.hits.length} hit(s), ${result.blockers.length} blocker(s)`);
    }
    return result;
  } finally {
    if (manifest !== null && input.deps !== undefined) {
      await input.deps.remove(manifest.root).catch((e: unknown) => {
        input.log(`tools: could not remove ${manifest.root} (${e instanceof Error ? e.message : "unknown"})`);
      });
    }
  }
}

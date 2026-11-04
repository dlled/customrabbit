// Entry point of dist/tools-install.js (design-v2 §7.2): installs the pinned static-analysis tools
// in its own process. The orchestrator spawns it with a minimal env (PATH and LANG only: no
// secrets, no ACTIONS_*/GITHUB_*), passes one JSON argument and reads one JSON line back:
//
//   node dist/tools-install.js '{"tools":["gitleaks"],"lockPath":"…/tools.lock","configDir":"…/config"}'
//   → {"root":"/tmp/myrabbit-tools-XXXX"}            exit 0 (per-tool failures are in its manifest)
//   → {"error":"…"}                                 exit 1 (lock or directory unusable)
//
// Nothing here reads env.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installTools } from "../tools/install.js";
import { TOOL_NAMES, type ToolName } from "../types.js";

export interface InstallRequest {
  tools: ToolName[];
  lockPath: string;
  configDir: string;
}

/** Parses and checks the one argument; throws on anything unexpected. */
export function parseInstallRequest(raw: string | undefined): InstallRequest {
  const v: unknown = JSON.parse(raw ?? "");
  if (typeof v !== "object" || v === null) throw new Error("bad request");
  const r = v as Record<string, unknown>;
  const names = new Set<string>(TOOL_NAMES);
  if (!Array.isArray(r.tools) || !r.tools.every((t): t is ToolName => typeof t === "string" && names.has(t))) throw new Error("bad tools");
  for (const k of ["lockPath", "configDir"] as const) {
    const p = r[k];
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new Error(`bad ${k}`);
  }
  return { tools: r.tools, lockPath: r.lockPath as string, configDir: r.configDir as string };
}

/** Runs the install; returns the exit code and the one line to print. */
export async function runToolsInstall(
  raw: string | undefined,
  install: typeof installTools = installTools,
): Promise<{ code: number; line: string }> {
  try {
    const req = parseInstallRequest(raw);
    const m = await install({ tools: req.tools, lockPath: req.lockPath, configDir: req.configDir });
    return { code: 0, line: JSON.stringify({ root: m.root }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "install failed";
    return { code: 1, line: JSON.stringify({ error: msg.replace(/\s+/g, " ").slice(0, 200) }) };
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const { code, line } = await runToolsInstall(process.argv[2]);
  // Explicit exit once the line is written: an idle keep-alive socket must not hold the process.
  process.exitCode = code;
  process.stdout.write(`${line}\n`, () => process.exit(code));
}

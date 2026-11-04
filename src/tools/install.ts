// Tool install (design-v2 §7.2). Runs in its own process (PW-P6 adds the esbuild entry point and
// spawns it with a minimal env: no secrets, no ACTIONS_*/GITHUB_*), so nothing here may read env.
//
//   <root>/            fresh mkdtemp under /tmp, owned by the runner user, 0755
//   <root>/bin/<tool>  verified binaries, 0755
//   <root>/py/         yamllint + pyyaml + pathspec, unpacked from hashed wheels
//   <root>/config/     copies of the pinned configs (myrabbit-tools cannot read the action dir)
//   <root>/cwd/        empty working directory for every tool run
//   <root>/no-ignore/  empty directory passed as gitleaks `-i`
//   <root>/manifest.json  what was installed and what failed, for the orchestrator
//
// myrabbit-tools reads and executes through the "other" bits only: it can never write here, so an
// exploited tool cannot replace another tool's binary later in the same run. Every download is
// checked against tools/tools.lock before anything is extracted or made executable; a mismatch is
// a tool failure ("unverified"), never a retry with another source. No cache (v1 §10.3).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { TOOL_NAMES, type ToolName } from "../types.js";
import { parseToolsLock, type LockEntry, type ToolsLock } from "./lock.js";

const execFileAsync = promisify(execFile);

/** Largest pinned artifact is ~56 MB (hadolint); anything far bigger is not what we pinned. */
export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** PATH for tar/python3 during install, and for every tool run. */
export const SYSTEM_PATH = "/usr/bin:/bin";

/** Pinned config files, by tool (tools/config/). Tools without one take flags only. */
export const CONFIG_FILES: Partial<Record<ToolName, string>> = {
  actionlint: "actionlint.yaml",
  hadolint: "hadolint.yaml",
  ruff: "ruff-select.txt",
  yamllint: "yamllint.yaml",
  squawk: "squawk.toml",
  gitleaks: "gitleaks.toml",
};

export type InstallFailure = "download" | "sha256" | "extract";

export interface ToolsManifest {
  manifest_version: 1;
  root: string;
  /** Absolute paths of installed binaries (yamllint: the py dir). */
  installed: Partial<Record<ToolName, string>>;
  failed: Partial<Record<ToolName, InstallFailure>>;
  versions: Partial<Record<ToolName, string>>;
}

export interface InstallDeps {
  /** Fetches a URL with redirects; rejects on HTTP errors. */
  fetchBytes: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Runs a system command (tar, python3) with a minimal env. */
  exec: (file: string, args: readonly string[]) => Promise<void>;
}

export interface InstallOptions {
  tools: readonly ToolName[];
  /** tools/tools.lock path. */
  lockPath: string;
  /** tools/config dir. */
  configDir: string;
  /** Parent of the mkdtemp; default /tmp (never $RUNNER_TEMP, which myrabbit-tools must not reach). */
  tmpBase?: string;
  deps?: Partial<InstallDeps>;
}

async function defaultFetch(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  return buf;
}

async function defaultExec(file: string, args: readonly string[]): Promise<void> {
  await execFileAsync(file, [...args], { env: { PATH: SYSTEM_PATH, LANG: "C.UTF-8" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `wanted` in canonical order. actionlint uses shellcheck for `run:` scripts only when shellcheck
 * is itself installed; otherwise it runs with `-shellcheck=` (off).
 */
export function toolsToInstall(wanted: readonly ToolName[]): ToolName[] {
  const set = new Set(wanted);
  return TOOL_NAMES.filter((t) => set.has(t));
}

async function downloadVerified(
  deps: InstallDeps,
  url: string,
  sha256: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; failure: InstallFailure }> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, DOWNLOAD_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    bytes = await deps.fetchBytes(url, ac.signal);
  } catch {
    return { ok: false, failure: "download" };
  } finally {
    clearTimeout(timer);
  }
  return sha256Hex(bytes) === sha256 ? { ok: true, bytes } : { ok: false, failure: "sha256" };
}

async function installOne(
  tool: ToolName,
  entry: LockEntry,
  root: string,
  deps: InstallDeps,
): Promise<{ path: string } | { failure: InstallFailure }> {
  const dl = join(root, "dl", tool);
  await mkdir(dl, { recursive: true, mode: 0o700 });
  if (entry.archive === "wheels") {
    const py = join(root, "py");
    const files: string[] = [];
    // Verify every wheel before unpacking any of them.
    for (const w of entry.wheels) {
      const got = await downloadVerified(deps, w.url, w.sha256);
      if (!got.ok) return { failure: got.failure };
      const file = join(dl, `${w.name}.whl`);
      await writeFile(file, got.bytes, { mode: 0o600 });
      files.push(file);
    }
    try {
      await mkdir(py, { recursive: true, mode: 0o755 });
      for (const f of files) await deps.exec("python3", ["-I", "-m", "zipfile", "-e", f, py]);
      await deps.exec("chmod", ["-R", "u=rwX,go=rX", py]);
    } catch {
      return { failure: "extract" };
    }
    return { path: py };
  }
  const got = await downloadVerified(deps, entry.url, entry.sha256);
  if (!got.ok) return { failure: got.failure };
  const bin = join(root, "bin", tool);
  try {
    if (entry.archive === "raw") {
      await writeFile(bin, got.bytes, { mode: 0o600 });
    } else {
      const archive = join(dl, "archive.tar.gz");
      const out = join(dl, "x");
      await mkdir(out, { mode: 0o700 });
      await writeFile(archive, got.bytes, { mode: 0o600 });
      // Only the pinned member is extracted; `--` keeps it from being read as an option.
      await deps.exec("tar", ["-xzf", archive, "-C", out, "--no-same-owner", "--no-same-permissions", "--", entry.member ?? ""]);
      await copyFile(join(out, entry.member ?? ""), bin);
    }
    await chmod(bin, 0o755);
  } catch {
    return { failure: "extract" };
  }
  return { path: bin };
}

/**
 * Installs the given tools from tools/tools.lock into a fresh /tmp directory and writes its
 * manifest. Per-tool failures are recorded, never thrown: the caller decides what fails closed
 * (gitleaks, §7.5) and what is a body note. Throws only when the lock or the directory itself is
 * unusable.
 */
export async function installTools(options: InstallOptions): Promise<ToolsManifest> {
  const deps: InstallDeps = { fetchBytes: defaultFetch, exec: defaultExec, ...options.deps };
  const lock: ToolsLock = parseToolsLock(await readFile(options.lockPath, "utf8"));
  const root = await mkdtemp(join(options.tmpBase ?? "/tmp", "myrabbit-tools-"));
  await chmod(root, 0o755);
  for (const d of ["bin", "config", "cwd", "no-ignore"]) await mkdir(join(root, d), { mode: 0o755 });
  await chmod(join(root, "bin"), 0o755);

  for (const name of Object.values(CONFIG_FILES)) {
    const dest = join(root, "config", name);
    await copyFile(join(options.configDir, name), dest);
    await chmod(dest, 0o644);
  }

  const manifest: ToolsManifest = { manifest_version: 1, root, installed: {}, failed: {}, versions: {} };
  for (const tool of toolsToInstall(options.tools)) {
    const entry = lock.tools[tool];
    manifest.versions[tool] = entry.version;
    const r = await installOne(tool, entry, root, deps);
    if ("path" in r) manifest.installed[tool] = r.path;
    else manifest.failed[tool] = r.failure;
  }
  await rm(join(root, "dl"), { recursive: true, force: true });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

/** Reads a manifest written by {@link installTools}; the root must be the one it names. */
export async function readToolsManifest(root: string): Promise<ToolsManifest> {
  const raw: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const m = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<ToolsManifest>;
  if (m.manifest_version !== 1 || m.root !== root || typeof m.installed !== "object" || typeof m.failed !== "object") {
    throw new Error("tools manifest does not match its directory");
  }
  return m as ToolsManifest;
}

/** Removes the install dir (runner-owned, so no sudo). */
export async function removeTools(root: string): Promise<void> {
  if (!root.startsWith("/") || !/\/myrabbit-tools-[^/]+$/.test(root)) throw new Error("refusing to remove an unexpected path");
  await rm(root, { recursive: true, force: true });
}

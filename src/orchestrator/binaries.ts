// Native engine CLIs in $GITHUB_ACTION_PATH/node_modules (design §9.2). bin/as-agent-* run them as
// the guest users; the orchestrator passes their absolute paths as MYRABBIT_CLAUDE_BIN /
// MYRABBIT_CODEX_BIN. The lookups mirror what each SDK does when no executable is given:
// - Claude Agent SDK 0.3.317: `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude`
//   (glibc first on Linux);
// - Codex SDK 0.166.0: `@openai/codex` → `@openai/codex-<platform>-<arch>` →
//   `vendor/<triple>/bin/codex`, with `vendor/<triple>/codex-path` (bundled ripgrep) on PATH. With
//   codexPathOverride the SDK no longer adds that directory, so the orchestrator does.

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export class BinaryNotFoundError extends Error {
  override readonly name = "BinaryNotFoundError";
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const CODEX_TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

export interface ResolveOptions {
  /** Directory to resolve packages from, e.g. the action root (default: this module's location). */
  from: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolveClaudeBinary(opts: ResolveOptions): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const require = createRequire(join(opts.from, "noop.js"));
  const base = "@anthropic-ai/claude-agent-sdk";
  const candidates = platform === "linux" ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`];
  for (const pkg of candidates) {
    try {
      const bin = join(dirname(require.resolve(`${pkg}/package.json`)), "claude");
      if (isFile(bin)) return bin;
    } catch {
      // not installed for this platform
    }
  }
  throw new BinaryNotFoundError(`Claude Code native binary not found for ${platform}-${arch}`);
}

export function resolveCodexBinary(opts: ResolveOptions): { bin: string; pathDirs: string[] } {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const triple = CODEX_TRIPLES[`${platform}-${arch}`];
  if (triple === undefined) throw new BinaryNotFoundError(`Codex CLI is not available for ${platform}-${arch}`);
  try {
    const require = createRequire(join(opts.from, "noop.js"));
    const codexPkg = require.resolve("@openai/codex/package.json");
    const platformPkg = createRequire(codexPkg).resolve(`@openai/codex-${platform}-${arch}/package.json`);
    const root = join(dirname(platformPkg), "vendor", triple);
    const bin = join(root, "bin", "codex");
    if (isFile(bin)) {
      const pathDir = join(root, "codex-path");
      return { bin, pathDirs: isDir(pathDir) ? [pathDir] : [] };
    }
    const legacy = join(root, "codex", "codex");
    if (isFile(legacy)) {
      const pathDir = join(root, "path");
      return { bin: legacy, pathDirs: isDir(pathDir) ? [pathDir] : [] };
    }
  } catch {
    // fall through
  }
  throw new BinaryNotFoundError(`Codex CLI native binary not found for ${platform}-${arch}`);
}

// Temporary fixture repositories for the context pack tests: a base commit and a head commit, the
// reviewed diff from the real v1 diff code, and the input for buildContextPack. Offline.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ContextPackInput } from "../../src/context/index.js";
import { createGitRunner, mergeBaseDiff, type GitRunner } from "../../src/github/git.js";
import type { ContextConfig } from "../../src/types.js";

/** File content, or a symlink target (`{ link }`), or null to delete. */
export type FileSpec = string | { link: string } | null;

export interface FixtureRepo {
  dir: string;
  git: GitRunner;
  base: string;
  head: string;
  sh: (...args: string[]) => string;
  cleanup: () => void;
}

export const CONFIG_ON: ContextConfig = { enabled: true, max_chars: 60_000, max_usages_per_symbol: 8, typescript: false };

function write(dir: string, files: Record<string, FileSpec>): void {
  for (const [path, spec] of Object.entries(files)) {
    const abs = join(dir, path);
    rmSync(abs, { force: true });
    if (spec === null) continue;
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof spec === "string") writeFileSync(abs, spec);
    else symlinkSync(spec.link, abs);
  }
}

/** Commits `base`, then applies `head` on top (a branch), and returns both SHAs. */
export function fixtureRepo(base: Record<string, FileSpec>, head: Record<string, FileSpec>): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "myrabbit-ctx-"));
  const sh = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "test@example.invalid");
  sh("config", "user.name", "test");
  sh("config", "core.symlinks", "true");
  write(dir, base);
  sh("add", "-A");
  sh("commit", "-q", "--allow-empty", "-m", "base");
  const baseSha = sh("rev-parse", "HEAD");
  sh("checkout", "-q", "-b", "pr");
  write(dir, head);
  sh("add", "-A");
  sh("commit", "-q", "--allow-empty", "-m", "head");
  const headSha = sh("rev-parse", "HEAD");
  return {
    dir,
    git: createGitRunner(dir),
    base: baseSha,
    head: headSha,
    sh,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The pack input for the fixture's PR diff. */
export async function packInput(repo: FixtureRepo, overrides: Partial<ContextPackInput> = {}): Promise<ContextPackInput> {
  const diff = await mergeBaseDiff(repo.git, repo.base, repo.head);
  return {
    git: repo.git,
    baseSha: repo.base,
    headSha: repo.head,
    files: diff.files,
    diffChars: 1_000_000,
    config: CONFIG_ON,
    ...overrides,
  };
}

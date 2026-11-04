// Read-only access to repository content at a given commit (design.md §2 step 3, §4).
// The loader only ever reads the BASE SHA. Tests inject an in-memory reader; the real one runs
// git through execFile/spawn (no shell) and never touches the working tree.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { minimatch } from "minimatch";

import { GLOB_OPTIONS } from "./glob.js";

export interface GitReader {
  /**
   * File content at `sha`, or null when the path does not exist there (or is not a regular file).
   * With `maxBytes`, at most that many bytes are read and returned, cut at a UTF-8 character
   * boundary, so one huge file never exhausts memory or buffers. Throws on other errors.
   */
  showFile(sha: string, path: string, maxBytes?: number): Promise<string | null>;
  /** Repo-relative paths of files at `sha` matching the minimatch `glob` (dot files included). */
  listFiles(sha: string, glob: string): Promise<string[]>;
}

const execFileAsync = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A GitReader backed by the git CLI in `repoDir`. `sha` must be a full 40-hex commit id. */
export function createGitReader(repoDir: string): GitReader {
  // No secrets from the job env reach git.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      env,
    });
    return stdout;
  };
  const checkSha = (sha: string): void => {
    if (!SHA_RE.test(sha)) throw new Error("git reader: sha must be 40 lowercase hex chars");
  };

  return {
    async showFile(sha, path, maxBytes = MAX_OUTPUT_BYTES) {
      checkSha(sha);
      // ls-tree tells "missing" apart from real failures without parsing git's stderr.
      const entry = await git(["ls-tree", "-z", sha, "--", path]);
      const [meta] = entry.split("\t");
      // Regular files only: a symlink (120000) or submodule (gitlink) counts as missing.
      if (meta === undefined || !/^100[0-7]{3} blob /.test(meta)) return null;
      const bytes = await readCapped(["-C", repoDir, "cat-file", "blob", `${sha}:${path}`], env, maxBytes);
      return utf8Prefix(bytes, maxBytes);
    },
    async listFiles(sha, glob) {
      checkSha(sha);
      const out = await git(["ls-tree", "-r", "-z", "--name-only", sha]);
      return out.split("\0").filter((p) => p !== "" && minimatch(p, glob, GLOB_OPTIONS));
    },
  };
}

/** Runs git and keeps at most `maxBytes` of stdout, stopping the process once it has enough. */
function readCapped(args: string[], env: NodeJS.ProcessEnv, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let capped = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (capped) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        capped = true;
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (capped || code === 0) resolve(Buffer.concat(chunks).subarray(0, maxBytes));
      else reject(new Error(`git cat-file exited with code ${String(code)}`));
    });
  });
}

/** Decodes at most `maxBytes` bytes of UTF-8 without leaving a partial character at the end. */
export function utf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.length, Math.max(0, maxBytes));
  if (end < bytes.length) {
    // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
    let i = end;
    while (i > 0 && ((bytes[i] ?? 0) & 0xc0) === 0x80) i--;
    end = i;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("utf8");
}

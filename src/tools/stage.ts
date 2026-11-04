// Staging dir (design-v2 §1.1, §7.1): changed files written from their head blobs into a fresh
// mkdtemp, plain files only. Tools never see the checkout. The layout keeps each repo-relative
// path under the staging root, so hits map back.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";

import { MAX_BLOB_BYTES, type TreeIndex } from "../context/git.js";
import type { GitRunner } from "../github/git.js";

export interface StagedFile {
  /** Absolute staging path. */
  abs: string;
  firstLine: string;
}

export interface Stage {
  root: string;
  files: Map<string, StagedFile>;
  /** Changed paths with nothing to stage (deleted, symlink, submodule, binary, too large, unreadable). */
  skipped: string[];
  /**
   * The subset of `skipped` that is a regular file in head with content no tool saw: over
   * {@link MAX_BLOB_BYTES}, unreadable, or a path that cannot be staged. Binary blobs, deleted
   * paths, symlinks and submodules are not here. The secret scan reports these (§7.5).
   */
  uncovered: string[];
}

/** A repo path that can be written under the staging root without escaping it. */
export function isStageablePath(p: string): boolean {
  if (p === "" || p.length > 4096 || p.startsWith("/") || /[\0\r\n]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Why TreeIndex.read gave null for a listed file within the size limit: a binary blob (NUL byte)
 * is expected; anything else (git failure) is unreadable.
 */
async function isBinary(git: GitRunner, oid: string): Promise<boolean> {
  const r = await git(["cat-file", "blob", oid]);
  return r.code === 0 && r.stdout.includes("\0");
}

/** Writes the head blobs of `paths` into a new `myrabbit-stage-*` dir under `tmpBase` (0755 dirs, 0644 files). */
export async function stageFiles(tree: TreeIndex, paths: readonly string[], git: GitRunner, tmpBase = "/tmp"): Promise<Stage> {
  const root = await mkdtemp(posix.join(tmpBase, "myrabbit-stage-"));
  await chmod(root, 0o755);
  const stage: Stage = { root, files: new Map(), skipped: [], uncovered: [] };
  for (const p of [...new Set(paths)].sort()) {
    const entry = tree.files.get(p);
    const text = isStageablePath(p) ? await tree.read(p) : null;
    const abs = posix.join(root, p);
    if (text === null || !abs.startsWith(`${root}/`)) {
      stage.skipped.push(p);
      if (entry === undefined) continue; // deleted, symlink, submodule: nothing to scan
      if (text === null && isStageablePath(p) && entry.size <= MAX_BLOB_BYTES && (await isBinary(git, entry.oid))) continue;
      stage.uncovered.push(p);
      continue;
    }
    await mkdir(posix.dirname(abs), { recursive: true, mode: 0o755 });
    await writeFile(abs, text, { mode: 0o644, flag: "wx" });
    const nl = text.indexOf("\n");
    stage.files.set(p, { abs, firstLine: (nl < 0 ? text : text.slice(0, nl)).slice(0, 200) });
  }
  return stage;
}

export async function removeStage(root: string): Promise<void> {
  if (!root.startsWith("/") || !/\/myrabbit-stage-[^/]+$/.test(root)) throw new Error("refusing to remove an unexpected path");
  await rm(root, { recursive: true, force: true });
}

// Blob-only access to PR content (design-v2 §1.1). Nothing here opens a path from the PR on the
// filesystem: the file set is `git ls-tree -r <commit>`, file contents are `git cat-file blob <oid>`,
// and usages come from `git grep` over the commit's tree. Symlinks (120000) and submodules (160000)
// are never listed, so they are never read or followed. Blobs over 1 MB are skipped.

import { assertSha, type GitRunner } from "../github/git.js";

/** §1.1: a blob over this size is skipped. */
export const MAX_BLOB_BYTES = 1024 * 1024;

/** §3.4: names longer than this, or with NUL or a newline, never reach git. */
export const MAX_NAME_CHARS = 200;

/** Pins every setting that changes `git grep` / `git ls-tree` output or matching. */
const CONFIG_ARGS = [
  "-c", "core.quotePath=false",
  "-c", "color.ui=never",
  "-c", "grep.lineNumber=true",
  "-c", "grep.column=false",
  "-c", "grep.fullName=false",
  "-c", "grep.patternType=fixed",
  "-c", "grep.extendedRegexp=false",
  "-c", "grep.fallbackToNoIndex=false",
] as const;

export interface TreeEntry {
  /** "100644" or "100755": only regular files are kept. */
  mode: string;
  oid: string;
  size: number;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Regular files of one commit, with their blob ids. */
export class TreeIndex {
  readonly commit: string;
  readonly files: ReadonlyMap<string, TreeEntry>;
  private readonly git: GitRunner;
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(git: GitRunner, commit: string, files: ReadonlyMap<string, TreeEntry>) {
    this.git = git;
    this.commit = commit;
    this.files = files;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** True when some listed file lives under `dir/` (`""` is the root). */
  hasDirectory(dir: string): boolean {
    const prefix = dir === "" ? "" : `${dir.replace(/\/+$/, "")}/`;
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    return false;
  }

  /**
   * The text of a listed regular file, or null for an unlisted path (symlink, submodule, missing),
   * a blob over {@link MAX_BLOB_BYTES}, a binary blob (NUL byte) or a git failure.
   */
  read(path: string): Promise<string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.load(path);
      this.cache.set(path, p);
    }
    return p;
  }

  /** Cached text of a file already read, without starting a read. */
  peek(path: string): Promise<string | null> | undefined {
    return this.cache.get(path);
  }

  private async load(path: string): Promise<string | null> {
    const e = this.files.get(path);
    if (!e || e.size > MAX_BLOB_BYTES) return null;
    const r = await this.git([...CONFIG_ARGS, "cat-file", "blob", e.oid]);
    if (r.code !== 0) return null;
    if (r.stdout.includes("\0")) return null;
    return r.stdout;
  }
}

/**
 * `git ls-tree -r -l -z <commit>`: regular files only (100644, 100755). Symlinks (120000),
 * submodules (160000) and anything else are dropped here, so no later step can see them.
 */
export async function listTree(git: GitRunner, commit: string): Promise<TreeIndex> {
  assertSha(commit, "tree commit");
  const r = await git([...CONFIG_ARGS, "ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  const files = new Map<string, TreeEntry>();
  if (r.code !== 0) return new TreeIndex(git, commit, files);
  for (const rec of r.stdout.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid, size] = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (!oid || !OID.test(oid)) continue;
    const n = Number(size);
    if (!Number.isFinite(n)) continue;
    files.set(path, { mode, oid, size: n });
  }
  return new TreeIndex(git, commit, files);
}

/** §3.4: a name git may see as a literal pattern. */
export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_CHARS && !/[\0\n\r]/.test(name);
}

export interface GrepHit {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface GrepOptions {
  /** `--attr-source`: the trusted base commit (v1 §8.2). */
  attrSource: string;
  /** `-m`: hits per file. */
  maxPerFile?: number;
  /** Stop after this many hits overall. */
  maxHits?: number;
}

/**
 * `git grep -n -w -F -I -z -e <name> <commit> --`: the name is a literal (`-F`) given with `-e`, so it
 * is never a regex or an option. Hits outside regular files of `tree` are dropped.
 */
export async function grepWord(
  git: GitRunner,
  tree: TreeIndex,
  name: string,
  options: GrepOptions,
): Promise<GrepHit[]> {
  if (!isSafeName(name)) return [];
  assertSha(options.attrSource, "attr source");
  const args = [
    ...CONFIG_ARGS,
    `--attr-source=${options.attrSource}`,
    "grep", "-n", "-w", "-F", "-I", "-z", "--no-color", "--no-textconv",
    "-m", String(options.maxPerFile ?? 20),
    "-e", name, tree.commit, "--",
  ];
  const r = await git(args);
  // 1 = no match.
  if (r.code !== 0) return [];
  const prefix = `${tree.commit}:`;
  const max = options.maxHits ?? 400;
  const hits: GrepHit[] = [];
  for (const row of r.stdout.split("\n")) {
    if (!row.startsWith(prefix)) continue;
    const a = row.indexOf("\0");
    const b = a < 0 ? -1 : row.indexOf("\0", a + 1);
    if (b < 0) continue;
    const path = row.slice(prefix.length, a);
    const line = Number(row.slice(a + 1, b));
    if (!tree.has(path) || !Number.isInteger(line) || line < 1) continue;
    hits.push({ path, line, text: row.slice(b + 1) });
    if (hits.length >= max) break;
  }
  return hits;
}

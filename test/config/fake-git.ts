// In-memory GitReader for tests: no git, no shell, no filesystem.

import { minimatch } from "minimatch";

import { utf8Prefix, type GitReader } from "../../src/config/git.js";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);

export interface FakeGit extends GitReader {
  calls: { op: "showFile" | "listFiles"; sha: string; arg: string }[];
}

/** `trees[sha]` maps repo-relative paths to file contents. */
export function fakeGit(trees: Record<string, Record<string, string>>): FakeGit {
  const calls: FakeGit["calls"] = [];
  return {
    calls,
    showFile(sha, path, maxBytes) {
      calls.push({ op: "showFile", sha, arg: path });
      const content = trees[sha]?.[path] ?? null;
      if (content === null || maxBytes === undefined) return Promise.resolve(content);
      return Promise.resolve(utf8Prefix(Buffer.from(content, "utf8"), maxBytes));
    },
    listFiles(sha, glob) {
      calls.push({ op: "listFiles", sha, arg: glob });
      const paths = Object.keys(trees[sha] ?? {});
      return Promise.resolve(paths.filter((p) => minimatch(p, glob, { dot: true })));
    },
  };
}

// Config hash for the state marker (design.md §8.3 `config=<sha1-12>`, §2.1).
// It covers everything that changes what the engines are told: the effective config (after
// defaults) and the style guide texts with their scopes. A change in any of them makes the next
// run a full review instead of an incremental one.

import { createHash } from "node:crypto";

import type { Config } from "../types.js";
import type { StyleGuide } from "./style-guide.js";

export const CONFIG_HASH_LENGTH = 12;

export function configHash(
  config: Config,
  guides: readonly Pick<StyleGuide, "path" | "scope" | "content">[] = [],
): string {
  const doc = {
    config,
    guides: guides.map((g) => ({ path: g.path, scope: g.scope, sha1: sha1(g.content) })),
  };
  return sha1(canonicalJson(doc)).slice(0, CONFIG_HASH_LENGTH);
}

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

/** JSON with object keys sorted at every level, so key order in the YAML never changes the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

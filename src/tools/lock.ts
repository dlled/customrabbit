// tools/tools.lock (design-v2 §7.2): one pinned linux-x64 artifact per tool, each with the sha256
// computed from the downloaded file. yamllint is a set of hashed wheels instead of a binary.

import { z } from "zod";

import { TOOL_NAMES, type ToolName } from "../types.js";

const SHA256 = /^[0-9a-f]{64}$/;
/** Only these hosts serve pinned artifacts; anything else in the lock is rejected. */
const ALLOWED_HOSTS = new Set(["github.com", "files.pythonhosted.org"]);

const url = z.string().refine((u) => {
  try {
    const p = new URL(u);
    return p.protocol === "https:" && ALLOWED_HOSTS.has(p.hostname) && p.username === "" && p.password === "";
  } catch {
    return false;
  }
}, "https URL on github.com or files.pythonhosted.org");

/** A member path inside an archive: relative, no `..`, no leading `-`. */
const member = z.string().regex(/^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/);

const binaryEntry = z.object({
  version: z.string().min(1).max(40),
  url,
  sha256: z.string().regex(SHA256),
  archive: z.enum(["tar.gz", "raw"]),
  member: member.optional(),
});

const wheel = z.object({
  name: z.string().regex(/^[a-z0-9_.-]{1,60}$/),
  version: z.string().min(1).max(40),
  url,
  sha256: z.string().regex(SHA256),
});

const wheelsEntry = z.object({
  version: z.string().min(1).max(40),
  archive: z.literal("wheels"),
  wheels: z.array(wheel).min(1).max(10),
});

export type BinaryLockEntry = z.infer<typeof binaryEntry>;
export type WheelsLockEntry = z.infer<typeof wheelsEntry>;
export type LockEntry = BinaryLockEntry | WheelsLockEntry;

export interface ToolsLock {
  platform: "linux-x64";
  tools: Record<ToolName, LockEntry>;
}

const lockSchema = z.object({
  lock_version: z.literal(1),
  platform: z.literal("linux-x64"),
  comment: z.string().optional(),
  tools: z.object(
    Object.fromEntries(
      TOOL_NAMES.map((t) => [t, t === "yamllint" ? wheelsEntry : binaryEntry]),
    ) as Record<ToolName, typeof binaryEntry | typeof wheelsEntry>,
  ).strict(),
});

/** Parses and validates the lock. Throws on anything malformed: the lock is trusted input from myrabbit itself. */
export function parseToolsLock(text: string): ToolsLock {
  const raw: unknown = JSON.parse(text);
  const parsed = lockSchema.parse(raw);
  for (const t of TOOL_NAMES) {
    const e = parsed.tools[t];
    if (e.archive === "tar.gz" && e.member === undefined) throw new Error(`tools.lock: ${t} needs a member`);
  }
  return { platform: parsed.platform, tools: parsed.tools };
}

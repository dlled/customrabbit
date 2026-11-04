// Small formatting helpers shared by the body, comment and job-summary renderers.

import type { MergedFinding, Severity } from "../types.js";
import type { EngineRunSummary } from "./types.js";
import { severityRank } from "./plan.js";

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "n/a";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "n/a";
  return `$${usd.toFixed(2)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "1 critical, 2 major", most severe first; "" when empty. */
export function severityBreakdown(severities: readonly Severity[]): string {
  const counts = new Map<Severity, number>();
  for (const s of severities) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

/**
 * "claude+codex", "claude only (codex failed: timeout)", or "no engine (nothing to review)" when
 * every enabled engine was not run.
 */
export function reviewedBy(engines: readonly EngineRunSummary[]): string {
  const ok = engines.filter((e) => e.status === "ok").map((e) => e.engine);
  const others = engines
    .filter((e) => e.status !== "ok")
    .map((e) =>
      e.status === "disabled"
        ? `${e.engine} disabled`
        : e.status === "not_run"
          ? `${e.engine} not run`
          : `${e.engine} failed: ${e.error ?? "error"}`,
    );
  if (ok.length === 0) {
    const nothingToReview = engines.some((e) => e.status === "not_run") && engines.every((e) => e.status === "not_run" || e.status === "disabled");
    return nothingToReview ? "no engine (nothing to review)" : "no engine";
  }
  if (others.length === 0) return ok.join("+");
  return `${ok.join("+")} only (${others.join("; ")})`;
}

/** Reader-facing reason for an engine whose account was unusable (EngineError kinds). */
const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  quota: "subscription quota reached",
  rate_limit: "rate limited",
  auth: "subscription/auth expired",
  credential: "subscription/auth expired",
};

const DISPLAY_NAMES: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

/**
 * "⚠️ Codex unavailable (subscription quota reached): this review was done by Claude only." when an
 * engine failed because its account is unusable (quota, rate limit, auth, credential) and another
 * engine reviewed alone; null otherwise. A plain failure (timeout, invalid output) keeps the
 * `reviewedBy` wording only. One line per unavailable engine.
 */
export function unavailableBanner(engines: readonly EngineRunSummary[]): string | null {
  const ok = engines.filter((e) => e.status === "ok").map((e) => DISPLAY_NAMES[e.engine] ?? e.engine);
  if (ok.length === 0) return null;
  const lines = engines.flatMap((e) => {
    const reason = e.status === "failed" ? UNAVAILABLE_REASONS[e.errorKind ?? ""] : undefined;
    return reason === undefined
      ? []
      : [`⚠️ ${DISPLAY_NAMES[e.engine] ?? e.engine} unavailable (${reason}): this review was done by ${ok.join(" and ")} only.`];
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Link to the reviewed line(s) at the head commit. Path segments are URL-encoded. */
export function blobUrl(repo: string, head: string, path: string, line: number | null, endLine?: number | null): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
  let anchor = "";
  if (line !== null && line >= 1) {
    anchor = endLine !== null && endLine !== undefined && endLine > line ? `#L${line}-L${endLine}` : `#L${line}`;
  }
  return `https://github.com/${repo}/blob/${head}/${encoded}${anchor}`;
}

/** "a.ts:12" or "a.ts:12-14" (LEFT side noted). */
export function locationText(f: Pick<MergedFinding, "path" | "line" | "end_line" | "side">): string {
  const range = f.end_line !== null && f.end_line > f.line ? `${f.line}-${f.end_line}` : `${f.line}`;
  return `${f.path}:${range}${f.side === "LEFT" ? " (old)" : ""}`;
}

/** Human status tags for a finding, e.g. ["outside diff", "unverified (budget)"]. */
export function findingTags(f: MergedFinding, redacted: boolean): string[] {
  const tags: string[] = [];
  if (f.outside_diff) tags.push("outside diff");
  if (f.verification === "unverified_budget") tags.push("unverified (budget)");
  if (f.verification === "unverified_error") tags.push("unverified (error)");
  if (f.verification === "rejected") tags.push("unconfirmed");
  if (redacted) tags.push("contains redacted content");
  return tags;
}

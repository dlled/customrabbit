// §7.2 merge pipeline: validate → anchor → fingerprint → cluster → damp → dedupe against history →
// verify single-source blockers → blocking → order and place.

import { z } from "zod";
import { parseReviewExtras } from "../engines/schema.js";
import type {
  EngineChange,
  EngineCheck,
  EngineEffort,
  EngineName,
  EngineRelated,
  MergedFinding,
  Verification,
} from "../types.js";
import { ENGINE_NAMES } from "../types.js";
import { isBlocking } from "./blocking.js";
import { cluster, reduceCluster, type Candidate, type ClusteredFinding } from "./cluster.js";
import { fingerprint } from "./fingerprint.js";
import { orderFindings, placeFindings } from "./profile.js";
import { meetsThreshold } from "./severity.js";
import {
  assertSources,
  DEFAULT_VERIFY_BUDGET,
  type DropCounts,
  type EngineOutputInput,
  type ExternalSupport,
  type MergeOptions,
  type Placement,
  type PriorThread,
  type VerifyRequest,
} from "./types.js";
import { emptyDrops, validateEngineOutput } from "./validate.js";
import { verifyAll, verifyOrder } from "./verify.js";

/** What the renderer needs beyond MergedFinding (§8.6 inline comment layout). */
export interface FindingDetails {
  failure_scenario: string;
  evidence: string[];
  rule: string | null;
}

export interface EngineSummary {
  engine: EngineName;
  summary: string;
  changes: EngineChange[];
  // design-v2 §8 fields, each present only when the engine gave a valid, non-empty value (invalid
  // values are "not provided" and never drop the output). Labels and related items are filtered
  // to `MergeOptions.labelNames` / `candidateNumbers`.
  effort?: EngineEffort;
  checks?: EngineCheck[];
  labels?: string[];
  related?: EngineRelated[];
}

export interface MergeResult {
  /** Engines whose output passed validation, in canonical order. */
  sources: EngineName[];
  /** New findings, ordered by blocking, severity, confidence (§7.2 step 8). */
  findings: MergedFinding[];
  /** Keyed by MergedFinding.fingerprint (unique among `findings`). */
  details: Map<string, FindingDetails>;
  engineSummaries: EngineSummary[];
  drops: DropCounts;
  placement: Placement;
  /** Number of verify calls made (≤ budget). */
  verifyCalls: number;
  /**
   * `opts.priorThreads` with this run's supersessions applied (state "superseded"). Pass this, not
   * the input list, to the resolve step, computeVerdict and buildRunDocument.
   */
  priorThreads: PriorThread[];
  /**
   * For each thread superseded in this run: old thread fingerprint → fingerprint of the new blocking
   * finding that replaces it. The new finding keeps its cluster lead's fingerprint, which can differ
   * from the old thread's when the cluster joined findings from both engines.
   */
  supersededBy: Map<string, string>;
}

const changeSchema = z.object({
  area: z.string(),
  files: z.array(z.string()),
  summary: z.string(),
});

function engineSummary(engine: EngineName, raw: unknown, opts: MergeOptions): EngineSummary {
  const rec = raw as { summary: string; changes: unknown[] };
  const changes = rec.changes.flatMap((c) => {
    const p = changeSchema.safeParse(c);
    return p.success ? [p.data] : [];
  });
  const out: EngineSummary = { engine, summary: rec.summary, changes };
  const extras = parseReviewExtras(raw);
  if (extras.effort) out.effort = extras.effort;
  if (extras.checks && extras.checks.length > 0) out.checks = extras.checks;
  const allowed = opts.labelNames;
  const labels = [...new Set(extras.labels ?? [])].filter((l) => allowed?.has(l) === true);
  if (labels.length > 0) out.labels = labels;
  const seen = new Set<number>();
  const related = (extras.related ?? []).filter((r) => {
    if (opts.candidateNumbers?.has(r.number) !== true || seen.has(r.number)) return false;
    seen.add(r.number);
    return true;
  });
  if (related.length > 0) out.related = related;
  return out;
}

/** design-v2 §7.4.3: some member cites an external item's rule at its path and line. */
function isSupported(c: ClusteredFinding, support: readonly ExternalSupport[]): boolean {
  return c.members.some((m) => {
    const rule = m.rule?.trim();
    if (rule === undefined || rule === "" || m.side !== "RIGHT") return false;
    const end = m.end_line ?? m.line;
    return support.some((s) => s.rule === rule && s.path === m.path && s.line >= m.line && s.line <= end);
  });
}

export async function mergeReview(
  outputs: readonly EngineOutputInput[],
  opts: MergeOptions,
): Promise<MergeResult> {
  const drops = emptyDrops();

  // 1-2. Validate, anchor, fingerprint.
  const candidates: Candidate[] = [];
  const contributed = new Set<EngineName>();
  const engineSummaries: EngineSummary[] = [];
  for (const { engine, output } of outputs) {
    const res = validateEngineOutput(engine, output, opts.diffPaths, drops);
    if (!res.ok) continue;
    contributed.add(engine);
    engineSummaries.push(engineSummary(engine, output, opts));
    for (const f of res.findings) {
      candidates.push({
        ...f,
        fingerprint: fingerprint(f.path, f.category, f.title),
        outside_diff: !opts.anchors.isAnchored(f.path, f.side, f.line, f.end_line),
        index: candidates.length,
      });
    }
  }
  const sources = ENGINE_NAMES.filter((e) => contributed.has(e));
  // §2.2: with no usable engine output there is nothing to decide on; never fall through to APPROVE.
  assertSources(sources);

  // 3-4. Cluster and damp.
  const clustered = cluster(candidates).map(reduceCluster);

  // 5. Dedupe against prior myrabbit threads. A match with a dismissed thread or a blocking open
  // thread drops the finding. A match with only non-blocking (blk=0) open threads keeps it
  // tentatively: if it ends up blocking it supersedes those threads, otherwise it is dropped (below).
  const openBlocking = new Set<string>();
  const openNonBlocking = new Set<string>();
  const dismissedFps = new Set<string>();
  for (const t of opts.priorThreads) {
    if (t.state === "open") (t.marker.blk ? openBlocking : openNonBlocking).add(t.marker.fp);
    else if (t.state === "dismissed") dismissedFps.add(t.marker.fp);
  }
  const drafts: Draft[] = [];
  for (const c of clustered) {
    const fps = [...c.fingerprints];
    if (fps.some((fp) => dismissedFps.has(fp))) {
      drops.duplicate_dismissed++;
      continue;
    }
    if (fps.some((fp) => openBlocking.has(fp))) {
      drops.duplicate_open++;
      continue;
    }
    drafts.push({ c, f: toDraft(c), supersedes: fps.filter((fp) => openNonBlocking.has(fp)) });
  }

  // 6. Verify single-source findings that could block. Those that static analysis supports
  // (design-v2 §7.4.3) are verified already and use no verify call.
  const support = opts.externalSupport ?? [];
  const supported = new Set(
    support.length === 0 ? [] : drafts.filter((d) => needsVerification(d.f, opts) && isSupported(d.c, support)),
  );
  const pending = drafts
    .filter((d) => needsVerification(d.f, opts) && !supported.has(d))
    .sort((a, b) => verifyOrder(a.f, b.f) || a.c.lead.index - b.c.lead.index);
  for (const d of drafts) d.f.verification = supported.has(d) ? "verified" : initialVerification(d.f, opts);
  const requests: VerifyRequest[] = pending.map(({ c, f }) => ({
    finding: f,
    failure_scenario: c.lead.failure_scenario,
    evidence: c.evidence,
    rule: c.lead.rule,
  }));
  const budget = opts.verifyBudget ?? DEFAULT_VERIFY_BUDGET;
  const outcomes = await verifyAll(requests, opts.verify, {
    budget,
    concurrency: opts.verifyConcurrency ?? 2,
    timeoutMs: opts.verifyTimeoutMs,
  });
  pending.forEach(({ f }, i) => {
    f.verification = outcomes[i] ?? "unverified_error";
  });

  // 7. Blocking. A tentative finding that does not block is the open blk=0 thread again: drop it.
  for (const { f } of drafts) f.blocking = isBlocking(f, opts.threshold);
  const superseded = new Map<string, string>();
  const final = drafts.filter((d) => {
    if (d.supersedes.length === 0) return true;
    if (!d.f.blocking) {
      drops.duplicate_open++;
      return false;
    }
    for (const fp of d.supersedes) if (!superseded.has(fp)) superseded.set(fp, d.f.fingerprint);
    return true;
  });
  const priorThreads = opts.priorThreads.map((t) =>
    t.state === "open" && !t.marker.blk && superseded.has(t.marker.fp)
      ? { ...t, state: "superseded" as const }
      : t,
  );

  // 8. Order and place.
  const placement = placeFindings(
    final.map((d) => d.f),
    opts.profile,
    opts.maxInlineComments,
  );

  const details = new Map<string, FindingDetails>();
  for (const { c, f } of final) {
    details.set(f.fingerprint, {
      failure_scenario: c.lead.failure_scenario,
      evidence: c.evidence,
      rule: c.lead.rule,
    });
  }

  return {
    sources,
    findings: orderFindings(final.map((d) => d.f)),
    details,
    engineSummaries,
    drops,
    placement,
    verifyCalls: Math.min(Math.max(0, Math.floor(budget)), requests.length),
    priorThreads,
    supersededBy: superseded,
  };
}

interface Draft {
  c: ClusteredFinding;
  f: MergedFinding;
  /** Fingerprints of open blk=0 threads this finding replaces if it ends up blocking. */
  supersedes: string[];
}

function toDraft(c: ClusteredFinding): MergedFinding {
  const { location, lead } = c;
  return {
    path: location.path,
    line: location.line,
    end_line: location.end_line,
    side: location.side,
    severity: c.severity,
    category: lead.category,
    summary: lead.title,
    body: lead.body,
    failure_scenario: lead.failure_scenario,
    rule: lead.rule,
    suggestion: c.suggestion,
    blocking: false,
    sources: c.sources,
    confidence: c.confidence,
    fingerprint: lead.fingerprint,
    status: "new",
    outside_diff: location.outside_diff,
    verification: "not_needed",
    synthetic: false,
  };
}

/** Single-source, at or above the threshold, and able to block at all (§7.2 step 7). */
function needsVerification(f: MergedFinding, opts: MergeOptions): boolean {
  return (
    f.sources.length < 2 &&
    meetsThreshold(f.severity, opts.threshold) &&
    (!f.outside_diff || f.severity === "critical")
  );
}

function initialVerification(f: MergedFinding, opts: MergeOptions): Verification {
  if (f.sources.length >= 2) return "agreed";
  return needsVerification(f, opts) ? "unverified_budget" : "not_needed";
}

import { describe, expect, it } from "vitest";
import { isBlocking } from "../../src/merge/blocking.js";
import { coverageFinding } from "../../src/merge/coverage.js";
import { NoEngineOutputError, type CoverageGap, type PriorThread } from "../../src/merge/types.js";
import { computeVerdict } from "../../src/merge/verdict.js";
import type { MergedFinding, Severity, Threshold, Verification } from "../../src/types.js";
import { merged, prior } from "./helpers.js";

// §7.2 step 7, written out by hand (not recomputed from the expression under test).
//   threshold | severity | #sources | verification | outside_diff | blocking
const BLOCKING_TABLE: [Threshold, Severity, 1 | 2, Verification, boolean, boolean][] = [
  ["major", "critical", 2, "agreed", false, true],
  ["major", "critical", 2, "agreed", true, true], // agreement verifies an outside-diff critical
  ["major", "major", 2, "agreed", false, true],
  ["major", "major", 2, "agreed", true, false], // outside diff blocks only when critical
  ["major", "minor", 2, "agreed", false, false], // below threshold
  ["major", "trivial", 2, "agreed", false, false],
  ["major", "major", 1, "verified", false, true],
  ["major", "major", 1, "rejected", false, false], // a rejection demotes
  ["major", "major", 1, "unverified_budget", false, true], // budget never turns into APPROVE
  ["major", "major", 1, "unverified_error", false, true],
  ["major", "major", 1, "not_needed", false, false],
  ["major", "critical", 1, "verified", true, true],
  ["major", "critical", 1, "unverified_budget", true, true],
  ["major", "critical", 1, "unverified_error", true, true],
  ["major", "critical", 1, "rejected", true, false],
  ["major", "major", 1, "verified", true, false],
  ["major", "minor", 1, "verified", false, false],
  ["minor", "minor", 1, "verified", false, true],
  ["minor", "minor", 2, "agreed", false, true],
  ["minor", "trivial", 2, "agreed", false, false], // trivial never blocks
  ["critical", "major", 2, "agreed", false, false],
  ["critical", "critical", 1, "verified", false, true],
  ["critical", "critical", 1, "rejected", false, false],
];

describe("blocking expression truth table (§7.2 step 7)", () => {
  it.each(BLOCKING_TABLE)(
    "threshold=%s severity=%s sources=%d verification=%s outside_diff=%s → %s",
    (threshold, severity, n, verification, outside_diff, expected) => {
      const f = merged({
        severity,
        sources: n === 2 ? ["claude", "codex"] : ["codex"],
        verification,
        outside_diff,
      });
      expect(isBlocking(f, threshold)).toBe(expected);
    },
  );
});

// §7.4: new findings ∪ prior threads (blk, sev vs current threshold, state) ∪ coverage.
interface Row {
  name: string;
  findings?: MergedFinding[];
  threads?: PriorThread[];
  threshold?: Threshold;
  coverage?: CoverageGap | null;
  verdict: "APPROVE" | "REQUEST_CHANGES";
}

const VERDICT_TABLE: Row[] = [
  { name: "nothing at all", verdict: "APPROVE" },
  { name: "a blocking new finding", findings: [merged({ blocking: true })], verdict: "REQUEST_CHANGES" },
  {
    name: "only non-blocking new findings",
    findings: [merged({ severity: "minor" }), merged({ verification: "rejected" })],
    verdict: "APPROVE",
  },
  { name: "prior blk=1 major, open", threads: [prior()], verdict: "REQUEST_CHANGES" },
  {
    name: "prior blk=0 critical, open (never re-blocks)",
    threads: [prior({ marker: { v: 1, fp: "bbbbbbbbbbbb", sev: "critical", blk: false } })],
    verdict: "APPROVE",
  },
  {
    name: "prior blk=1 minor, open, threshold major",
    threads: [prior({ marker: { v: 1, fp: "cccccccccccc", sev: "minor", blk: true } })],
    verdict: "APPROVE",
  },
  {
    name: "prior blk=1 minor, open, threshold minor",
    threads: [prior({ marker: { v: 1, fp: "cccccccccccc", sev: "minor", blk: true } })],
    threshold: "minor",
    verdict: "REQUEST_CHANGES",
  },
  {
    name: "prior blk=1 major, open, base threshold now critical",
    threads: [prior()],
    threshold: "critical",
    verdict: "APPROVE",
  },
  { name: "prior blk=1 major, addressed", threads: [prior({ state: "addressed" })], verdict: "APPROVE" },
  {
    name: "prior blk=1 critical, dismissed by a human (Q9)",
    threads: [prior({ state: "dismissed", marker: { v: 1, fp: "dddddddddddd", sev: "critical", blk: true } })],
    verdict: "APPROVE",
  },
  {
    name: "coverage incomplete, nothing else",
    coverage: { notReviewed: 3, limit: "max_files 150" },
    verdict: "REQUEST_CHANGES",
  },
  {
    name: "coverage incomplete, threshold critical",
    coverage: { notReviewed: 1, limit: "max_diff_bytes 400000" },
    threshold: "critical",
    verdict: "REQUEST_CHANGES",
  },
  { name: "coverage gap of 0 files", coverage: { notReviewed: 0, limit: "max_files 150" }, verdict: "APPROVE" },
  {
    name: "mixed: addressed blocker + non-blocking new finding",
    findings: [merged({ severity: "trivial" })],
    threads: [prior({ state: "addressed" }), prior({ state: "dismissed" })],
    verdict: "APPROVE",
  },
];

describe("verdict truth table (§7.4)", () => {
  it.each(VERDICT_TABLE)("$name → $verdict", (row) => {
    const res = computeVerdict({
      findings: row.findings ?? [],
      priorThreads: row.threads ?? [],
      threshold: row.threshold ?? "major",
      coverage: row.coverage ?? null,
      sources: ["claude", "codex"],
    });
    expect(res.verdict).toBe(row.verdict);
  });

  it("reports what blocked", () => {
    const open = prior();
    const res = computeVerdict({
      findings: [merged({ blocking: true }), merged()],
      priorThreads: [open, prior({ state: "addressed" })],
      threshold: "major",
      coverage: { notReviewed: 2, limit: "max_files 150" },
      sources: ["claude"],
    });
    expect(res.blockingFindings).toHaveLength(1);
    expect(res.blockingThreads).toEqual([open]);
    expect(res.coverage?.synthetic).toBe(true);
  });
});

describe("no engine output (§2.2)", () => {
  it("refuses to decide instead of returning APPROVE", () => {
    expect(() =>
      computeVerdict({ findings: [], priorThreads: [], threshold: "major", coverage: null, sources: [] }),
    ).toThrow(NoEngineOutputError);
  });
});

describe("superseded threads", () => {
  it("never block, even if the marker says blk=1", () => {
    const res = computeVerdict({
      findings: [],
      priorThreads: [prior({ state: "superseded" })],
      threshold: "major",
      coverage: null,
      sources: ["claude"],
    });
    expect(res.verdict).toBe("APPROVE");
  });
});

describe("coverage finding (§7.5)", () => {
  it("is synthetic, critical, blocking by construction, with the §7.5 text", () => {
    const f = coverageFinding({ notReviewed: 4, limit: "max_files 150" }, ["claude", "codex"]);
    expect(f).toMatchObject({
      synthetic: true,
      blocking: true,
      severity: "critical",
      outside_diff: true,
      sources: ["claude", "codex"],
      status: "new",
    });
    expect(f.body).toBe(
      "Review incomplete: 4 files not reviewed (limit max_files 150). Split the PR or raise `limits` on the base branch.",
    );
  });

  it("alone gives REQUEST_CHANGES", () => {
    const res = computeVerdict({
      findings: [],
      priorThreads: [],
      threshold: "critical",
      coverage: { notReviewed: 1, limit: "max_files 150" },
      sources: ["codex"],
    });
    expect(res.verdict).toBe("REQUEST_CHANGES");
    expect(res.blockingFindings).toEqual([]);
    expect(res.blockingThreads).toEqual([]);
    expect(res.coverage?.blocking).toBe(true);
  });
});

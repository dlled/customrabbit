// design-v2 §4.2 merge risk: the row table and the biconditional
//   blocking set ≠ ∅ ⇔ risk ≥ moderate ⇔ REQUEST_CHANGES
// checked over every combination of blocking-set items, open non-blocking findings and checks.

import { describe, expect, it } from "vitest";
import { mergeRisk, RiskError, riskAtLeast, riskBlocks } from "../../src/merge/risk.js";
import { computeVerdict, type SyntheticBlocker } from "../../src/merge/verdict.js";
import type { PriorThread } from "../../src/merge/types.js";
import {
  RISKS,
  SYNTHETIC_BLOCKER_KINDS,
  type MergedFinding,
  type Risk,
  type RunCheck,
  type Severity,
} from "../../src/types.js";
import { merged, prior } from "./helpers.js";

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("missing test value");
  return x;
}


const finding = (severity: Severity, extra: Partial<MergedFinding> = {}): MergedFinding =>
  merged({ severity, blocking: true, sources: ["claude", "codex"], verification: "agreed", ...extra });
const thread = (sev: Severity, extra: Partial<PriorThread> = {}): PriorThread =>
  prior({ marker: { v: 1, fp: "aaaaaaaaaaaa", sev, blk: true }, ...extra });
const check = (mode: RunCheck["mode"], status: RunCheck["status"], name = "title"): RunCheck => ({
  name,
  mode,
  status,
  explanation: "x",
});

/** One possible member of the blocking set, with the row it should raise risk to. */
interface Atom {
  name: string;
  risk: Risk;
  finding?: MergedFinding;
  thread?: PriorThread;
  coverage?: true;
  synthetic?: SyntheticBlocker;
  /** A failed error-mode check goes with its synthetic blocker (§5.3). */
  check?: RunCheck;
}

const ATOMS: Atom[] = [
  { name: "new critical", risk: "critical", finding: finding("critical") },
  { name: "new major", risk: "high", finding: finding("major") },
  { name: "new minor (threshold minor)", risk: "moderate", finding: finding("minor") },
  {
    name: "new minor unverified (budget)",
    risk: "moderate",
    finding: finding("minor", { sources: ["codex"], verification: "unverified_budget" }),
  },
  { name: "prior critical thread", risk: "critical", thread: thread("critical") },
  { name: "prior major thread", risk: "high", thread: thread("major") },
  { name: "prior minor thread", risk: "moderate", thread: thread("minor") },
  { name: "v1 coverage", risk: "moderate", coverage: true },
  {
    name: "secret hit",
    risk: "critical",
    synthetic: { kind: "secret", severity: "critical", title: "Possible secret committed (`aws`) at `a.ts:3`" },
  },
  {
    name: "secret scan did not run",
    risk: "moderate",
    synthetic: { kind: "coverage", severity: "critical", title: "Secret scan did not run (timeout)" },
  },
  {
    name: "failed error-mode check",
    risk: "high",
    synthetic: { kind: "check", severity: "major", title: "Pre-merge check failed: title — too vague" },
    check: check("error", "fail"),
  },
];

function run(atoms: readonly Atom[], openNonBlocking: number, checks: RunCheck[]): { risk: Risk; verdict: string } {
  const verdict = computeVerdict({
    findings: atoms.flatMap((a) => (a.finding ? [a.finding] : [])),
    priorThreads: atoms.flatMap((a) => (a.thread ? [a.thread] : [])),
    threshold: "minor",
    coverage: atoms.some((a) => a.coverage) ? { notReviewed: 3, limit: "max_files 150" } : null,
    sources: ["claude", "codex"],
    syntheticBlockers: atoms.flatMap((a) => (a.synthetic ? [a.synthetic] : [])),
  });
  const allChecks = [...checks, ...atoms.flatMap((a) => (a.check ? [a.check] : []))];
  return { risk: mergeRisk({ verdict, openNonBlocking, checks: allChecks }), verdict: verdict.verdict };
}

describe("merge risk truth table (design-v2 §4.2)", () => {
  it("blocking set ≠ ∅ ⇔ risk ≥ moderate ⇔ REQUEST_CHANGES, and the top row that holds wins", () => {
    let cases = 0;
    for (let mask = 0; mask < 1 << ATOMS.length; mask++) {
      const atoms = ATOMS.filter((_, i) => (mask & (1 << i)) !== 0);
      for (const open of [0, 2]) {
        for (const warn of [[], [check("warning", "fail", "description")], [check("warning", "pass", "description")]]) {
          for (const extra of [[], [check("error", "pass", "docs"), check("error", "inconclusive", "x")]]) {
            const checks = [...warn, ...extra];
            const { risk, verdict } = run(atoms, open, checks);
            const blocked = atoms.length > 0;
            // The biconditional.
            expect(riskBlocks(risk)).toBe(blocked);
            expect(verdict === "REQUEST_CHANGES").toBe(blocked);
            // The row.
            const expected: Risk = blocked
              ? must(RISKS.find((r) => atoms.some((a) => a.risk === r)))
              : open > 0 || warn.some((c) => c.status === "fail")
                ? "low"
                : "minimal";
            expect(risk, `${atoms.map((a) => a.name).join(" + ")} open=${open}`).toBe(expected);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe((1 << ATOMS.length) * 12);
  });

  it.each([
    ["critical", [must(ATOMS[8]), must(ATOMS[2])]],
    ["high", [must(ATOMS[10]), must(ATOMS[7])]],
    ["moderate", [must(ATOMS[7])]],
    ["moderate", [must(ATOMS[9])]],
  ] as const)("names %s for a representative set", (want, atoms) => {
    expect(run(atoms, 0, []).risk).toBe(want);
  });

  it("a critical blocker the verifier never reached stays critical (risk errs upwards)", () => {
    const atom: Atom = {
      name: "unverified critical",
      risk: "critical",
      finding: finding("critical", { sources: ["claude"], verification: "unverified_error" }),
    };
    expect(run([atom], 0, []).risk).toBe("critical");
  });

  it("inconclusive and passing checks never raise risk; a warning fail gives low", () => {
    expect(run([], 0, [check("error", "inconclusive"), check("warning", "inconclusive")]).risk).toBe("minimal");
    expect(run([], 0, [check("warning", "fail")]).risk).toBe("low");
    expect(run([], 1, []).risk).toBe("low");
  });

  it("refuses a failed error-mode check that is missing from the blocking set", () => {
    const verdict = computeVerdict({ findings: [], priorThreads: [], threshold: "major", coverage: null, sources: ["claude"] });
    expect(() => mergeRisk({ verdict, openNonBlocking: 0, checks: [check("error", "fail")] })).toThrow(RiskError);
  });

  it("refuses a verdict that contradicts its own blocking set", () => {
    const verdict = computeVerdict({ findings: [], priorThreads: [], threshold: "major", coverage: null, sources: ["claude"] });
    expect(() => mergeRisk({ verdict: { ...verdict, verdict: "REQUEST_CHANGES" }, openNonBlocking: 0, checks: [] })).toThrow(
      RiskError,
    );
    const blocked = computeVerdict({
      findings: [finding("major")],
      priorThreads: [],
      threshold: "major",
      coverage: null,
      sources: ["claude"],
    });
    expect(() => mergeRisk({ verdict: { ...blocked, verdict: "APPROVE" }, openNonBlocking: 0, checks: [] })).toThrow(RiskError);
  });

  it("ranks synthetic items by their kind, not by the finding's category", () => {
    for (const kind of SYNTHETIC_BLOCKER_KINDS) {
      const verdict = computeVerdict({
        findings: [],
        priorThreads: [],
        threshold: "major",
        coverage: null,
        sources: ["claude"],
        syntheticBlockers: [{ kind, severity: "minor", title: "t" }],
      });
      expect(verdict.syntheticItems).toEqual([{ kind, finding: verdict.synthetic[0] }]);
      expect(verdict.syntheticItems[0]?.finding).toBe(verdict.synthetic[0]);
      // A category that would have meant another kind under inference changes nothing.
      for (const f of verdict.synthetic) f.category = kind === "secret" ? "reliability" : "security";
      const checks = kind === "check" ? [check("error", "fail")] : [];
      expect(mergeRisk({ verdict, openNonBlocking: 0, checks })).toBe({ secret: "critical", check: "high", coverage: "moderate" }[kind]);
    }
  });

  it("refuses a verdict whose synthetic lists disagree", () => {
    const verdict = computeVerdict({
      findings: [],
      priorThreads: [],
      threshold: "major",
      coverage: null,
      sources: ["claude"],
      syntheticBlockers: [{ kind: "secret", severity: "critical", title: "s" }],
    });
    expect(() => mergeRisk({ verdict: { ...verdict, syntheticItems: [] }, openNonBlocking: 0, checks: [] })).toThrow(RiskError);
    const copy = { ...must(verdict.synthetic[0]) };
    expect(() =>
      mergeRisk({ verdict: { ...verdict, syntheticItems: [{ kind: "secret", finding: copy }] }, openNonBlocking: 0, checks: [] }),
    ).toThrow(RiskError);
  });

  it("orders risks", () => {
    expect(riskAtLeast("critical", "moderate")).toBe(true);
    expect(riskAtLeast("low", "moderate")).toBe(false);
    expect(RISKS.filter(riskBlocks)).toEqual(["critical", "high", "moderate"]);
  });
});

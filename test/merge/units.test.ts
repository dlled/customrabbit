import { describe, expect, it } from "vitest";
import { TupleAnchorMap } from "../../src/merge/anchor.js";
import {
  cluster,
  dampSeverity,
  evidenceBeyondAnchor,
  reduceCluster,
  sameIssue,
  type Candidate,
} from "../../src/merge/cluster.js";
import { fingerprint, jaccard, normalizeTitle, titleTokens } from "../../src/merge/fingerprint.js";
import { emptyDrops, LIMITS, validateEngineOutput } from "../../src/merge/validate.js";
import { engineFinding, fixtureDiffPaths, output } from "./helpers.js";
import type { EngineFinding, EngineName } from "../../src/types.js";

describe("fingerprint (§7.1)", () => {
  it("normalizes case, punctuation, digits, backticked identifiers and whitespace", () => {
    expect(normalizeTitle("Off-by-one in `slice()`  at line 42!")).toBe("off by one in at line");
    expect(normalizeTitle("  Ünïcode   Läuft\tok ")).toBe("ünïcode läuft ok");
  });

  it("is 12 hex chars, stable, and independent of line numbers and identifiers", () => {
    const a = fingerprint("src/a.ts", "correctness", "Off-by-one in `slice` at line 10");
    const b = fingerprint("src/a.ts", "correctness", "off by one in `substring` at line 99.");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
    expect(fingerprint("src/b.ts", "correctness", "Off-by-one in at line")).not.toBe(a);
    expect(fingerprint("src/a.ts", "security", "Off-by-one in at line")).not.toBe(a);
  });

  it("pins the hash input format", () => {
    // sha1("src/a.ts\0correctness\0null deref")[:12], computed with shasum.
    expect(fingerprint("src/a.ts", "correctness", "Null deref")).toBe("048e602b0046");
  });

  it("computes token Jaccard", () => {
    expect(jaccard(titleTokens("a b c"), titleTokens("a b d"))).toBe(0.5);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("validate (§7.2 step 1)", () => {
  const run = (findings: unknown[], diff = fixtureDiffPaths) => {
    const drops = emptyDrops();
    const res = validateEngineOutput("claude", output(findings), diff, drops);
    return { res, drops };
  };

  it("drops findings without failure_scenario or evidence and counts each reason", () => {
    const { res, drops } = run([
      engineFinding(),
      engineFinding({ failure_scenario: "   " }),
      { ...engineFinding(), failure_scenario: undefined },
      engineFinding({ evidence: [] }),
      engineFinding({ evidence: ["  "] }),
      engineFinding({ path: "elsewhere.ts" }),
      engineFinding({ severity: "blocker" as never }),
      engineFinding({ line: 10, end_line: 9 }),
      "not an object",
    ]);
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(drops).toMatchObject({
      missing_failure_scenario: 3,
      missing_evidence: 2,
      path_not_in_diff: 1,
      invalid_finding: 2,
    });
  });

  it("rejects a whole output that is not the §5.1 shape", () => {
    const drops = emptyDrops();
    expect(validateEngineOutput("codex", { findings: "x" }, fixtureDiffPaths, drops).ok).toBe(false);
    expect(validateEngineOutput("codex", null, fixtureDiffPaths, drops).ok).toBe(false);
    expect(drops.invalid_output).toBe(2);
  });

  it("truncates long strings, normalizes the path and collapses end_line == line", () => {
    const { res, drops } = run([
      engineFinding({
        path: "./src/util.ts",
        title: "t".repeat(500),
        body: "b".repeat(5000),
        end_line: 5,
      }),
    ]);
    const f = res.findings[0];
    expect(f?.path).toBe("src/util.ts");
    expect(f?.title).toHaveLength(LIMITS.title);
    expect(f?.title.endsWith("…")).toBe(true);
    expect(f?.body).toHaveLength(LIMITS.body);
    expect(f?.end_line).toBeNull();
    expect(drops.truncated).toBe(1);
  });

  it("drops suggestions on LEFT or longer than 15 lines, never truncating them", () => {
    const { res } = run([
      engineFinding({ side: "LEFT", suggestion: "x" }),
      engineFinding({ suggestion: Array(16).fill("x").join("\n") }),
      engineFinding({ suggestion: Array(15).fill("x").join("\n") + "\n" }),
    ]);
    expect(res.findings.map((f) => f.suggestion === null)).toEqual([true, true, false]);
  });
});

describe("anchor map (§8.2)", () => {
  const map = new TupleAnchorMap([
    { path: "a.ts", side: "RIGHT", line: 1, hunk: 0 },
    { path: "a.ts", side: "RIGHT", line: 2, hunk: 0 },
    { path: "a.ts", side: "RIGHT", line: 3, hunk: 1 },
    { path: "a.ts", side: "LEFT", line: 2, hunk: 0 },
  ]);
  it("requires every line of the range on one side in one hunk", () => {
    expect(map.isAnchored("a.ts", "RIGHT", 1, null)).toBe(true);
    expect(map.isAnchored("a.ts", "RIGHT", 1, 2)).toBe(true);
    expect(map.isAnchored("a.ts", "RIGHT", 2, 3)).toBe(false);
    expect(map.isAnchored("a.ts", "LEFT", 2, null)).toBe(true);
    expect(map.isAnchored("a.ts", "LEFT", 1, null)).toBe(false);
    expect(map.isAnchored("b.ts", "RIGHT", 1, null)).toBe(false);
  });
});

let idx = 0;
function cand(engine: EngineName, o: Partial<EngineFinding> = {}, outside = false): Candidate {
  const f = engineFinding(o);
  return {
    ...f,
    engine,
    fingerprint: fingerprint(f.path, f.category, f.title),
    outside_diff: outside,
    index: idx++,
  };
}

describe("clustering (§7.2 step 3)", () => {
  it("merges equal fingerprints regardless of distance", () => {
    expect(sameIssue(cand("claude", { line: 1 }), cand("codex", { line: 400 }))).toBe(true);
  });

  it("merges near findings with similar titles, honouring ±3 lines", () => {
    const a = cand("claude", { line: 10, end_line: 12, title: "Off by one in page end index" });
    expect(sameIssue(a, cand("codex", { line: 15, title: "Off by one in the page end" }))).toBe(true);
    expect(sameIssue(a, cand("codex", { line: 16, title: "Off by one in the page end" }))).toBe(false);
    expect(sameIssue(a, cand("codex", { line: 7, title: "Off by one in the page end" }))).toBe(true);
  });

  it("keeps apart different categories, paths, sides or dissimilar titles", () => {
    const a = cand("claude", { title: "Off by one in page end index" });
    const t = "Off by one in the page end";
    expect(sameIssue(a, cand("codex", { title: t, category: "testing" }))).toBe(false);
    expect(sameIssue(a, cand("codex", { title: t, path: "src/auth.ts" }))).toBe(false);
    expect(sameIssue(a, cand("codex", { title: t, side: "LEFT" }))).toBe(false);
    expect(sameIssue(a, cand("codex", { title: "Cache never cleared" }))).toBe(false);
  });

  it("clusters transitively and keeps first-member order", () => {
    const xs = [
      cand("claude", { line: 100, title: "Unrelated thing" }),
      cand("claude", { line: 1, title: "alpha beta gamma" }),
      cand("codex", { line: 4, title: "alpha beta delta" }),
      cand("codex", { line: 7, title: "beta delta" }),
    ];
    const groups = cluster(xs);
    expect(groups.map((g) => g.length)).toEqual([1, 3]);
  });

  it("takes text from the most confident member, location from an anchored one", () => {
    const anchored = cand("claude", { line: 5, confidence: 0.5, body: "low" });
    const outside = cand("codex", { line: 6, confidence: 0.9, body: "high" }, true);
    const r = reduceCluster([anchored, outside]);
    expect(r.lead.body).toBe("high");
    expect(r.location.line).toBe(5);
    expect(r.sources).toEqual(["claude", "codex"]);
    expect(r.confidence).toBe(0.9);
  });

  it("keeps a suggestion only when members agree (or one has one) at the chosen location", () => {
    const s = (a?: string | null, b?: string | null, bLine = 5) =>
      reduceCluster([
        cand("claude", { suggestion: a ?? null, confidence: 0.9 }),
        cand("codex", { suggestion: b ?? null, line: bLine, confidence: 0.5 }),
      ]).suggestion;
    expect(s("x", "x")).toBe("x");
    expect(s(null, "y")).toBe("y");
    expect(s("x", "y")).toBeNull();
    expect(s(null, "y", 6)).toBeNull(); // the suggestion targets other lines than the location
  });
});

describe("severity damping (§7.2 step 4)", () => {
  it("takes the lower severity on disagreement", () => {
    expect(
      dampSeverity([
        cand("claude", { severity: "critical", evidence: ["src/util.ts:5"] }),
        cand("codex", { severity: "minor" }),
      ]),
    ).toBe("minor");
  });

  it("keeps the higher one with ≥2 evidence refs when the lower has none beyond its anchor", () => {
    const hi = cand("codex", { severity: "critical", evidence: ["src/util.ts:5", "src/b.ts:3"] });
    expect(dampSeverity([hi, cand("claude", { evidence: ["src/util.ts:5"] })])).toBe("critical");
    expect(dampSeverity([hi, cand("claude", { evidence: ["src/util.ts:5", "src/c.ts:1"] })])).toBe(
      "major",
    );
  });

  it("counts evidence within the anchored range as the anchor", () => {
    expect(evidenceBeyondAnchor(cand("claude", { line: 5, end_line: 8, evidence: ["src/util.ts:6-7"] }))).toBe(0);
    expect(evidenceBeyondAnchor(cand("claude", { evidence: ["src/util.ts:9", "see docs"] }))).toBe(2);
  });

  it("leaves agreeing severities alone", () => {
    expect(dampSeverity([cand("claude"), cand("codex")])).toBe("major");
  });
});

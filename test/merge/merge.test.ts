import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../../src/merge/fingerprint.js";
import { mergeReview } from "../../src/merge/merge.js";
import { placeFindings } from "../../src/merge/profile.js";
import {
  NoEngineOutputError,
  type EngineOutputInput,
  type VerifyFn,
  type VerifyRequest,
} from "../../src/merge/types.js";
import { computeVerdict } from "../../src/merge/verdict.js";
import type { MergedFinding } from "../../src/types.js";
import { engineFinding, fixture, merged, options, output, prior } from "./helpers.js";

const BOTH: EngineOutputInput[] = [
  { engine: "claude", output: fixture("claude-output.json") },
  { engine: "codex", output: fixture("codex-output.json") },
];

const byTitle = (fs: MergedFinding[], s: string) => fs.find((f) => f.summary.includes(s));

describe("mergeReview on the fixture PR", () => {
  it("validates, anchors, clusters, damps, verifies and decides blocking", async () => {
    const verify = vi.fn<VerifyFn>(() =>
      Promise.resolve({ confirmed: true, reason: "ok", evidence: [] }),
    );
    const r = await mergeReview(BOTH, options({ verify }));

    expect(r.sources).toEqual(["claude", "codex"]);
    expect(r.drops).toMatchObject({
      missing_failure_scenario: 1,
      path_not_in_diff: 1,
      missing_evidence: 1,
      invalid_output: 0,
    });
    expect(r.findings).toHaveLength(5);

    // Claude's major + Codex's critical on the token compare: one cluster, critical kept because
    // Codex has 2 evidence refs and Claude has only its anchor. Text and location from Codex.
    const token = byTitle(r.findings, "timing attack");
    expect(token).toMatchObject({
      severity: "critical",
      sources: ["claude", "codex"],
      verification: "agreed",
      blocking: true,
      line: 13,
      body: "Using == on secrets leaks timing; use timingSafeEqual.",
      failure_scenario: "Remote attacker recovers a valid session token via timing.",
      rule: null,
      // Claude's suggestion targets line 12, not the chosen line 13, so it is dropped.
      suggestion: null,
      fingerprint: fingerprint("src/auth.ts", "security", "Token compared with == allows a timing attack"),
    });

    expect(byTitle(r.findings, "Off-by-one")).toMatchObject({
      path: "src/util.ts",
      sources: ["claude"],
      verification: "verified",
      blocking: true,
    });
    expect(byTitle(r.findings, "cache")).toMatchObject({
      outside_diff: true,
      severity: "critical",
      verification: "verified",
      blocking: true,
    });
    expect(byTitle(r.findings, "Rename")).toMatchObject({
      verification: "not_needed",
      blocking: false,
      failure_scenario: "Readers misuse doIt for refresh tokens.",
      rule: "Names describe intent (AGENTS.md)",
    });
    expect(byTitle(r.findings, "Prefer const")).toMatchObject({
      verification: "not_needed",
      blocking: false,
      suggestion: "const pageSize = 10;",
    });

    // Most severe first: the outside-diff critical is verified before the major.
    expect(verify.mock.calls.map(([req]) => req.finding.summary)).toEqual([
      "Page cache is never invalidated",
      "Off-by-one in `slice` end index",
    ]);
    expect(r.verifyCalls).toBe(2);

    // Ordered by blocking, severity, confidence.
    expect(r.findings.map((f) => f.summary)).toEqual([
      "Token compared with == allows a timing attack",
      "Page cache is never invalidated",
      "Off-by-one in `slice` end index",
      "Rename helper to describe its intent",
      "Prefer const for pageSize",
    ]);
    // chill: critical/major/minor inline; outside-diff and trivial go to the body.
    expect(r.placement.inline.map((f) => f.summary)).toEqual([
      "Token compared with == allows a timing attack",
      "Off-by-one in `slice` end index",
      "Rename helper to describe its intent",
    ]);
    expect(r.placement.body.map((f) => f.summary)).toEqual([
      "Page cache is never invalidated",
      "Prefer const for pageSize",
    ]);

    expect(r.engineSummaries.map((s) => s.changes.length)).toEqual([2, 1]);
    const tokenDetails = token ? r.details.get(token.fingerprint) : undefined;
    expect(tokenDetails?.failure_scenario).toBe(
      "Remote attacker recovers a valid session token via timing.",
    );
    expect(tokenDetails?.evidence).toEqual(["src/auth.ts:13", "src/session.ts:40", "src/auth.ts:12"]);
  });

  it("hands the verifier the finding's scenario, evidence and rule", async () => {
    const seen: VerifyRequest[] = [];
    await mergeReview(
      [{ engine: "codex", output: output([engineFinding({ rule: "Rule X" })]) }],
      options({
        verify: (req) => {
          seen.push(req);
          return Promise.resolve({ confirmed: true, reason: "", evidence: [] });
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      failure_scenario: "page(items, 0, 10) returns 9 items.",
      evidence: ["src/util.ts:5"],
      rule: "Rule X",
      finding: { sources: ["codex"], severity: "major" },
    });
  });

  it("demotes rejected single-model findings, keeping agreed ones", async () => {
    const r = await mergeReview(
      BOTH,
      options({ verify: () => Promise.resolve({ confirmed: false, reason: "no", evidence: [] }) }),
    );
    expect(r.findings.filter((f) => f.blocking).map((f) => f.verification)).toEqual(["agreed"]);
    expect(byTitle(r.findings, "Off-by-one")).toMatchObject({ verification: "rejected", blocking: false });
    expect(byTitle(r.findings, "cache")).toMatchObject({ verification: "rejected", blocking: false });
  });

  it("keeps findings blocking when the verifier errors", async () => {
    const r = await mergeReview(BOTH, options({ verify: () => Promise.reject(new Error("boom")) }));
    expect(byTitle(r.findings, "Off-by-one")).toMatchObject({
      verification: "unverified_error",
      blocking: true,
    });
    expect(byTitle(r.findings, "cache")).toMatchObject({ verification: "unverified_error", blocking: true });
  });

  it("treats a synchronous throw or a malformed answer as an error", async () => {
    const throwing: VerifyFn = () => {
      throw new Error("sync");
    };
    const malformed = (() => Promise.resolve({ reason: "?" })) as unknown as VerifyFn;
    for (const verify of [throwing, malformed]) {
      const r = await mergeReview(
        [{ engine: "claude", output: output([engineFinding()]) }],
        options({ verify }),
      );
      expect(r.findings[0]).toMatchObject({ verification: "unverified_error", blocking: true });
    }
  });

  it("times out a hanging verifier as an error, which stays blocking, and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const r = await mergeReview(
      [{ engine: "claude", output: output([engineFinding()]) }],
      options({
        verify: (_req, signal) => {
          seen = signal;
          return new Promise(() => undefined);
        },
        verifyTimeoutMs: 5,
      }),
    );
    expect(r.findings[0]).toMatchObject({ verification: "unverified_error", blocking: true });
    expect(seen?.aborted).toBe(true);
  });

  it("spends at most the budget (default 8), most severe first; the rest stay blocking", async () => {
    // Same line, disjoint one-word titles: no two findings cluster.
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const findings = words.map((title, i) =>
      engineFinding({ title, severity: i === 9 ? "critical" : "major", confidence: i / 10 }),
    );
    const verify = vi.fn<VerifyFn>(() => Promise.resolve({ confirmed: true, reason: "", evidence: [] }));
    const r = await mergeReview([{ engine: "codex", output: output(findings) }], options({ verify }));
    expect(r.findings).toHaveLength(10);
    expect(verify).toHaveBeenCalledTimes(8);
    expect(r.verifyCalls).toBe(8);
    // Critical first, then by confidence: the two least confident majors run out of budget.
    expect(verify.mock.calls[0]?.[0].finding.severity).toBe("critical");
    const budgeted = r.findings.filter((f) => f.verification === "unverified_budget");
    expect(budgeted.map((f) => f.confidence).sort()).toEqual([0, 0.1]);
    expect(budgeted.every((f) => f.blocking)).toBe(true);
    expect(r.findings.every((f) => f.blocking)).toBe(true);
  });

  it("with budget 0, every candidate is unverified (budget) and still blocks", async () => {
    const verify = vi.fn<VerifyFn>();
    const r = await mergeReview(BOTH, options({ verify, verifyBudget: 0 }));
    expect(verify).not.toHaveBeenCalled();
    expect(byTitle(r.findings, "cache")).toMatchObject({ verification: "unverified_budget", blocking: true });
  });

  it("does not verify findings that cannot block", async () => {
    const verify = vi.fn<VerifyFn>();
    const r = await mergeReview(
      [
        {
          engine: "claude",
          output: output([
            engineFinding({ severity: "minor" }),
            engineFinding({ title: "Outside the diff major", line: 99 }),
          ]),
        },
      ],
      options({ verify }),
    );
    expect(verify).not.toHaveBeenCalled();
    expect(r.findings.map((f) => [f.verification, f.blocking, f.outside_diff])).toEqual([
      ["not_needed", false, true],
      ["not_needed", false, false],
    ]);
  });

  it("dedupes against open and human-dismissed threads, not addressed ones", async () => {
    const fp = fingerprint("src/util.ts", "correctness", "Off-by-one in `slice` end index");
    const marker = (f: string) => ({ v: 1 as const, fp: f, sev: "major" as const, blk: true });
    const run = (state: "open" | "addressed" | "dismissed") =>
      mergeReview(BOTH, options({ priorThreads: [prior({ marker: marker(fp), state })] }));

    const open = await run("open");
    expect(byTitle(open.findings, "Off-by-one")).toBeUndefined();
    expect(open.drops.duplicate_open).toBe(1);

    const dismissed = await run("dismissed");
    expect(byTitle(dismissed.findings, "Off-by-one")).toBeUndefined();
    expect(dismissed.drops.duplicate_dismissed).toBe(1);

    const addressed = await run("addressed");
    expect(byTitle(addressed.findings, "Off-by-one")).toBeDefined();
  });

  it("matches history on any cluster member's fingerprint", async () => {
    // Claude's title for the token issue differs from Codex's (the cluster's lead).
    const claudeFp = fingerprint("src/auth.ts", "security", "Token compared with `==` allows timing attack");
    const r = await mergeReview(
      BOTH,
      options({ priorThreads: [prior({ marker: { v: 1, fp: claudeFp, sev: "major", blk: true } })] }),
    );
    expect(byTitle(r.findings, "timing")).toBeUndefined();
  });

  it("continues with one engine when the other's output is invalid", async () => {
    const r = await mergeReview(
      [
        { engine: "claude", output: fixture("claude-output.json") },
        { engine: "codex", output: { nope: true } },
      ],
      options(),
    );
    expect(r.sources).toEqual(["claude"]);
    expect(r.drops.invalid_output).toBe(1);
    expect(byTitle(r.findings, "timing")).toMatchObject({ sources: ["claude"], verification: "verified" });
  });

  it("dedupes the same issue reported twice by one engine", async () => {
    const r = await mergeReview(
      [{ engine: "codex", output: output([engineFinding(), engineFinding({ line: 6 })]) }],
      options(),
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.sources).toEqual(["codex"]);
  });
});

describe("no engine output (§2.2)", () => {
  it("throws NoEngineOutputError when every output fails validation", async () => {
    await expect(
      mergeReview(
        [
          { engine: "claude", output: { findings: "nope" } },
          { engine: "codex", output: null },
        ],
        options(),
      ),
    ).rejects.toBeInstanceOf(NoEngineOutputError);
  });

  it("throws NoEngineOutputError for empty outputs", async () => {
    await expect(mergeReview([], options())).rejects.toBeInstanceOf(NoEngineOutputError);
  });

  it("does not throw when an engine contributed zero findings", async () => {
    const r = await mergeReview([{ engine: "codex", output: output([]) }], options());
    expect(r.sources).toEqual(["codex"]);
    expect(computeVerdict({ findings: r.findings, priorThreads: [], threshold: "major", coverage: null, sources: r.sources }).verdict).toBe("APPROVE");
  });
});

describe("superseding a non-blocking open thread (lead decision on §7.2.5)", () => {
  const fp = fingerprint("src/util.ts", "correctness", "Off-by-one in page end index");
  const nonBlocking = prior({
    marker: { v: 1, fp, sev: "major", blk: false },
    path: "src/util.ts",
    line: 5,
    sources: ["claude"],
  });
  const both = (f = engineFinding()): EngineOutputInput[] => [
    { engine: "claude", output: output([f]) },
    { engine: "codex", output: output([f]) },
  ];

  it("a blk=0 single-model thread, then a two-engine major, gives REQUEST_CHANGES", async () => {
    const r = await mergeReview(both(), options({ priorThreads: [nonBlocking] }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ status: "new", blocking: true, verification: "agreed", fingerprint: fp });
    expect(r.drops.duplicate_open).toBe(0);
    expect(r.priorThreads).toEqual([{ ...nonBlocking, state: "superseded" }]);
    const v = computeVerdict({
      findings: r.findings,
      priorThreads: r.priorThreads,
      threshold: "major",
      coverage: null,
      sources: r.sources,
    });
    expect(v.verdict).toBe("REQUEST_CHANGES");
    expect(v.blockingThreads).toEqual([]);
  });

  it("maps each superseded thread to the new finding that replaces it", async () => {
    const r = await mergeReview(both(), options({ priorThreads: [nonBlocking] }));
    expect(r.supersededBy).toEqual(new Map([[fp, fp]]));
  });

  it("maps to the cluster lead's fingerprint when the old thread came from the other member", async () => {
    // The thread came from codex's wording; this run's cluster is led by claude's more confident one.
    const lead = engineFinding({ title: "Off-by-one in page end index calculation", confidence: 0.95 });
    const r = await mergeReview(
      [
        { engine: "claude", output: output([lead]) },
        { engine: "codex", output: output([engineFinding({ confidence: 0.6 })]) },
      ],
      options({ priorThreads: [nonBlocking] }),
    );
    const leadFp = fingerprint("src/util.ts", "correctness", lead.title);
    expect(leadFp).not.toBe(fp);
    expect(r.findings.map((f) => f.fingerprint)).toEqual([leadFp]);
    expect(r.priorThreads[0]?.state).toBe("superseded");
    expect(r.supersededBy.get(fp)).toBe(leadFp);
  });

  it("drops the finding and keeps the thread open when it would not block", async () => {
    const r = await mergeReview(
      [{ engine: "codex", output: output([engineFinding()]) }],
      options({
        priorThreads: [nonBlocking],
        verify: () => Promise.resolve({ confirmed: false, reason: "no", evidence: [] }),
      }),
    );
    expect(r.findings).toEqual([]);
    expect(r.drops.duplicate_open).toBe(1);
    expect(r.priorThreads).toEqual([nonBlocking]);
  });

  it("drops a re-report of a minor below the threshold, keeping the thread open", async () => {
    const minorThread = prior({ marker: { v: 1, fp, sev: "minor", blk: false } });
    const r = await mergeReview(both(engineFinding({ severity: "minor" })), options({ priorThreads: [minorThread] }));
    expect(r.findings).toEqual([]);
    expect(r.priorThreads[0]?.state).toBe("open");
  });

  it("still drops a finding whose fingerprint matches a blocking open thread", async () => {
    const blocking = prior({ marker: { v: 1, fp, sev: "major", blk: true } });
    const r = await mergeReview(both(), options({ priorThreads: [nonBlocking, blocking] }));
    expect(r.findings).toEqual([]);
    expect(r.drops.duplicate_open).toBe(1);
    expect(r.priorThreads.map((t) => t.state)).toEqual(["open", "open"]);
  });

  it("leaves unrelated and non-open threads untouched", async () => {
    const other = prior({ marker: { v: 1, fp: "ffffffffffff", sev: "major", blk: false } });
    const addressed = prior({ marker: { v: 1, fp, sev: "major", blk: false }, state: "addressed" });
    const r = await mergeReview(both(), options({ priorThreads: [other, addressed] }));
    expect(r.priorThreads).toEqual([other, addressed]);
    expect(r.findings[0]?.blocking).toBe(true);
  });
});

describe("profile placement (§7.3)", () => {
  const all = [
    merged({ severity: "critical", fingerprint: "c" }),
    merged({ severity: "major", fingerprint: "M" }),
    merged({ severity: "minor", fingerprint: "m" }),
    merged({ severity: "trivial", fingerprint: "t" }),
  ];
  const fps = (fs: MergedFinding[]) => fs.map((f) => f.fingerprint);

  it("quiet: critical/major inline, minor/trivial as a count", () => {
    const p = placeFindings(all, "quiet", 15);
    expect([fps(p.inline), fps(p.body), fps(p.countOnly)]).toEqual([["c", "M"], [], ["m", "t"]]);
  });

  it("chill: trivial listed in the body", () => {
    const p = placeFindings(all, "chill", 15);
    expect([fps(p.inline), fps(p.body), fps(p.countOnly)]).toEqual([["c", "M", "m"], ["t"], []]);
  });

  it("assertive: everything inline", () => {
    expect(fps(placeFindings(all, "assertive", 15).inline)).toEqual(["c", "M", "m", "t"]);
  });

  it("caps inline comments; overflow goes to the body", () => {
    const p = placeFindings(all, "assertive", 2);
    expect([fps(p.inline), fps(p.body)]).toEqual([["c", "M"], ["m", "t"]]);
  });

  it("never hides a blocking finding behind a count, and never changes blocking", () => {
    const blockingMinor = merged({ severity: "minor", blocking: true, fingerprint: "b" });
    const p = placeFindings([blockingMinor], "quiet", 15);
    expect(fps(p.body)).toEqual(["b"]);
    expect(p.body[0]?.blocking).toBe(true);
  });

  it("puts blocking findings first, and synthetic/outside-diff findings in the body", () => {
    const p = placeFindings(
      [
        merged({ severity: "critical", fingerprint: "nb" }),
        merged({ severity: "minor", blocking: true, fingerprint: "b" }),
        merged({ severity: "critical", outside_diff: true, fingerprint: "o" }),
        merged({ severity: "critical", synthetic: true, blocking: true, fingerprint: "s" }),
      ],
      "assertive",
      15,
    );
    expect([fps(p.inline), fps(p.body)]).toEqual([["b", "nb"], ["s", "o"]]);
  });
});

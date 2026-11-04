// §5.2 damping truth table: every combination of two engines' votes, plus single-engine runs.

import { describe, expect, it } from "vitest";

import { dampStatus, type CheckVote } from "../../src/checks/damping.js";
import type { CheckStatus } from "../../src/types.js";

const VOTES: CheckVote[] = ["pass", "fail", "inconclusive", "missing"];

// Rows: claude's vote; columns: codex's vote, in VOTES order.
const TWO_ENGINES: Record<CheckVote, CheckStatus[]> = {
  pass: ["pass", "inconclusive", "inconclusive", "inconclusive"],
  fail: ["inconclusive", "fail", "inconclusive", "inconclusive"],
  inconclusive: ["inconclusive", "inconclusive", "inconclusive", "inconclusive"],
  missing: ["inconclusive", "inconclusive", "inconclusive", "inconclusive"],
};

// One engine ran (the other failed or was skipped: it casts no vote).
const ONE_ENGINE: Record<CheckVote, CheckStatus> = {
  pass: "pass",
  fail: "fail",
  inconclusive: "inconclusive",
  missing: "inconclusive",
};

describe("§5.2 damping truth table", () => {
  for (const a of VOTES) {
    VOTES.forEach((b, i) => {
      const expected = TWO_ENGINES[a][i];
      it(`claude ${a} + codex ${b} → ${expected}`, () => {
        expect(dampStatus([a, b])).toBe(expected);
        // Symmetric: the engine order never matters.
        expect(dampStatus([b, a])).toBe(expected);
      });
    });
  }

  for (const v of VOTES) {
    it(`single engine ${v} (other did not run) → ${ONE_ENGINE[v]}`, () => {
      expect(dampStatus([v])).toBe(ONE_ENGINE[v]);
    });
  }

  it("no engine ran → inconclusive", () => {
    expect(dampStatus([])).toBe("inconclusive");
  });
});

// design-v2 §6.2 wiring helpers: proposal markers, replies, and the anchor check.

import { describe, expect, it } from "vitest";

import { parseProposalMarkers, type DiffFile, type Hunk, type ReviewSummary, type ReviewThread } from "../../src/github/index.js";
import { alreadyProposed, changedRanges, threadAnchorUnchanged, threadReplies } from "../../src/orchestrator/learnings.js";

const BOT = "myrabbit[bot]";
const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);

const summary = (user: string | null, body: string): ReviewSummary => ({
  id: 1,
  user,
  state: "COMMENTED",
  body,
  commitId: SHA,
  submittedAt: null,
});

describe("parseProposalMarkers / alreadyProposed", () => {
  it("parses strict v=1 markers only (exact builder order, no duplicates)", () => {
    const body = [
      "<!-- myrabbit:proposal v=1 fp=0123456789ab -->",
      "<!-- myrabbit:proposal v=2 fp=0123456789ac -->",
      "<!-- myrabbit:proposal v=1 fp=0123456789ad x=1 -->",
      "<!-- myrabbit:proposal v=1 fp=XYZ -->",
      "<!-- myrabbit:proposal fp=0123456789ae v=1 -->",
      "<!-- myrabbit:proposal v=1 fp=0123456789ab -->",
    ].join("\n");
    expect(parseProposalMarkers(body)).toEqual(["0123456789ab"]);
  });

  it("reads markers only from reviews authored by the bot login", () => {
    const m = (fp: string) => `<!-- myrabbit:proposal v=1 fp=${fp} -->`;
    const reviews = [
      summary(BOT, m("000000000001")),
      summary("MyRabbit[bot]", m("000000000002")),
      summary("dlled", m("000000000003")),
      summary("myrabbit", m("000000000004")),
      summary(null, m("000000000005")),
    ];
    expect([...alreadyProposed(reviews, BOT)]).toEqual(["000000000001", "000000000002"]);
  });
});

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "T1",
    path: "src/app.ts",
    line: 9,
    startLine: null,
    originalLine: 9,
    originalStartLine: null,
    side: "RIGHT",
    isResolved: true,
    isOutdated: false,
    resolvedBy: "dlled",
    firstComment: null,
    marker: null,
    ours: true,
    humanResolved: true,
    addressed: false,
    replies: [],
    originalCommit: SHA,
    ...over,
  };
}

describe("threadReplies", () => {
  it("maps authors and flags bots by __typename or bot login", () => {
    const t = thread({
      replies: [
        { id: "1", databaseId: 1, body: "a", author: { login: "dlled", __typename: "User" } },
        { id: "2", databaseId: 2, body: "b", author: { login: "renovate", __typename: "Bot" } },
        { id: "3", databaseId: 3, body: "c", author: { login: BOT } },
        { id: "4", databaseId: 4, body: "d", author: null },
      ],
    });
    expect(threadReplies(t, BOT)).toEqual([
      { author: "dlled", authorIsBot: false, body: "a" },
      { author: "renovate", authorIsBot: true, body: "b" },
      { author: BOT, authorIsBot: true, body: "c" },
      { author: null, authorIsBot: false, body: "d" },
    ]);
  });
});

/** A hunk from DiffLine kinds; old/new numbers are derived like git does. */
function hunk(oldStart: number, kinds: ("c" | "d" | "a")[]): Hunk {
  let o = oldStart;
  let n = oldStart;
  const lines = kinds.map((k) => {
    if (k === "c") return { kind: "context" as const, oldLine: o++, newLine: n++, text: "" };
    if (k === "d") return { kind: "del" as const, oldLine: o++, newLine: null, text: "" };
    return { kind: "add" as const, oldLine: null, newLine: n++, text: "" };
  });
  return { index: 0, oldStart, oldLines: o - oldStart, newStart: oldStart, newLines: n - oldStart, header: "", lines };
}

const file = (over: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/app.ts",
  oldPath: "src/app.ts",
  status: "modified",
  binary: false,
  hunks: [],
  additions: 0,
  deletions: 0,
  patch: "",
  bytes: 0,
  ...over,
});

describe("changedRanges", () => {
  it("drops context lines and keeps deletions and insertion points", () => {
    // lines 2-4 context, 5 replaced, 6-8 context
    expect(changedRanges(hunk(2, ["c", "c", "c", "d", "a", "c", "c", "c"]))).toEqual([
      { oldStart: 5, oldLines: 1 },
      { oldStart: 5, oldLines: 0 },
    ]);
    // pure insertion after line 4
    expect(changedRanges(hunk(2, ["c", "c", "c", "a", "c"]))).toEqual([{ oldStart: 4, oldLines: 0 }]);
  });
});

describe("threadAnchorUnchanged", () => {
  const diff = (files: DiffFile[] | null) => () => Promise.resolve(files);
  const replaced5 = [file({ hunks: [hunk(2, ["c", "c", "c", "d", "a", "c", "c", "c"])] })];

  it("is true when only context lines surround the anchor, or the file is not in the diff", async () => {
    expect(await threadAnchorUnchanged(thread({ originalLine: 8 }), HEAD, diff(replaced5))).toBe(true);
    expect(await threadAnchorUnchanged(thread(), HEAD, diff([file({ path: "other.ts", oldPath: "other.ts" })]))).toBe(true);
    expect(await threadAnchorUnchanged(thread({ originalCommit: HEAD }), HEAD, diff(null))).toBe(true);
  });

  it("is false when the anchor changed or anything is unknown", async () => {
    expect(await threadAnchorUnchanged(thread({ originalLine: 5 }), HEAD, diff(replaced5))).toBe(false);
    expect(await threadAnchorUnchanged(thread({ originalStartLine: 3, originalLine: 6 }), HEAD, diff(replaced5))).toBe(false);
    expect(await threadAnchorUnchanged(thread({ originalCommit: null }), HEAD, diff([]))).toBe(false);
    expect(await threadAnchorUnchanged(thread({ originalLine: null }), HEAD, diff([]))).toBe(false);
    expect(await threadAnchorUnchanged(thread({ side: "LEFT" }), HEAD, diff([]))).toBe(false);
    expect(await threadAnchorUnchanged(thread(), HEAD, diff(null))).toBe(false);
    for (const status of ["deleted", "renamed"] as const) {
      expect(await threadAnchorUnchanged(thread(), HEAD, diff([file({ status, path: "x.ts" })]))).toBe(false);
    }
  });
});

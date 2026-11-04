import { describe, expect, it, vi } from "vitest";

import { closingIssueNumbers, fetchLinkedIssues, LINKED_ISSUE_BODY_CHARS, MAX_LINKED_ISSUES } from "../../src/checks/linked-issues.js";
import type { GitHub } from "../../src/github/client.js";

const REPO = { owner: "acme", repo: "widgets" };

describe("closingIssueNumbers", () => {
  it("reads every GitHub closing keyword, any case, with or without a colon", () => {
    const body = "close #1\nCloses #2\nclosed: #3\nFIX #4\nfixes #5\nFixed #6\nresolve #7\nresolves #8\nResolved: #9";
    expect(closingIssueNumbers(body, { ...REPO })).toEqual([1, 2, 3, 4, 5]);
  });

  it("caps at 5, keeps first-mention order and drops duplicates", () => {
    expect(MAX_LINKED_ISSUES).toBe(5);
    expect(closingIssueNumbers("Fixes #9, fixes #3, fixes #9, fixes #1", REPO)).toEqual([9, 3, 1]);
  });

  it("accepts owner/repo#n and the issue URL for the same repo only (case-insensitive)", () => {
    const body = [
      "Fixes ACME/Widgets#10",
      "Fixes other/repo#11",
      "Resolves https://github.com/acme/widgets/issues/12",
      "Resolves https://github.com/other/repo/issues/13",
    ].join("\n");
    expect(closingIssueNumbers(body, REPO)).toEqual([10, 12]);
  });

  it("ignores mentions without a keyword, keywords inside words and code", () => {
    const body = [
      "Related to #20, see #21",
      "prefix #22 and unfixes #23 and fix#24",
      "```",
      "fixes #25",
      "```",
      "Use `closes #26` to link.",
      "<!-- fixes #27 -->",
      "Fixes #28.",
    ].join("\n");
    expect(closingIssueNumbers(body, REPO)).toEqual([28]);
  });

  it("treats everything after an unclosed fence as code", () => {
    expect(closingIssueNumbers("Fixes #1\n```\nfixes #12\nresolves #13", REPO)).toEqual([1]);
    expect(closingIssueNumbers("Fixes #2\n~~~sh\nfixes #14", REPO)).toEqual([2]);
    // A closed fence still ends the code: keywords after it count.
    expect(closingIssueNumbers("```\nfixes #15\n```\nFixes #3\n```\nfixes #16", REPO)).toEqual([3]);
  });

  it("only a bare fence closes a block: one with an info string does not", () => {
    // GitHub renders "```a" here as text inside the still-open fence.
    expect(closingIssueNumbers("```a\nfixes #2\n```a\nfixes #2", REPO)).toEqual([]);
    // Trailing spaces or tabs on the closing fence are allowed.
    expect(closingIssueNumbers("```sh\nfixes #3\n```  \t\nFixes #4", REPO)).toEqual([4]);
  });

  it("stays fast on a hostile body of many fence markers", () => {
    const body = "```\n".repeat(20_000) + "fixes #1";
    const t = performance.now();
    closingIssueNumbers(body, REPO);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("handles a null or empty body", () => {
    expect(closingIssueNumbers(null, REPO)).toEqual([]);
    expect(closingIssueNumbers("", REPO)).toEqual([]);
  });
});

describe("fetchLinkedIssues", () => {
  function gh(data: Record<number, unknown>): GitHub {
    const get = vi.fn(({ issue_number }: { issue_number: number }) => {
      const d = data[issue_number];
      if (d === undefined) return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
      return Promise.resolve({ data: d });
    });
    return { rest: { issues: { get } } } as unknown as GitHub;
  }

  it("returns title and capped body; skips pull requests and unreadable numbers", async () => {
    const client = gh({
      1: { title: "Bug", body: "x".repeat(LINKED_ISSUE_BODY_CHARS + 10) },
      2: { title: "A PR", body: "", pull_request: { url: "u" } },
      4: { title: "No body", body: null },
    });
    const r = await fetchLinkedIssues(client, REPO, [1, 2, 3, 4]);
    expect(r.map((i) => i.number)).toEqual([1, 4]);
    expect(r[0]?.body.length).toBe(LINKED_ISSUE_BODY_CHARS + 1);
    expect(r[1]).toEqual({ number: 4, title: "No body", body: "" });
  });
});

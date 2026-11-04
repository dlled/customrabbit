import { describe, expect, it } from "vitest";

import type { GitRunner } from "../../src/github/git.js";
import { buildStateMarker } from "../../src/github/markers.js";
import { checkEligibility, fetchPullRequest } from "../../src/github/pr.js";
import {
  applyIncrementalLimit,
  findLastReview,
  isBotActor,
  isBotLogin,
  listReviews,
  selectMode,
  type LastReview,
  type ModeReason,
  type ModeSelection,
  type ReviewSummary,
} from "../../src/github/reviews.js";
import { BASE, BOT, HEAD, OLD, REPO, prJson, testClient } from "./helpers.js";

describe("fetchPullRequest", () => {
  it("narrows the REST payload", async () => {
    const { gh, server } = testClient();
    server.on("GET", "/repos/acme/widgets/pulls/7", { body: prJson({ headRepo: null }) });
    const pr = await fetchPullRequest(gh, REPO, 7);
    expect(pr).toEqual({
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      title: "Add widgets",
      body: "",
      labels: ["enhancement"],
      author: "dlled",
      htmlUrl: "https://github.com/acme/widgets/pull/7",
      head: { sha: HEAD, ref: "feature", repoFullName: null },
      base: { sha: BASE, ref: "main", repoFullName: "acme/widgets" },
    });
  });

  it("keeps the description, and maps a null body to an empty string", async () => {
    const { gh, server } = testClient();
    server.on("GET", "/repos/acme/widgets/pulls/7", { body: { ...prJson(), body: "Adds widgets.\n\nDetails." } }, { body: { ...prJson(), body: null } });
    expect((await fetchPullRequest(gh, REPO, 7)).body).toBe("Adds widgets.\n\nDetails.");
    expect((await fetchPullRequest(gh, REPO, 7)).body).toBe("");
  });
});

describe("checkEligibility (§10.1)", () => {
  const pr = async (o: Parameters<typeof prJson>[0] = {}) => {
    const { gh, server } = testClient();
    server.on("GET", "/repos/acme/widgets/pulls/7", { body: prJson(o) });
    return fetchPullRequest(gh, REPO, 7);
  };
  const input = { trustedAuthors: ["DLLED"], checkedOutHead: HEAD };

  it("accepts an open, same-repo PR by a trusted author at the checked-out head", async () => {
    expect(checkEligibility(await pr(), input)).toEqual({ ok: true });
    // Case-insensitive on logins and repo names.
    expect(checkEligibility(await pr({ author: "DLled", headRepo: "ACME/Widgets" }), input)).toEqual({ ok: true });
  });

  it("refuses with every failing reason", async () => {
    const r = checkEligibility(await pr({ state: "closed", headRepo: "evil/widgets", author: "mallory", head: OLD }), input);
    expect(r).toMatchObject({ ok: false, reasons: ["not_open", "fork", "untrusted_author", "head_mismatch"] });
  });

  it("refuses merged PRs, deleted head repos, bots and empty heads", async () => {
    expect(checkEligibility(await pr({ merged: true }), input)).toMatchObject({ reasons: ["not_open"] });
    expect(checkEligibility(await pr({ headRepo: null }), input)).toMatchObject({ reasons: ["fork"] });
    expect(checkEligibility(await pr({ author: "dlled[bot]" }), input)).toMatchObject({ reasons: ["untrusted_author"] });
    expect(checkEligibility(await pr(), { ...input, checkedOutHead: "" })).toMatchObject({ reasons: ["head_mismatch"] });
    expect(checkEligibility(await pr(), { ...input, trustedAuthors: [] })).toMatchObject({ reasons: ["untrusted_author"] });
  });
});

const marker = (head: string, config = "0123456789ab") =>
  buildStateMarker({ v: 1, head, base: BASE, mode: "full", config, prompt: "1" });

const review = (o: Partial<ReviewSummary>): ReviewSummary => ({
  id: 1,
  user: BOT,
  state: "APPROVED",
  body: `ok\n${marker(OLD)}`,
  commitId: OLD,
  submittedAt: "2026-11-01T00:00:00Z",
  ...o,
});

describe("bot identity", () => {
  it("REST logins match exactly, case-insensitive", () => {
    expect(isBotLogin("MyRabbit[bot]", BOT)).toBe(true);
    expect(isBotLogin("myrabbit", BOT)).toBe(false);
    expect(isBotLogin(null, BOT)).toBe(false);
  });

  it("GraphQL: only a Bot actor matches without the [bot] suffix", () => {
    expect(isBotActor({ login: "myrabbit", __typename: "Bot" }, BOT)).toBe(true);
    expect(isBotActor({ login: "myrabbit", __typename: "User" }, BOT)).toBe(false);
    expect(isBotActor({ login: "myrabbit" }, BOT)).toBe(false);
    expect(isBotActor(null, BOT)).toBe(false);
  });
});

describe("findLastReview (§8.3)", () => {
  it("picks the newest bot review whose marker head equals commit_id", () => {
    const last = findLastReview(
      [
        review({ id: 1 }),
        review({ id: 3, body: marker(HEAD), commitId: HEAD }),
        review({ id: 2 }),
      ],
      BOT,
    );
    expect(last).toMatchObject({ reviewId: 3, state: { head: HEAD } });
  });

  it("ignores humans, pasted markers, mismatched commit_id, pending and marker-less reviews", () => {
    expect(
      findLastReview(
        [
          review({ id: 10, user: "dlled" }),
          review({ id: 11, user: "myrabbit" }),
          review({ id: 12, commitId: HEAD }),
          review({ id: 13, state: "PENDING" }),
          review({ id: 14, body: "no marker" }),
          review({ id: 15, commitId: null }),
        ],
        BOT,
      ),
    ).toBeNull();
  });

  it("lists reviews across pages", async () => {
    const { gh, server } = testClient();
    const raw = (id: number) => ({ id, user: { login: BOT }, state: "APPROVED", body: marker(OLD), commit_id: OLD, submitted_at: "x" });
    server.on(
      "GET",
      "/repos/acme/widgets/pulls/7/reviews",
      { body: [raw(1)], headers: { link: '<https://api.github.com/repos/acme/widgets/pulls/7/reviews?page=2&per_page=100>; rel="next"' } },
      { body: [raw(2)] },
    );
    const reviews = await listReviews(gh, REPO, 7);
    expect(reviews.map((r) => r.id)).toEqual([1, 2]);
    expect(server.calls[0]?.query.get("per_page")).toBe("100");
    expect(findLastReview(reviews, BOT)?.reviewId).toBe(2);
  });
});

describe("selectMode (§2.1)", () => {
  const last = (head = OLD, config = "0123456789ab"): LastReview => ({
    reviewId: 1,
    state: { v: 1, head, base: BASE, mode: "full", config, prompt: "1" },
    submittedAt: null,
  });
  const git = (ancestor: boolean): GitRunner => (args) =>
    Promise.resolve({ code: args.includes("cat-file") ? 0 : ancestor ? 0 : 1, stdout: "", stderr: "" });
  const base = { trigger: "pull_request" as const, headSha: HEAD, baseSha: BASE, configHash: "0123456789ab" };

  it("covers the table", async () => {
    const pick = async (o: Partial<Parameters<typeof selectMode>[0]>) => {
      const s = await selectMode({ ...base, last: null, git: git(true), ...o });
      return [s.mode, s.reason, s.from];
    };
    expect(await pick({})).toEqual(["full", "no_previous_review", BASE]);
    expect(await pick({ last: last(HEAD) })).toEqual(["skip", "already_reviewed", null]);
    expect(await pick({ last: last() })).toEqual(["incremental", "incremental", OLD]);
    expect(await pick({ last: last(), git: git(false) })).toEqual(["full", "not_ancestor", BASE]);
    expect(await pick({ last: last(OLD, "ffffffffffff") })).toEqual(["full", "config_changed", BASE]);
    expect(await pick({ trigger: "workflow_dispatch", last: last(HEAD) })).toEqual(["full", "dispatch", BASE]);
  });

  it("falls back to full when the incremental diff is over max_files", async () => {
    const s = await selectMode({ ...base, last: last(), git: git(true) });
    expect(applyIncrementalLimit(s, 5, 5, BASE)).toBe(s);
    expect(applyIncrementalLimit(s, 6, 5, BASE)).toMatchObject({ mode: "full", reason: "too_many_files", from: BASE });
  });

  it("label_override is a full-mode reason for the orchestrator; selectMode never picks it", async () => {
    const reason: ModeReason = "label_override";
    const forced: ModeSelection = { mode: "full", reason, last: last(HEAD), from: BASE, head: HEAD };
    // applyIncrementalLimit leaves a full selection alone.
    expect(applyIncrementalLimit(forced, 999, 1, BASE)).toBe(forced);
    for (const input of [{ last: null }, { last: last(HEAD) }, { last: last() }, { trigger: "workflow_dispatch" as const, last: null }]) {
      expect((await selectMode({ ...base, git: git(true), ...input })).reason).not.toBe("label_override");
    }
  });
});

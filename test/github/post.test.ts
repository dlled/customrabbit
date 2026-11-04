import { describe, expect, it } from "vitest";

import { buildFindingMarker, buildStateMarker, parseStateMarker } from "../../src/github/markers.js";
import {
  MAX_BODY_CHARS,
  MAX_COMMENT_CHARS,
  MAX_INLINE_COMMENTS,
  ReviewPostError,
  appendCommentsToBody,
  postReview,
  truncateBody,
  truncateComment,
  type InlineComment,
} from "../../src/github/post.js";
import { BASE, HEAD, OLD, REPO, prJson, testClient } from "./helpers.js";

const STATE = buildStateMarker({ v: 1, head: HEAD, base: BASE, mode: "full", config: "0123456789ab", prompt: "1" });
const FM = buildFindingMarker({ v: 1, fp: "abcdef012345", sev: "major", blk: true });
const BODY = `**myrabbit: REQUEST_CHANGES** — 1 blocking\n\nsummary\n${STATE}`;
const PR = "/repos/acme/widgets/pulls/7";
const REVIEWS = "/repos/acme/widgets/pulls/7/reviews";

const comment = (o: Partial<InlineComment> = {}): InlineComment => ({
  path: "src.ts",
  body: `**[major · correctness]** t\n\nbody\n${FM}`,
  line: 4,
  side: "RIGHT",
  ...o,
});

interface Posted {
  commit_id: string;
  event: string;
  body: string;
  comments: Record<string, unknown>[];
}

const posted = (server: ReturnType<typeof testClient>["server"]): Posted[] =>
  server.calls.filter((c) => c.method === "POST" && c.path === REVIEWS).map((c) => c.body as Posted);

describe("postReview (§8.5)", () => {
  it("rechecks the head, then posts once with inline comments", async () => {
    const { gh, server } = testClient();
    server.on("GET", PR, { body: prJson() });
    server.on("POST", REVIEWS, { body: { id: 55, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55" } });
    const r = await postReview(gh, REPO, {
      pullNumber: 7,
      commitId: HEAD,
      event: "REQUEST_CHANGES",
      body: BODY,
      comments: [comment(), comment({ start_line: 2, line: 4 }), comment({ start_line: 4, line: 4, side: "LEFT" })],
    });
    expect(r).toMatchObject({ status: "posted", reviewId: 55, bodyOnly: false, movedToBody: [], rejectedAnchors: [] });
    const [p] = posted(server);
    expect(p).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: BODY,
      comments: [
        { path: "src.ts", body: comment().body, line: 4, side: "RIGHT" },
        { path: "src.ts", body: comment().body, line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT" },
        { path: "src.ts", body: comment().body, line: 4, side: "LEFT" },
      ],
    });
    expect(server.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("posts nothing when the head moved or the PR closed", async () => {
    const moved = testClient();
    moved.server.on("GET", PR, { body: prJson({ head: OLD }) });
    await expect(
      postReview(moved.gh, REPO, { pullNumber: 7, commitId: HEAD, event: "APPROVE", body: BODY, comments: [] }),
    ).resolves.toEqual({ status: "head_moved", currentHead: OLD });
    expect(posted(moved.server)).toHaveLength(0);

    const closed = testClient();
    closed.server.on("GET", PR, { body: prJson({ state: "closed" }) });
    await expect(
      postReview(closed.gh, REPO, { pullNumber: 7, commitId: HEAD, event: "APPROVE", body: BODY, comments: [] }),
    ).resolves.toEqual({ status: "closed" });
    expect(posted(closed.server)).toHaveLength(0);
  });

  it("on 422 retries once body-only with every comment in the body", async () => {
    const { gh, server } = testClient();
    server.on("GET", PR, { body: prJson() });
    server.on(
      "POST",
      REVIEWS,
      { status: 422, body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } },
      { body: { id: 56, html_url: "u" } },
    );
    const r = await postReview(gh, REPO, {
      pullNumber: 7,
      commitId: HEAD,
      event: "REQUEST_CHANGES",
      body: BODY,
      comments: [comment(), comment({ path: "b.ts", start_line: 1, line: 3 })],
    });
    expect(r).toMatchObject({ status: "posted", reviewId: 56, bodyOnly: true, rejectedAnchors: ["src.ts:4:RIGHT", "b.ts:1-3:RIGHT"] });
    const [, retry] = posted(server);
    expect(retry?.comments).toEqual([]);
    expect(retry?.body).toContain("Findings not posted inline (2)");
    expect(retry?.body).toContain("`b.ts:1-3` (RIGHT)");
    expect(retry?.body).not.toContain("myrabbit:f ");
    expect(retry?.body.endsWith(STATE)).toBe(true);
    expect(parseStateMarker(retry?.body ?? "")?.head).toBe(HEAD);
  });

  it("fails after the retry also fails, with GitHub's message", async () => {
    const { gh, server } = testClient();
    server.on("GET", PR, { body: prJson() });
    server.on("POST", REVIEWS, { status: 422, body: { message: "Can not approve your own pull request" } });
    const err = await postReview(gh, REPO, { pullNumber: 7, commitId: HEAD, event: "APPROVE", body: BODY, comments: [comment()] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReviewPostError);
    expect((err as ReviewPostError).status).toBe(422);
    expect((err as ReviewPostError).message).toMatch(/after body-only retry \(HTTP 422\): Can not approve/);
    expect(posted(server)).toHaveLength(2);
  });

  it("does not retry other errors, or a 422 without comments", async () => {
    for (const [status, comments] of [
      [500, [comment()]],
      [422, []],
    ] as const) {
      const { gh, server } = testClient();
      server.on("GET", PR, { body: prJson() });
      server.on("POST", REVIEWS, { status, body: { message: "nope" } });
      await expect(
        postReview(gh, REPO, { pullNumber: 7, commitId: HEAD, event: "APPROVE", body: BODY, comments }),
      ).rejects.toBeInstanceOf(ReviewPostError);
      expect(posted(server)).toHaveLength(1);
    }
  });

  it("caps inline comments at 30 and moves the rest into the body", async () => {
    const { gh, server } = testClient();
    server.on("GET", PR, { body: prJson() });
    server.on("POST", REVIEWS, { body: { id: 57, html_url: "u" } });
    const many = Array.from({ length: 33 }, (_, i) => comment({ line: i + 1 }));
    const r = await postReview(gh, REPO, { pullNumber: 7, commitId: HEAD, event: "REQUEST_CHANGES", body: BODY, comments: many });
    const [p] = posted(server);
    expect(p?.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(p?.body).toContain("Findings not posted inline (3)");
    expect(r).toMatchObject({ bodyOnly: false });
    if (r.status === "posted") expect(r.movedToBody.map((c) => c.line)).toEqual([31, 32, 33]);
  });

  it("rejects a non-sha commit id before any call", async () => {
    const { gh, server } = testClient();
    await expect(
      postReview(gh, REPO, { pullNumber: 7, commitId: "HEAD", event: "APPROVE", body: BODY, comments: [] }),
    ).rejects.toThrow(/invalid commit_id/);
    expect(server.calls).toHaveLength(0);
  });

  it("enforces body and comment limits on what it sends", async () => {
    const { gh, server } = testClient();
    server.on("GET", PR, { body: prJson() });
    server.on("POST", REVIEWS, { body: { id: 58, html_url: "u" } });
    const big = `x\n<details><summary>Review info</summary>\n${"y".repeat(70_000)}\n</details>\n${STATE}`;
    await postReview(gh, REPO, {
      pullNumber: 7,
      commitId: HEAD,
      event: "APPROVE",
      body: big,
      comments: [comment({ body: `${"z".repeat(5000)}\n${FM}` })],
    });
    const [p] = posted(server);
    expect(p?.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(p?.body.endsWith(STATE)).toBe(true);
    expect((p?.comments[0]?.body as string).length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
  });
});

describe("truncateBody", () => {
  it("leaves short bodies alone", () => {
    expect(truncateBody(BODY)).toBe(BODY);
  });

  it("shrinks the largest <details> first and keeps the summary and marker", () => {
    const small = "<details><summary>Changes (2 files)</summary>\n| a | b |\n</details>";
    const large = `<details><summary>Non-blocking</summary>\n${"n".repeat(500)}\n</details>`;
    const body = `head\n${small}\n### Blocking\n- keep me\n${large}\n${STATE}`;
    const out = truncateBody(body, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain(small);
    expect(out).toContain("- keep me");
    expect(out).toContain("<details><summary>Non-blocking</summary>\n\n… (truncated: review body limit)");
    expect(out.endsWith(STATE)).toBe(true);
  });

  it("hard-cuts when details are not enough, never leaving an open fence", () => {
    const body = `head\n\`\`\`ts\n${"c".repeat(1000)}\n\`\`\`\n${STATE}`;
    const out = truncateBody(body, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out).toContain("… (truncated)");
    expect(out.endsWith(STATE)).toBe(true);
  });
});

describe("truncateComment", () => {
  it("drops the suggestion first, keeps the marker", () => {
    const body = `**[major · correctness]** t\n\nbody\n\n\`\`\`suggestion\n${"s".repeat(5000)}\n\`\`\`\n\n<sub>found by claude</sub>\n${FM}`;
    const out = truncateComment(body);
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(out).not.toContain("```suggestion");
    expect(out).toContain("_(suggestion omitted: comment too long)_");
    expect(out).toContain("<sub>found by claude</sub>");
    expect(out.endsWith(FM)).toBe(true);
  });

  it("hard-cuts long prose", () => {
    const out = truncateComment(`${"p".repeat(9000)}\n${FM}`, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.endsWith(FM)).toBe(true);
  });
});

describe("appendCommentsToBody", () => {
  it("is a no-op without comments and places the section before the marker", () => {
    expect(appendCommentsToBody(BODY, [])).toBe(BODY);
    const out = appendCommentsToBody(BODY, [comment()]);
    expect(out.indexOf("Findings not posted inline")).toBeLessThan(out.indexOf(STATE));
    expect(out.endsWith(STATE)).toBe(true);
  });
});

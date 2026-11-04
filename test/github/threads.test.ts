import { describe, expect, it } from "vitest";

import { buildFindingMarker } from "../../src/github/markers.js";
import {
  FALLBACK_CATEGORY,
  appendAddressedNote,
  listReviewThreads,
  markAddressed,
  MAX_THREAD_REPLIES,
  parseFindingComment,
  toPriorThread,
} from "../../src/github/threads.js";
import { BOT, HEAD, REPO, testClient } from "./helpers.js";

const fmark = buildFindingMarker({ v: 1, fp: "abcdef012345", sev: "major", blk: true });

const thread = (o: {
  id?: string;
  author?: { login: string; __typename: string } | null;
  body?: string;
  isResolved?: boolean;
  resolvedBy?: { login: string } | null;
}) => ({
  id: o.id ?? "T1",
  path: "src.ts",
  line: 4,
  startLine: null,
  originalLine: 4,
  diffSide: "RIGHT",
  isResolved: o.isResolved ?? false,
  isOutdated: false,
  resolvedBy: o.resolvedBy ?? null,
  comments: {
    nodes: [
      {
        id: "C1",
        databaseId: 101,
        body: o.body ?? `**[major · correctness]** x\n\nbody\n${fmark}`,
        author: o.author === undefined ? { login: "myrabbit", __typename: "Bot" } : o.author,
      },
    ],
  },
});

const page = (nodes: unknown[], next: string | null) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
      },
    },
  },
});

describe("listReviewThreads (§8.4)", () => {
  it("paginates and classifies ours / human-resolved", async () => {
    const { gh, server } = testClient();
    server.on(
      "POST",
      "/graphql",
      { body: page([thread({ id: "T1" }), thread({ id: "T2", author: { login: "dlled", __typename: "User" }, body: `pasted ${fmark}` })], "CUR") },
      {
        body: page(
          [
            thread({ id: "T3", isResolved: true, resolvedBy: { login: "dlled" } }),
            thread({ id: "T4", isResolved: true, resolvedBy: null }),
            thread({ id: "T5", body: "bot comment without marker" }),
            thread({ id: "T6", author: { login: "myrabbit", __typename: "User" } }),
          ],
          null,
        ),
      },
    );
    const threads = await listReviewThreads(gh, REPO, 7, BOT);
    expect(threads.map((t) => [t.id, t.ours, t.humanResolved])).toEqual([
      ["T1", true, false],
      ["T2", false, false],
      ["T3", true, true],
      ["T4", true, false],
      ["T5", false, false],
      ["T6", false, false],
    ]);
    expect(threads[0]?.marker).toEqual({ v: 1, fp: "abcdef012345", sev: "major", blk: true });
    expect(threads[2]?.resolvedBy).toBe("dlled");
    const vars = server.calls.map((c) => (c.body as { variables: Record<string, unknown> }).variables);
    expect(vars).toEqual([
      { owner: "acme", repo: "widgets", number: 7, after: null },
      { owner: "acme", repo: "widgets", number: 7, after: "CUR" },
    ]);
  });

  it("reads replies after the first comment and the first comment's original commit (design-v2 §6.2)", async () => {
    const { gh, server } = testClient();
    const raw = thread({});
    const sha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const first = { ...raw.comments.nodes[0], originalCommit: { oid: sha } };
    const reply = { id: "C2", databaseId: 102, body: "intended", author: { login: "dlled", __typename: "User" }, originalCommit: { oid: sha } };
    server.on(
      "POST",
      "/graphql",
      {
        body: page(
          [
            { ...raw, comments: { nodes: [first, null, reply] } },
            { ...thread({ id: "T2" }), comments: { nodes: [{ ...raw.comments.nodes[0], originalCommit: { oid: "nope" } }] } },
          ],
          null,
        ),
      },
    );
    const [a, b] = await listReviewThreads(gh, REPO, 7, BOT);
    expect(a?.replies).toEqual([reply]);
    expect(a?.originalCommit).toBe(sha.toLowerCase());
    expect(b?.replies).toEqual([]);
    expect(b?.originalCommit).toBeNull();
    const query = (server.calls[0]?.body as { query: string }).query;
    expect(query).toContain(`comments(first: ${MAX_THREAD_REPLIES + 1})`);
    expect(query).toContain("originalCommit { oid }");
  });

  it("throws when the PR does not exist", async () => {
    const { gh, server } = testClient();
    server.on("POST", "/graphql", { body: { data: { repository: { pullRequest: null } } } });
    await expect(listReviewThreads(gh, REPO, 7, BOT)).rejects.toThrow(/not found/);
  });
});

describe("appendAddressedNote", () => {
  it("inserts before the trailing marker, once", () => {
    const body = `text\n${fmark}`;
    const once = appendAddressedNote(body, "abc1234");
    expect(once).toBe(`text\n\n✅ Addressed in abc1234\n${fmark}`);
    expect(appendAddressedNote(once, "def5678")).toBe(once);
    expect(appendAddressedNote("plain", "abc1234")).toBe("plain\n\n✅ Addressed in abc1234");
  });
});

describe("markAddressed", () => {
  const ours = async () => {
    const { gh, server } = testClient();
    server.on("POST", "/graphql", { body: page([thread({})], null) });
    const [t] = await listReviewThreads(gh, REPO, 7, BOT);
    if (!t) throw new Error("no thread");
    return { gh, server, t };
  };

  it("edits the comment, then resolves the thread", async () => {
    const { gh, server, t } = await ours();
    server.on("PATCH", "/repos/acme/widgets/pulls/comments/101", { body: { id: 101 } });
    server.on("POST", "/graphql", { body: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } } });
    const r = await markAddressed(gh, REPO, t, HEAD);
    expect(r).toEqual({ edited: true, resolved: true, resolveError: null });
    const patch = server.calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain(`✅ Addressed in ${HEAD.slice(0, 7)}`);
    const mutation = server.calls.at(-1)?.body as { query: string; variables: unknown };
    expect(mutation.query).toContain("resolveReviewThread");
    expect(mutation.variables).toEqual({ threadId: "T1" });
  });

  it("keeps the edit when the App may not resolve threads", async () => {
    const { gh, server, t } = await ours();
    server.on("PATCH", "/repos/acme/widgets/pulls/comments/101", { body: { id: 101 } });
    server.on("POST", "/graphql", { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await markAddressed(gh, REPO, t, HEAD);
    expect(r).toMatchObject({ edited: true, resolved: false });
    expect(r.resolveError).toContain("403");
  });

  it("refuses threads that are not ours", async () => {
    const { gh, server } = testClient();
    server.on("POST", "/graphql", { body: page([thread({ author: { login: "dlled", __typename: "User" } })], null) });
    const [t] = await listReviewThreads(gh, REPO, 7, BOT);
    if (!t) throw new Error("no thread");
    await expect(markAddressed(gh, REPO, t, HEAD)).rejects.toThrow(/not a myrabbit thread/);
  });
});

describe("toPriorThread (src/merge PriorThread shape)", () => {
  const rendered =
    "**[major · security]** Escape the shell argument\n\nUser input reaches `exec`.\n\n**Fails when:** name is `;rm -rf /`\n\n" +
    "```suggestion\nexecFile(cmd, [name])\n```\n\n<sub>found by claude+codex · confidence 0.82</sub>\n" +
    fmark;

  const load = async (nodes: unknown[]) => {
    const { gh, server } = testClient();
    server.on("POST", "/graphql", { body: page(nodes, null) });
    return listReviewThreads(gh, REPO, 7, BOT);
  };

  it("maps an open single-line thread with every field parsed", async () => {
    const [t] = await load([thread({ body: rendered })]);
    expect(t && toPriorThread(t)).toEqual({
      marker: { v: 1, fp: "abcdef012345", sev: "major", blk: true },
      state: "open",
      path: "src.ts",
      line: 4,
      end_line: null,
      side: "RIGHT",
      category: "security",
      summary: "Escape the shell argument",
      body: "User input reaches `exec`.",
      sources: ["claude", "codex"],
      confidence: 0.82,
    });
  });

  it("derives state and multi-line / outdated ranges", async () => {
    const threads = await load([
      { ...thread({ id: "A", isResolved: true, resolvedBy: { login: "dlled" } }), startLine: 2 },
      { ...thread({ id: "B", isResolved: true }), line: null, originalLine: 9, originalStartLine: 7 },
      thread({ id: "C", body: appendAddressedNote(rendered, "abc1234") }),
      thread({ id: "D", author: { login: "dlled", __typename: "User" } }),
    ]);
    expect(threads.map(toPriorThread).map((p) => p && [p.state, p.line, p.end_line])).toEqual([
      ["dismissed", 2, 4],
      ["addressed", 7, 9],
      ["addressed", 4, null],
      null,
    ]);
  });

  it("parseFindingComment falls back when the header is not ours", () => {
    expect(parseFindingComment(`Something odd\nmore\n${fmark}`)).toEqual({
      category: FALLBACK_CATEGORY,
      summary: "Something odd",
      body: "Something odd\nmore",
      sources: [],
      confidence: null,
    });
    expect(parseFindingComment("**[minor · bogus]** t\n\nb\n\n<sub>found by gpt · confidence 7</sub>")).toMatchObject({
      category: FALLBACK_CATEGORY,
      summary: "t",
      sources: [],
      confidence: null,
    });
  });
});

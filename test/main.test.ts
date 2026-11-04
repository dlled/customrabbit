// End to end (design §2, §2.2, §10.1): the whole pipeline with fake engines and a fake GitHub API,
// over a real temp git repository (createGitRunner / createGitReader on real commits).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetSecretsForTests } from "../src/env.js";
import { buildFindingMarker, buildProposalMarker, buildStateMarker } from "../src/render/markers.js";
import { REVIEW_OUTPUT_SCHEMA } from "../src/engines/schema.js";
import { actionRoot, exitAfterFlush } from "../src/main.js";
import { runPipeline } from "../src/orchestrator/pipeline.js";
import { TOOLS_ISOLATION_NONE_WARNING, type ToolsDeps } from "../src/orchestrator/tools.js";
import type { EngineSetupInput, SetupEngines } from "../src/orchestrator/engines.js";
import { configHash } from "../src/config/index.js";
import { promptVersion, loadTemplates } from "../src/prompts/builder.js";
import { fingerprint } from "../src/merge/index.js";
import { createGitReader, defaultConfig, loadReviewConfig } from "../src/config/index.js";
import { createGitHubClientWithToken, createGitRunner, type GitRunner } from "../src/github/index.js";
import {
  appSource,
  fakeSetup,
  BOT,
  FAKE_CLAUDE_TOKEN,
  FAKE_GH_TOKEN,
  finding,
  harness,
  output,
  PR,
  rawThread,
  type Harness,
} from "./orchestrator/harness.js";

let h: Harness;
let base: string;
let head: string;

beforeEach(() => {
  resetSecretsForTests();
  h = harness();
  base = h.repo.commit("base", { "src/app.ts": appSource(), "README.md": "# widgets\n" });
  h.repo.git("checkout", "-q", "-b", "feature");
  head = h.repo.commit("change a5", { "src/app.ts": appSource({ 5: "export const a5 = 50;" }, ["export const a11 = 11;"]) });
});

afterEach(() => {
  h.cleanup();
  resetSecretsForTests();
});

interface PostedReview {
  commit_id: string;
  event: string;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
}

const postedReview = (i = 0): PostedReview => {
  const call = h.posts()[i];
  if (!call) throw new Error(`no review POST #${i}`);
  return call.body as PostedReview;
};

/** Everything that left the job: posted reviews, PATCHes, job summary, run document. */
const outbound = (): string =>
  [
    ...h.server.calls.filter((c) => c.method !== "GET").map((c) => JSON.stringify(c.body)),
    h.summary(),
    JSON.stringify(h.runDocument()),
  ].join("\n");

describe("full review", () => {
  it("posts one REQUEST_CHANGES review when both engines agree on a major finding", async () => {
    h.routes({ head, base });
    const f = output([finding()]);
    const code = await runPipeline(h.deps({ claude: { review: f }, codex: { review: f } }));

    expect(code).toBe(0);
    expect(h.posts()).toHaveLength(1);
    const r = postedReview();
    expect(r.commit_id).toBe(head);
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("**myrabbit: REQUEST_CHANGES**");
    expect(r.body).toContain("reviewed by claude+codex");
    expect(r.body.trimEnd().endsWith("-->")).toBe(true);
    expect(r.body).toContain(`<!-- myrabbit:state v=1 head=${head} base=${base} mode=full`);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({ path: "src/app.ts", line: 5, side: "RIGHT" });
    expect(r.comments[0]?.body).toMatch(/<!-- myrabbit:f v=1 fp=[0-9a-f]{12} sev=major blk=1 -->/);

    // Same prompt to both engines, nonce-delimited, with the diff and the PR text inside.
    const reviews = h.calls.filter((c) => c.task === "review");
    expect(reviews.map((c) => c.engine)).toEqual(["claude", "codex"]);
    expect(reviews[0]?.prompt).toBe(reviews[1]?.prompt);
    expect(reviews[0]?.prompt).toContain("<untrusted-0123456789abcdef>");
    expect(reviews[0]?.prompt).toContain("+export const a5 = 50;");
    expect(reviews[0]?.prompt).toContain("Changes a5.");
    // The description comes from the prepare GET: one GET for prepare, one for the post recheck.
    expect(h.server.calls.filter((c) => c.method === "GET" && c.path === `/repos/acme/widgets/pulls/${PR}`)).toHaveLength(2);
    expect(reviews[0]?.prompt).toContain("change a5");
    // Agreement counts as verified: no verify call.
    expect(h.calls.some((c) => c.task === "verify")).toBe(false);
    expect(h.counter).toEqual({ setups: 1, cleanups: 1 });

    const doc = h.runDocument();
    expect(doc).toMatchObject({ schema_version: "1", verdict: "REQUEST_CHANGES", run: { sources: ["claude", "codex"] } });
    expect(h.summary()).toContain("Posted review: REQUEST_CHANGES");
  });

  it("APPROVEs when there are no findings", async () => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: {}, codex: {} }));
    expect(code).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(postedReview().comments).toEqual([]);
  });

  it("verifies a single-model blocker with the other engine and demotes it when refuted", async () => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: { review: output([finding()]) }, codex: { confirmed: false } }));
    expect(code).toBe(0);
    const verify = h.calls.filter((c) => c.task === "verify");
    expect(verify.map((c) => c.engine)).toEqual(["codex"]);
    expect(verify[0]?.prompt).toContain("Constant a5 has the wrong value");
    expect(postedReview().event).toBe("APPROVE");
  });

  it("redacts secrets an engine echoes into a finding, everywhere it leaves the job", async () => {
    h.routes({ head, base });
    const leak = output([finding({ body: `token is ${FAKE_CLAUDE_TOKEN} and ${FAKE_GH_TOKEN}` })]);
    await runPipeline(h.deps({ claude: { review: leak }, codex: { review: leak } }));
    const all = outbound();
    expect(all).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(all).not.toContain(FAKE_GH_TOKEN);
    expect(postedReview().comments[0]?.body).toContain("***");
    // The secrets are gone from the environment once read.
    expect(h.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(h.env.MYRABBIT_GITHUB_TOKEN).toBeUndefined();
    expect(h.env.CODEX_AUTH_JSON).toBeUndefined();
  });

  it("runs on workflow_dispatch with the pr input (always full)", async () => {
    h.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    h.env.MYRABBIT_PR = String(PR);
    delete h.env.GITHUB_EVENT_PATH;
    h.routes({ head, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(postedReview().body).toContain("mode=full");
  });
});

describe("failure policy (§2.2)", () => {
  it("continues with one engine when the other fails, and says so", async () => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: { review: output([finding()]) }, codex: { review: { fail: "timeout" } } }));
    expect(code).toBe(0);
    const r = postedReview();
    expect(r.body).toContain("reviewed by claude only (codex failed: timeout)");
    // The single-model blocker is verified by a fresh call to the surviving engine.
    expect(h.calls.filter((c) => c.task === "verify").map((c) => c.engine)).toEqual(["claude"]);
    expect(r.event).toBe("REQUEST_CHANGES");
  });

  it("posts nothing and exits 1 when both engines fail", async () => {
    h.routes({ head, base });
    const code = await runPipeline(h.deps({ claude: { review: { fail: "timeout" } }, codex: { review: { fail: "sdk_error" } } }));
    expect(code).toBe(1);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("both engines failed");
    expect(h.summary()).toContain("claude: timeout");
    expect(h.counter.cleanups).toBe(1);
  });

  it("fails closed before any model call when a secret is empty", async () => {
    h.routes({ head, base });
    h.env.CLAUDE_CODE_OAUTH_TOKEN = "  ";
    const code = await runPipeline(h.deps({ claude: {}, codex: {} }));
    expect(code).toBe(1);
    expect(h.counter.setups).toBe(0);
    expect(h.server.calls).toHaveLength(0);
    expect(h.summary()).toContain("missing secret CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("posts nothing and exits 0 when the head moved before posting", async () => {
    h.routes({ head, base });
    // The second GET (postReview's recheck) sees a newer head.
    h.server.on("GET", `/repos/acme/widgets/pulls/${PR}`, { body: prBody(head) }, { body: prBody("d".repeat(40)) });
    const code = await runPipeline(h.deps({ claude: {}, codex: {} }));
    expect(code).toBe(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("Head moved");
  });

  it("retries body-only once after a 422, with every finding in the body", async () => {
    h.routes({ head, base });
    h.server.on("POST", `/repos/acme/widgets/pulls/${PR}/reviews`, { status: 422, body: { message: "Unprocessable" } }, {
      body: { id: 2, html_url: "https://github.com/acme/widgets/pull/7#r2" },
    });
    const f = output([finding()]);
    const code = await runPipeline(h.deps({ claude: { review: f }, codex: { review: f } }));
    expect(code).toBe(0);
    expect(h.posts()).toHaveLength(2);
    const retry = postedReview(1);
    expect(retry.comments).toEqual([]);
    expect(retry.body).toContain("Constant a5 has the wrong value");
    expect(retry.event).toBe("REQUEST_CHANGES");
  });

  it("exits 1 when the body-only retry fails too", async () => {
    h.routes({ head, base });
    h.server.on("POST", `/repos/acme/widgets/pulls/${PR}/reviews`, { status: 422, body: { message: "Unprocessable" } });
    const f = output([finding()]);
    expect(await runPipeline(h.deps({ claude: { review: f }, codex: { review: f } }))).toBe(1);
  });
});

function prBody(sha: string): Record<string, unknown> {
  return {
    number: PR,
    state: "open",
    merged: false,
    draft: false,
    title: "Change constants",
    body: "",
    labels: [],
    user: { login: "dlled" },
    html_url: "https://github.com/acme/widgets/pull/7",
    head: { sha, ref: "feature", repo: { full_name: "acme/widgets" } },
    base: { sha: base, ref: "main", repo: { full_name: "acme/widgets" } },
  };
}

describe("a PR that is no longer open (merged or closed while queued) is a neutral skip", () => {
  const neutral = async (state: string): Promise<void> => {
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.counter.setups).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.logs).toContain(`::notice::myrabbit: PR #${String(PR)} is ${state}; nothing to review`);
    expect(h.logs).toContain(`myrabbit: skipped (PR is ${state})`);
    expect(h.summary()).not.toContain("refusing to review");
  };

  it("merged", async () => {
    h.routes({ head, base, state: "closed", merged: true });
    await neutral("merged");
  });

  it("closed", async () => {
    h.routes({ head, base, state: "closed" });
    await neutral("closed");
  });

  it("on workflow_dispatch too (the sweep)", async () => {
    h.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    h.env.MYRABBIT_PR = String(PR);
    h.routes({ head, base, state: "closed", merged: true });
    await neutral("merged");
  });

  it("an open draft is unchanged: skipped by auto_review.drafts, with no notice", async () => {
    h.routes({ head, base, draft: true });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.counter.setups).toBe(0);
    expect(h.summary()).toContain("draft PR");
    expect(h.logs.some((l) => l.startsWith("::notice::"))).toBe(false);
  });
});

describe("eligibility (§10.1) — refused before any model call", () => {
  const refused = async (): Promise<void> => {
    const code = await runPipeline(h.deps({ claude: {}, codex: {} }));
    expect(code).toBe(1);
    expect(h.counter.setups).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("refusing to review");
  };

  it("untrusted author", async () => {
    h.routes({ head, base, author: "mallory" });
    await refused();
  });

  it("trusted authors compare case-insensitively", async () => {
    h.routes({ head, base, author: "DLLED" });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
  });

  it("fork", async () => {
    h.routes({ head, base, headRepo: "mallory/widgets" });
    await refused();
  });

  it("a closed PR that is also untrusted still fails closed", async () => {
    h.routes({ head, base, state: "closed", author: "mallory" });
    await refused();
  });

  it("checkout is not the PR head", async () => {
    h.routes({ head: "e".repeat(40), base });
    await refused();
  });

  it("also on workflow_dispatch", async () => {
    h.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    h.env.MYRABBIT_PR = String(PR);
    h.routes({ head, base, author: "someone-else" });
    await refused();
  });
});

describe("skips (exit 0, nothing posted)", () => {
  it("loop guard: the run was triggered by the bot", async () => {
    h.env.GITHUB_ACTOR = BOT;
    h.routes({ head, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.server.calls).toHaveLength(0);
    expect(h.summary()).toContain("Skipped");
  });

  it("head already reviewed", async () => {
    const cfgHash = configHash(defaultConfig(), []);
    const marker = buildStateMarker({ v: 1, head, base, mode: "full", config: cfgHash, prompt: promptVersion(loadTemplates()) });
    h.routes({ head, base }, { reviews: [review(1, head, marker)] });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.counter.setups).toBe(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain("already reviewed");
  });

  it("draft PR with auto_review.drafts false", async () => {
    h.routes({ head, base, draft: true });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.counter.setups).toBe(0);
    expect(h.summary()).toContain("draft PR");
  });

  it("skip label from the base config", async () => {
    h.routes({ head, base, labels: ["no-myrabbit"] });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.posts()).toHaveLength(0);
  });
});

function review(id: number, commit: string, body: string): Record<string, unknown> {
  return { id, user: { login: BOT }, state: "CHANGES_REQUESTED", body: `**myrabbit**\n\n${body}`, commit_id: commit, submitted_at: "2026-11-01T00:00:00Z" };
}

describe("config from the base SHA (§4)", () => {
  it("applies limits from the base config and blocks on incomplete coverage", async () => {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", { ".myrabbit.yaml": "version: 1\nlimits:\n  max_files: 1\n" });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    const newHead = h.repo.commit("two files", { "src/b.ts": "export const b = 1;\n" });
    h.routes({ head: newHead, base: newBase });
    const code = await runPipeline(h.deps({ claude: {}, codex: {} }));
    expect(code).toBe(0);
    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("Review incomplete: 1 file not reviewed (limit max_files 1)");
  });

  it("ignores a .myrabbit.yaml added by the PR itself and notes it applies after merge", async () => {
    const newHead = h.repo.commit("weaken config", { ".myrabbit.yaml": "version: 1\nrequest_changes_threshold: critical\n" });
    h.routes({ head: newHead, base });
    const f = output([finding()]);
    await runPipeline(h.deps({ claude: { review: f }, codex: { review: f } }));
    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("config changes take effect after merge");
  });

  it("approves with no engine call when every changed file is filtered", async () => {
    h.repo.git("reset", "-q", "--hard", base);
    const only = h.repo.commit("lockfile only", { "package-lock.json": "{}\n" });
    h.routes({ head: only, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.counter.setups).toBe(0);
    const r = postedReview();
    expect(r.event).toBe("APPROVE");
    expect(r.body).toContain("no reviewable changes; 1 files filtered");
    expect(r.body).toContain("`claude`: not run (no reviewable text changes)");
    expect(h.summary()).toContain("| claude | default | not run |");
  });
});

describe("incremental review (§2.1, §6.4)", () => {
  it("reviews last..head, resolves a fixed blocking thread and APPROVEs, then marks it addressed", async () => {
    const cfgHash = configHash(defaultConfig(), []);
    const marker = buildStateMarker({ v: 1, head, base, mode: "full", config: cfgHash, prompt: "p1" });
    const fixedHead = h.repo.commit("fix a5", { "src/app.ts": appSource({ 5: "export const a5 = 5;" }, ["export const a11 = 11;"]) });
    const fp = fingerprint("src/app.ts", "correctness", "Constant a5 has the wrong value");
    const fmark = buildFindingMarker({ v: 1, fp, sev: "major", blk: true });
    const thread = rawThread({
      id: "T1",
      databaseId: 101,
      line: 5,
      body: `**[major · correctness]** Constant a5 has the wrong value\n\na5 must stay 5.\n\n<sub>found by claude+codex · confidence 0.90</sub>\n${fmark}`,
    });
    h.routes({ head: fixedHead, base }, { reviews: [review(1, head, marker)], threads: [thread] });

    const code = await runPipeline(h.deps({ claude: { fixed: true }, codex: {} }));
    expect(code).toBe(0);

    const reviewPrompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    expect(reviewPrompt).toContain("Mode: incremental");
    expect(reviewPrompt).toContain(`fp=${fp}`);
    expect(h.calls.filter((c) => c.task === "resolve").map((c) => c.engine)).toEqual(["claude"]);

    const r = postedReview();
    expect(r.event).toBe("APPROVE");
    expect(r.body).toContain("mode=incremental");
    // Edit + resolve happen after the POST.
    const order = h.server.calls.map((c) => `${c.method} ${c.path}`);
    const postAt = order.indexOf(`POST /repos/acme/widgets/pulls/${PR}/reviews`);
    const patchAt = order.indexOf("PATCH /repos/acme/widgets/pulls/comments/101");
    expect(patchAt).toBeGreaterThan(postAt);
    const patch = h.server.calls[patchAt]?.body as { body: string };
    expect(patch.body).toContain(`✅ Addressed in ${fixedHead.slice(0, 7)}`);
    expect(h.server.calls.some((c) => c.path === "/graphql" && JSON.stringify(c.body).includes("resolveReviewThread"))).toBe(true);
  });

  it("keeps an open blocking thread blocking when it is not fixed", async () => {
    const cfgHash = configHash(defaultConfig(), []);
    const marker = buildStateMarker({ v: 1, head, base, mode: "full", config: cfgHash, prompt: "p1" });
    const next = h.repo.commit("touch a5 again", { "src/app.ts": appSource({ 5: "export const a5 = 51;" }, ["export const a11 = 11;"]) });
    const fmark = buildFindingMarker({ v: 1, fp: "abcdef012345", sev: "major", blk: true });
    const thread = rawThread({ id: "T1", databaseId: 101, line: 5, body: `**[major · correctness]** a5 wrong\n\nbody\n${fmark}` });
    h.routes({ head: next, base }, { reviews: [review(1, head, marker)], threads: [thread] });
    expect(await runPipeline(h.deps({ claude: { fixed: false }, codex: {} }))).toBe(0);
    expect(postedReview().event).toBe("REQUEST_CHANGES");
    expect(h.server.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("falls back to full when the last reviewed commit is not an ancestor (force push)", async () => {
    const cfgHash = configHash(defaultConfig(), []);
    const marker = buildStateMarker({ v: 1, head: "f".repeat(40), base, mode: "full", config: cfgHash, prompt: "p1" });
    h.routes({ head, base }, { reviews: [review(1, "f".repeat(40), marker)] });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(postedReview().body).toContain("mode=full");
  });
});

describe("learnings (design-v2 §6)", () => {
  const LEARNINGS = "## Existing rule\npaths: src/**\nKeep constants in src/app.ts.\n";

  /** Base config + learnings on main, merged into the feature branch, then one more PR commit. */
  function withBase(yaml: string): { newBase: string; findingHead: string; newHead: string } {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", { ".myrabbit.yaml": yaml, ".myrabbit/learnings.md": LEARNINGS });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    const findingHead = h.repo.git("rev-parse", "HEAD");
    // Changes line 5 again; line 9 stays as it was when the findings were posted.
    const newHead = h.repo.commit("touch a5", { "src/app.ts": appSource({ 5: "export const a5 = 55;" }, ["export const a11 = 11;"]) });
    return { newBase, findingHead, newHead };
  }

  function dismissed(id: number, line: number, fp: string, commit: string, replies: { login: string; typename?: string; body: string }[]) {
    const fmark = buildFindingMarker({ v: 1, fp, sev: "major", blk: true });
    return rawThread({
      id: `T${id}`,
      databaseId: id,
      line,
      isResolved: true,
      resolvedBy: "dlled",
      originalCommit: commit,
      replies,
      body: `**[major · correctness]** Constant a${line} looks wrong\n\nbody\n\n<sub>found by codex · confidence 0.90</sub>\n${fmark}`,
    });
  }

  const TRUSTED_REPLY = [{ login: "dlled", body: "This is intended: the constants mirror the wire format." }];
  const PROPOSAL = { propose: true, title: "Wire-format constants", rule: "Constants in src/app.ts mirror the wire format; do not flag their values.", paths: ["src/**"] };

  it("proposes a learning for a dismissed thread with an unchanged anchor and a trusted reply", async () => {
    const { newBase, findingHead, newHead } = withBase("version: 1\nlearnings:\n  propose: true\n");
    const threads = [
      dismissed(201, 9, "aaaaaaaaaaa1", findingHead, TRUSTED_REPLY), // qualifies
      dismissed(202, 5, "aaaaaaaaaaa2", findingHead, TRUSTED_REPLY), // line 5 changed since
      dismissed(203, 8, "aaaaaaaaaaa3", findingHead, [{ login: "someone", body: "nah" }]), // untrusted
      dismissed(204, 7, "aaaaaaaaaaa4", findingHead, TRUSTED_REPLY), // proposed before (bot body)
      dismissed(205, 6, "aaaaaaaaaaa5", "e".repeat(40), TRUSTED_REPLY), // commit gone
    ];
    const reviews = [
      review(1, findingHead, "<!-- myrabbit:proposal v=1 fp=aaaaaaaaaaa4 -->"),
      // A marker in a human review never suppresses a proposal.
      { ...review(2, findingHead, "<!-- myrabbit:proposal v=1 fp=aaaaaaaaaaa1 -->"), user: { login: "dlled" } },
    ];
    h.routes({ head: newHead, base: newBase }, { reviews, threads });
    expect(await runPipeline(h.deps({ claude: {}, codex: { learning: PROPOSAL } }))).toBe(0);

    const learningCalls = h.calls.filter((c) => c.learning);
    expect(learningCalls.map((c) => c.engine)).toEqual(["codex"]);
    expect(learningCalls[0]?.prompt).toContain("the constants mirror the wire format");
    expect(learningCalls[0]?.prompt).toContain("lines: 9 (RIGHT)");
    const expected = { title: PROPOSAL.title, rule: PROPOSAL.rule, paths: PROPOSAL.paths };
    expect(h.runDocument()?.proposed_learnings).toEqual([{ ...expected, fingerprint: "aaaaaaaaaaa1", source: "codex" }]);
    // PW-P1: rendered in the body with the hidden marker the next run reads back.
    const body = postedReview().body;
    expect(body).toContain(buildProposalMarker("aaaaaaaaaaa1"));
    expect(body).toContain("Wire-format constants");
    expect(body).not.toContain(buildProposalMarker("aaaaaaaaaaa4"));
    expect(postedReview().event).toBe("APPROVE");
  });

  it("drops a proposal whose title learnings.md already has, and survives a failed call", async () => {
    const { newBase, findingHead, newHead } = withBase("version: 1\nlearnings:\n  propose: true\n");
    const threads = [dismissed(201, 9, "aaaaaaaaaaa1", findingHead, TRUSTED_REPLY), dismissed(202, 8, "aaaaaaaaaaa2", findingHead, TRUSTED_REPLY)];
    h.routes({ head: newHead, base: newBase }, { threads });
    expect(await runPipeline(h.deps({ codex: { learning: { ...PROPOSAL, title: " existing   RULE " } } }))).toBe(0);
    expect(h.calls.filter((c) => c.learning)).toHaveLength(2);
    expect(h.runDocument()).not.toHaveProperty("proposed_learnings");
  });

  it("posts the review when every proposal call fails", async () => {
    const { newBase, findingHead, newHead } = withBase("version: 1\nlearnings:\n  propose: true\n");
    h.routes({ head: newHead, base: newBase }, { threads: [dismissed(201, 9, "aaaaaaaaaaa1", findingHead, TRUSTED_REPLY)] });
    expect(await runPipeline(h.deps({ codex: { learning: "fail" } }))).toBe(0);
    expect(h.calls.filter((c) => c.learning)).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("proposal call failed"))).toBe(true);
    expect(h.runDocument()).not.toHaveProperty("proposed_learnings");
    expect(postedReview().event).toBe("APPROVE");
  });

  it("notes that a PR editing learnings.md takes effect after merge", async () => {
    const newHead = h.repo.commit("add learning", { ".myrabbit/learnings.md": LEARNINGS });
    h.routes({ head: newHead, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(postedReview().body).toContain("config changes take effect after merge");
  });

  it("makes no proposal call by default", async () => {
    const { newBase, findingHead, newHead } = withBase("version: 1\n");
    h.routes({ head: newHead, base: newBase }, { threads: [dismissed(201, 9, "aaaaaaaaaaa1", findingHead, TRUSTED_REPLY)] });
    expect(await runPipeline(h.deps({ claude: {}, codex: { learning: PROPOSAL } }))).toBe(0);
    expect(h.calls.some((c) => c.learning)).toBe(false);
    expect(h.runDocument()).not.toHaveProperty("proposed_learnings");
  });

  it("§6.1: puts base-SHA learnings in the review prompt when enabled", async () => {
    const { newBase, newHead } = withBase("version: 1\nlearnings:\n  enabled: true\n");
    h.routes({ head: newHead, base: newBase });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    expect(prompt).toContain("Keep constants in src/app.ts.");
    expect(prompt).toContain("Existing rule");
  });
});

describe("walkthrough (design-v2 §4.1–§4.3)", () => {
  function withConfig(yaml: string): { newBase: string; newHead: string } {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", { ".myrabbit.yaml": yaml });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    return { newBase, newHead: h.repo.git("rev-parse", "HEAD") };
  }
  const ALL_ON = "version: 1\nwalkthrough:\n  effort: true\n  merge_risk: true\n  ai_agent_prompts: true\n";

  it("by default asks for the v1 schema and adds no v2 item to the body or run document", async () => {
    h.routes({ head, base });
    const f = output([finding()]);
    await runPipeline(h.deps({ claude: { review: f }, codex: { review: f } }));
    for (const c of h.calls.filter((x) => x.task === "review")) expect(c.outputSchema).toBe(REVIEW_OUTPUT_SCHEMA);
    const body = postedReview().body;
    expect(body).not.toContain("Merge risk");
    expect(body).not.toContain("Review effort");
    expect(body).not.toContain("Prompt for AI agents");
    const doc = h.runDocument();
    expect(doc).not.toHaveProperty("risk");
    expect(doc).not.toHaveProperty("effort");
  });

  it("shows merge risk, the higher effort and AI-agent prompts when on", async () => {
    const { newBase, newHead } = withConfig(ALL_ON);
    h.routes({ head: newHead, base: newBase });
    const claude = { ...output([finding()]), effort: { score: 2, minutes: 15 } };
    const codex = { ...output([finding()]), effort: { score: 4, minutes: 45 } };
    expect(await runPipeline(h.deps({ claude: { review: claude }, codex: { review: codex } }))).toBe(0);

    const schema = h.calls.find((c) => c.task === "review")?.outputSchema as { required: string[] };
    expect(schema.required).toContain("effort");
    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain(`**Merge risk:** High · up to \`${newHead.slice(0, 7)}\``);
    expect(r.body).toContain("**Review effort:** 4/5");
    expect(r.body).toContain("~45 min");
    expect(`${r.body}\n${r.comments.map((c) => c.body).join("\n")}`).toContain("Prompt for AI agents");
    expect(h.runDocument()).toMatchObject({ risk: "high", effort: { score: 4, minutes: 45 } });
  });

  it("is minimal risk with nothing open", async () => {
    const { newBase, newHead } = withConfig("version: 1\nwalkthrough:\n  merge_risk: true\n");
    h.routes({ head: newHead, base: newBase });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(h.runDocument()).toMatchObject({ risk: "minimal" });
    expect(h.runDocument()).not.toHaveProperty("effort");
  });

  it("is low risk with only a non-blocking finding open", async () => {
    const { newBase, newHead } = withConfig("version: 1\nwalkthrough:\n  merge_risk: true\n");
    h.routes({ head: newHead, base: newBase });
    const minor = output([finding({ severity: "minor", title: "Minor naming nit" })]);
    expect(await runPipeline(h.deps({ claude: { review: minor }, codex: { review: minor } }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(postedReview().body).toContain("**Merge risk:** Low");
    expect(h.runDocument()).toMatchObject({ risk: "low" });
  });
});

describe("rule packs (design-v2 §4.4)", () => {
  it("adds an enabled pack whose globs match a reviewed file, and nothing by default", async () => {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", { ".myrabbit.yaml": "version: 1\nrule_packs:\n  typescript: true\n  python: true\n" });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    const newHead = h.repo.git("rev-parse", "HEAD");
    h.routes({ head: newHead, base: newBase });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    const guide = prompt.slice(prompt.indexOf("<style-guide>"), prompt.indexOf("</style-guide>"));
    expect(guide).toContain("[pack typescript]");
    // python is on, but no reviewed file matches its globs.
    expect(guide).not.toContain("[pack python]");
  });

  it("sends no pack with the default config", async () => {
    h.routes({ head, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("[pack ");
  });
});

describe("context pack (design-v2 §3)", () => {
  it("follows a changed symbol to its usages and puts them only in <related-code>", async () => {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config + caller", {
      ".myrabbit.yaml": "version: 1\ncontext:\n  enabled: true\n  typescript: false\n",
      "src/use.ts": 'import { a11 } from "./app";\n\nexport function lookup(xs: number[]): number | undefined {\n  return xs[a11];\n}\n',
    });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    const newHead = h.repo.git("rev-parse", "HEAD");
    h.routes({ head: newHead, base: newBase });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);

    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    const open = prompt.indexOf("<related-code>");
    const close = prompt.indexOf("</related-code>");
    expect(open).toBeGreaterThan(-1);
    const related = prompt.slice(open, close);
    expect(related).toContain("src/use.ts");
    expect(related).toContain("return xs[a11];");
    // Only in <related-code>: the caller's text appears nowhere else in the prompt.
    expect(prompt.split("return xs[a11];")).toHaveLength(2);
    // Inside the untrusted block.
    expect(open).toBeGreaterThan(prompt.indexOf("<untrusted-0123456789abcdef>"));

    const doc = h.runDocument();
    expect(doc?.context).toMatchObject({ resolver: "tree-sitter" });
    expect((doc?.context as { usages: number }).usages).toBeGreaterThan(0);
    expect(postedReview().body).toContain("**Additional context:**");
  });

  it("is off by default: no <related-code>, no context field", async () => {
    h.routes({ head, base });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<related-code>");
    expect(h.runDocument()).not.toHaveProperty("context");
    expect(postedReview().body).not.toContain("Additional context");
  });

  it("gets the run signal: an expired run deadline stops the pack instead of holding the review", async () => {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config + caller", {
      ".myrabbit.yaml": "version: 1\ncontext:\n  enabled: true\n  typescript: false\n",
      "src/use.ts": 'import { a11 } from "./app";\n\nexport const x = a11;\n',
    });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    const newHead = h.repo.git("rev-parse", "HEAD");
    h.routes({ head: newHead, base: newBase });
    // The fake engines ignore the signal, so the review still posts; the pack, which honours it,
    // follows nothing.
    const started = Date.now();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { runDeadlineMs: 1 }))).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.calls.find((c) => c.task === "review")?.prompt ?? "").not.toContain("export const x = a11;");
  });
});

describe("related issues/PRs and suggested reviewers (design-v2 §4.6–§4.7)", () => {
  const ON = "version: 1\nwalkthrough:\n  related: true\n  suggested_reviewers: true\n";
  function withBase(files: Record<string, string>): { newBase: string; newHead: string } {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", files);
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    return { newBase, newHead: h.repo.git("rev-parse", "HEAD") };
  }
  const issue = (number: number, repo = "acme/widgets") => ({
    number,
    title: `Issue ${number}`,
    body: `Body of issue ${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
  });
  function relatedRoutes(): void {
    h.server.on("GET", "/search/issues", { body: { total_count: 2, incomplete_results: false, items: [issue(17), issue(18, "acme/other")] } });
    h.server.on("GET", /^\/repos\/acme\/widgets\/commits\/[0-9a-f]{40}\/pulls$/, {
      body: [{ number: 3, title: "Earlier app change", body: "x", merged_at: "2026-01-01T00:00:00Z", base: { repo: { full_name: "acme/widgets" } } }],
    });
    h.server.on("GET", /^\/repos\/acme\/widgets\/commits\/[0-9a-f]{40}$/, { body: { sha: "x", author: { login: "alice", type: "User" } } });
  }

  it("gives the candidates to the engines, keeps only candidate picks, and suggests reviewers", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": ON, ".github/CODEOWNERS": "* @bob\n" });
    h.routes({ head: newHead, base: newBase });
    relatedRoutes();
    const claude = { ...output([]), related: [{ number: 17, reason: "same widget bug" }, { number: 99, reason: "not a candidate" }] };
    const codex = { ...output([]), related: [{ number: 3, reason: "touched app.ts" }, { number: 17, reason: "dup" }] };
    expect(await runPipeline(h.deps({ claude: { review: claude }, codex: { review: codex } }))).toBe(0);

    const call = h.calls.find((c) => c.task === "review");
    const prompt = call?.prompt ?? "";
    const open = prompt.indexOf("<candidates>");
    expect(open).toBeGreaterThan(prompt.indexOf("<untrusted-0123456789abcdef>"));
    const block = prompt.slice(open, prompt.indexOf("</candidates>"));
    expect(block).toContain("Issue 17");
    expect(block).toContain("Earlier app change");
    // Another repo's issue is filtered out before the engines see it.
    expect(block).not.toContain("Issue 18");
    expect((call?.outputSchema as { required: string[] }).required).toContain("related");

    const doc = h.runDocument();
    expect(doc?.related).toEqual([
      { number: 17, kind: "issue", reason: "same widget bug" },
      { number: 3, kind: "pr", reason: "touched app.ts" },
    ]);
    expect(doc?.reviewers).toEqual([
      { login: "bob", reason: "codeowners" },
      { login: "alice", reason: "recent_changes" },
    ]);
    const body = postedReview().body;
    expect(body).toContain("**Related issues and PRs:**");
    expect(body).toContain("**Suggested reviewers:**");
    expect(body).not.toContain("not a candidate");
    // Suggested, never requested.
    expect(h.server.calls.some((c) => c.path.endsWith("/requested_reviewers"))).toBe(false);
  });

  it("gives the candidate search its own budget: a context pack slower than the budget does not starve it", async () => {
    const { newBase, newHead } = withBase({
      ".myrabbit.yaml": "version: 1\ncontext:\n  enabled: true\n  typescript: false\nwalkthrough:\n  related: true\n",
      "src/use.ts": 'import { a11 } from "./app";\n\nexport const y = a11;\n',
    });
    h.routes({ head: newHead, base: newBase });
    relatedRoutes();
    // The pack's usage search (git grep) takes longer than the whole related budget.
    const slowGrep = (workspace: string): GitRunner => {
      const real = createGitRunner(workspace);
      return async (args, options) => {
        if (args.includes("grep")) await new Promise((r) => setTimeout(r, 400));
        return real(args, options);
      };
    };
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { relatedBudgetMs: 200, git: slowGrep }))).toBe(0);
    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    expect(prompt).toContain("<related-code>");
    expect(prompt.slice(prompt.indexOf("<candidates>"), prompt.indexOf("</candidates>"))).toContain("Issue 17");
    expect(postedReview().body).not.toMatch(/related.*unavailable/i);
  });

  it("shows related as unavailable when the search fails, and still posts", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": "version: 1\nwalkthrough:\n  related: true\n" });
    h.routes({ head: newHead, base: newBase });
    h.server.on("GET", "/search/issues", { status: 422, body: { message: "Validation Failed" } });
    h.server.on("GET", /^\/repos\/acme\/widgets\/commits\/[0-9a-f]{40}\/pulls$/, { body: [] });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<candidates>");
    expect(postedReview().body).toMatch(/related.*unavailable/i);
    expect(h.runDocument()).not.toHaveProperty("related");
    expect(h.runDocument()).not.toHaveProperty("reviewers");
  });

  it("a hanging GitHub API costs the time budget, not the review", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": ON, ".github/CODEOWNERS": "* @bob\n" });
    h.routes({ head: newHead, base: newBase });
    // Search and commit lookups never answer; everything else goes to the fake server.
    const hang = ((input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      return path === "/search/issues" || path.includes("/commits/") ? new Promise<Response>(() => undefined) : h.server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const code = await runPipeline(
      h.deps(
        { claude: {}, codex: {} },
        {
          relatedBudgetMs: 200,
          github: (runtime) => createGitHubClientWithToken(runtime.secrets.githubToken, { fetch: hang, sleep: () => Promise.resolve() }),
        },
      ),
    );
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<candidates>");
    expect(postedReview().body).toMatch(/related.*unavailable/i);
    // The deadline aborts the stalled blame lookups, and the CODEOWNERS pick made before them is kept.
    expect(h.runDocument()).not.toHaveProperty("related");
    expect(h.runDocument()).toMatchObject({ reviewers: [{ login: "bob", reason: "codeowners" }] });
  });

  it("is off by default: no search, no commit lookups, no candidates, no reviewers", async () => {
    h.routes({ head, base });
    relatedRoutes();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.server.calls.some((c) => c.path === "/search/issues" || c.path.includes("/commits/"))).toBe(false);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<candidates>");
    expect(h.runDocument()).not.toHaveProperty("related");
    expect(h.runDocument()).not.toHaveProperty("reviewers");
    expect(postedReview().body).not.toContain("Suggested reviewers");
  });
});

describe("pre-merge checks (design-v2 §5)", () => {
  function withBase(files: Record<string, string>): { newBase: string; newHead: string } {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", files);
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    return { newBase, newHead: h.repo.git("rev-parse", "HEAD") };
  }
  const TITLE_ERROR = "version: 1\npre_merge_checks:\n  title:\n    mode: error\n";
  const withChecks = (checks: { name: string; status: "pass" | "fail" | "inconclusive"; explanation: string }[]) => ({ ...output([]), checks });
  const labelEvent = (event: string, login: string, type = "User") => ({
    event,
    created_at: "2026-11-03T10:00:00Z",
    actor: { login, type },
    label: { name: "myrabbit:ignore-checks" },
  });

  it("blocks on a failed error-mode check, with the explanation redacted and sanitized", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    h.routes({ head: newHead, base: newBase });
    const why = `Title is generic. @someone <!-- myrabbit:finding x --> leaked ${FAKE_GH_TOKEN}`;
    const out = withChecks([{ name: "title", status: "fail", explanation: why }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);

    const call = h.calls.find((c) => c.task === "review");
    expect(call?.prompt).toContain("<pre-merge-checks>");
    expect((call?.outputSchema as { required: string[] }).required).toContain("checks");

    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("### Pre-merge checks");
    expect(r.body).toContain("Pre-merge check failed: title");
    // The model's explanation: no secret, no live mention, no marker, in the body or anywhere else.
    expect(outbound()).not.toContain(FAKE_GH_TOKEN);
    expect(r.body).not.toContain("@someone");
    expect(r.body).not.toContain("<!-- myrabbit:finding x");
    const doc = h.runDocument();
    expect(doc?.checks).toEqual([{ name: "title", mode: "error", status: "fail", explanation: expect.stringContaining("Title is generic.") as unknown }]);
    expect(JSON.stringify(doc)).not.toContain(FAKE_GH_TOKEN);
  });

  it("a split vote is inconclusive and never blocks", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    h.routes({ head: newHead, base: newBase });
    const fail = withChecks([{ name: "title", status: "fail", explanation: "generic" }]);
    const pass = withChecks([{ name: "title", status: "pass", explanation: "fine" }]);
    expect(await runPipeline(h.deps({ claude: { review: fail }, codex: { review: pass } }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(h.runDocument()?.checks).toMatchObject([{ name: "title", status: "inconclusive" }]);
  });

  it("passes the checks to merge risk: a failed warning-mode check is low risk and approves", async () => {
    const { newBase, newHead } = withBase({
      ".myrabbit.yaml": "version: 1\nwalkthrough:\n  merge_risk: true\npre_merge_checks:\n  description:\n    mode: warning\n",
    });
    h.routes({ head: newHead, base: newBase });
    const out = withChecks([{ name: "description", status: "fail", explanation: "Empty description." }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(postedReview().body).toContain("**Merge risk:** Low");
    expect(h.runDocument()).toMatchObject({ risk: "low" });
  });

  it("a trusted override label drops the check blocker, and the body says who applied it", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    h.routes({ head: newHead, base: newBase, labels: ["myrabbit:ignore-checks"] });
    h.server.on("GET", "/repos/acme/widgets/issues/7/timeline", { body: [labelEvent("labeled", "dlled")] });
    const out = withChecks([{ name: "title", status: "fail", explanation: "generic" }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    const r = postedReview();
    expect(r.event).toBe("APPROVE");
    expect(r.body).toContain("overridden by the `myrabbit:ignore-checks` label, applied by `dlled` at 2026-11-03T10:00:00Z");
    // The table still shows the failure.
    expect(h.runDocument()?.checks).toMatchObject([{ name: "title", status: "fail" }]);
  });

  it("ignores the override label applied by an untrusted sender", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    h.routes({ head: newHead, base: newBase, labels: ["myrabbit:ignore-checks"] });
    h.server.on("GET", "/repos/acme/widgets/issues/7/timeline", { body: [labelEvent("labeled", "dlled"), labelEvent("labeled", "mallory")] });
    const out = withChecks([{ name: "title", status: "fail", explanation: "generic" }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    expect(postedReview().event).toBe("REQUEST_CHANGES");
    expect(postedReview().body).toContain("last applied by `mallory`, who is not a trusted author");
  });

  it("a labeled event for the override label runs a full review of an already-reviewed head", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    const marker = buildStateMarker({ v: 1, head: newHead, base: newBase, mode: "full", config: configHash(defaultConfig(), []), prompt: promptVersion(loadTemplates()) });
    h.routes({ head: newHead, base: newBase, labels: ["myrabbit:ignore-checks"] }, { reviews: [review(1, newHead, marker)] });
    h.server.on("GET", "/repos/acme/widgets/issues/7/timeline", { body: [labelEvent("labeled", "dlled")] });
    writeFileSync(h.eventPath, JSON.stringify({ action: "labeled", label: { name: "myrabbit:ignore-checks" }, pull_request: { number: PR } }));
    const out = withChecks([{ name: "title", status: "fail", explanation: "generic" }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
    expect(h.runDocument()).toMatchObject({ verdict: "APPROVE" });
    expect(h.logs.some((l) => l.startsWith("mode full (label_override);"))).toBe(true);
  });

  it("keeps the check blocker when the override label is on but its events cannot be read", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    h.routes({ head: newHead, base: newBase, labels: ["myrabbit:ignore-checks"] });
    h.server.on("GET", "/repos/acme/widgets/issues/7/timeline", { status: 500, body: { message: "boom" } });
    const out = withChecks([{ name: "title", status: "fail", explanation: "generic" }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    expect(postedReview().event).toBe("REQUEST_CHANGES");
    expect(postedReview().body).toContain("its label events could not be read, so it is not applied and the pre-merge check blockers stay");
  });

  it("any other label event on a reviewed head still skips", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TITLE_ERROR });
    const marker = buildStateMarker({ v: 1, head: newHead, base: newBase, mode: "full", config: configHash(defaultConfig(), []), prompt: promptVersion(loadTemplates()) });
    h.routes({ head: newHead, base: newBase }, { reviews: [review(1, newHead, marker)] });
    writeFileSync(h.eventPath, JSON.stringify({ action: "labeled", label: { name: "bug" }, pull_request: { number: PR } }));
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.posts()).toHaveLength(0);
  });

  it("gives linked issues to the engines and asks the linked_issues check", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": "version: 1\npre_merge_checks:\n  linked_issues:\n    mode: warning\n" });
    h.routes({ head: newHead, base: newBase, body: "Changes a5.\n\nFixes #12" });
    h.server.on("GET", "/repos/acme/widgets/issues/12", { body: { number: 12, title: "a5 is wrong", body: "It should be 50." } });
    const out = withChecks([{ name: "linked_issues", status: "pass", explanation: "Addresses #12." }]);
    expect(await runPipeline(h.deps({ claude: { review: out }, codex: { review: out } }))).toBe(0);
    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    const open = prompt.lastIndexOf("<linked-issues>");
    expect(open).toBeGreaterThan(prompt.indexOf("<untrusted-0123456789abcdef>"));
    expect(prompt.slice(open, prompt.lastIndexOf("</linked-issues>"))).toContain("It should be 50.");
    expect(prompt.slice(prompt.indexOf("<pre-merge-checks>"), prompt.indexOf("</pre-merge-checks>"))).toContain("[linked_issues]");
    expect(h.runDocument()?.checks).toMatchObject([{ name: "linked_issues", status: "pass" }]);
  });

  it("computes docstring coverage in code", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": "version: 1\npre_merge_checks:\n  docstrings:\n    mode: warning\n    threshold: 80\n" });
    h.routes({ head: newHead, base: newBase });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    const [c] = (h.runDocument()?.checks ?? []) as { name: string; explanation: string }[];
    expect(c?.name).toBe("docstrings");
    expect(postedReview().body).toContain("| docstrings | warning |");
  });

  it("runs the check inputs under a time budget: a hanging issue fetch is inconclusive, not a hang", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": "version: 1\npre_merge_checks:\n  linked_issues:\n    mode: error\n" });
    h.routes({ head: newHead, base: newBase, body: "Fixes #12" });
    const hang = ((input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      return path.startsWith("/repos/acme/widgets/issues/") ? new Promise<Response>(() => undefined) : h.server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const code = await runPipeline(
      h.deps(
        { claude: {}, codex: {} },
        {
          checksBudgetMs: 200,
          github: (runtime) => createGitHubClientWithToken(runtime.secrets.githubToken, { fetch: hang, sleep: () => Promise.resolve() }),
        },
      ),
    );
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<linked-issues>");
    expect(postedReview().event).toBe("APPROVE");
    expect(h.runDocument()?.checks).toMatchObject([{ name: "linked_issues", status: "inconclusive" }]);
  });

  it("is off by default: no checks asked, listed or fetched", async () => {
    h.routes({ head, base, labels: ["myrabbit:ignore-checks"], body: "Fixes #12" });
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(0);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<pre-merge-checks>");
    expect(h.server.calls.some((c) => c.path.includes("/issues/"))).toBe(false);
    expect(h.runDocument()).not.toHaveProperty("checks");
    expect(postedReview().body).not.toContain("Pre-merge checks");
  });
});

describe("static analysis (design-v2 §7)", () => {
  const TOOLS_ON = "version: 1\ntools:\n  enabled: true\n  gitleaks:\n    enabled: true\n  shellcheck:\n    enabled: true\n";
  function withBase(files: Record<string, string>): { newBase: string; newHead: string } {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", files);
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    return { newBase, newHead: h.repo.git("rev-parse", "HEAD") };
  }

  /** Fake install (a real runner-owned /tmp dir, so removeTools works) and a fake gitleaks. */
  function fakeTools(gitleaks: (stage: string) => string) {
    const state = { installed: [] as string[][], removed: [] as string[], roots: [] as string[], wrappers: [] as string[] };
    const deps: ToolsDeps = {
      install: async (tools) => {
        state.installed.push([...tools]);
        const root = mkdtempSync(join(tmpdir(), "myrabbit-tools-"));
        state.roots.push(root);
        const installed = Object.fromEntries(tools.map((t) => [t, `${root}/bin/${t}`]));
        return Promise.resolve({ manifest_version: 1 as const, root, installed, failed: {}, versions: {} });
      },
      remove: async (root) => {
        state.removed.push(root);
        rmSync(root, { recursive: true, force: true });
        return Promise.resolve();
      },
      asTools: "/nonexistent/as-tools",
      asRunnerTools: "/nonexistent/as-runner-tools",
      ruffSelect: () => Promise.resolve("E"),
      exec: (cmd, options) => {
        state.wrappers.push(options.asTools);
        const tool = cmd.file.split("/").at(-1);
        const stdout = tool === "gitleaks" ? gitleaks(cmd.args[1] ?? "") : "[]";
        return Promise.resolve({ code: 0, stdout, stderr: "", timedOut: false, failed: false });
      },
    };
    return { deps, state };
  }
  const leakAt = (line: number) => (stage: string) =>
    JSON.stringify([{ RuleID: "generic-api-key", File: `${stage}/src/app.ts`, StartLine: line, Match: "REDACTED", Secret: "REDACTED" }]);

  it("with isolation none the tools run through bin/as-runner-tools, and the job warns", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    h.routes({ head: newHead, base: newBase });
    h.env.MYRABBIT_ISOLATION = "none";
    h.env.MYRABBIT_ENGINES = "claude";
    delete h.env.CODEX_AUTH_JSON;
    const t = fakeTools(() => "[]");
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);
    expect(t.state.wrappers.length).toBeGreaterThan(0);
    expect(new Set(t.state.wrappers)).toEqual(new Set(["/nonexistent/as-runner-tools"]));
    expect(h.logs).toContain(TOOLS_ISOLATION_NONE_WARNING);
  });

  it("with the default isolation the tools run through bin/as-tools, with no warning", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    h.routes({ head: newHead, base: newBase });
    const t = fakeTools(() => "[]");
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);
    expect(new Set(t.state.wrappers)).toEqual(new Set(["/nonexistent/as-tools"]));
    expect(h.logs.some((l) => l.startsWith("::warning::"))).toBe(false);
  });

  it("a gitleaks hit on an added line blocks with no model involved; tools installed only as needed and removed", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    h.routes({ head: newHead, base: newBase });
    const t = fakeTools(leakAt(5));
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);

    // Only gitleaks understands src/app.ts.
    expect(t.state.installed).toEqual([["gitleaks"]]);
    expect(t.state.removed).toEqual(t.state.roots);
    expect(existsSync(t.state.roots[0] ?? "/")).toBe(false);

    const prompt = h.calls.find((c) => c.task === "review")?.prompt ?? "";
    const open = prompt.lastIndexOf("<static-analysis>");
    expect(open).toBeGreaterThan(prompt.indexOf("<untrusted-0123456789abcdef>"));
    expect(prompt.slice(open, prompt.lastIndexOf("</static-analysis>"))).toContain("src/app.ts");

    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("Possible secret committed (`generic-api-key`) at `src/app.ts:5`");
    expect(h.runDocument()?.tools).toMatchObject({ runs: expect.arrayContaining([{ tool: "gitleaks", status: "ok", files: 1 }]) as unknown });
  });

  it("a committed secret keeps blocking after an incremental push that does not touch it", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    // Push 1 (newHead: the a5 change, which the fake gitleaks flags) was reviewed in full.
    const cfg = await loadReviewConfig(createGitReader(h.repo.dir), newBase);
    const marker = buildStateMarker({ v: 1, head: newHead, base: newBase, mode: "full", config: cfg.hash, prompt: promptVersion(loadTemplates()) });
    // Push 2 only touches the README.
    const head2 = h.repo.commit("docs", { "README.md": "# widgets\n\nMore docs.\n" });
    h.routes({ head: head2, base: newBase }, { reviews: [review(1, newHead, marker)] });
    // gitleaks reports the leak only when src/app.ts was actually staged for it.
    const t = fakeTools((stage) => (existsSync(join(stage, "src/app.ts")) ? leakAt(5)(stage) : "[]"));
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);

    expect(h.calls.find((c) => c.task === "review")?.prompt).toContain("Mode: incremental");
    const r = postedReview();
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.body).toContain("Possible secret committed (`generic-api-key`) at `src/app.ts:5`");
  });

  it("a leak on a context line is not a blocker", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    h.routes({ head: newHead, base: newBase });
    const t = fakeTools(leakAt(3));
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);
    expect(postedReview().event).toBe("APPROVE");
  });

  it("the secret scan fails closed when the tools cannot be installed", async () => {
    const { newBase, newHead } = withBase({ ".myrabbit.yaml": TOOLS_ON });
    h.routes({ head: newHead, base: newBase });
    const t = fakeTools(() => "[]");
    t.deps.install = () => Promise.resolve(null);
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);
    expect(postedReview().event).toBe("REQUEST_CHANGES");
    expect(postedReview().body).toContain("Secret scan did not run (not installed)");
  });

  it("is off by default: nothing installed, no <static-analysis>, no tools field", async () => {
    h.routes({ head, base });
    const t = fakeTools(leakAt(5));
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { tools: t.deps }))).toBe(0);
    expect(t.state.installed).toEqual([]);
    expect(h.calls.find((c) => c.task === "review")?.prompt).not.toContain("<static-analysis>");
    expect(h.runDocument()).not.toHaveProperty("tools");
    expect(postedReview().event).toBe("APPROVE");
  });
});

describe("engine credentials, engines and isolation (PUB1)", () => {
  /** setupEngines that records what it was given, then behaves like the harness's fake. */
  function recordingSetup(): { setup: SetupEngines; seen: EngineSetupInput[] } {
    const seen: EngineSetupInput[] = [];
    const inner = fakeSetup({ claude: {}, codex: {} }, h.calls, h.counter);
    return {
      seen,
      setup: (input) => {
        seen.push(input);
        return inner(input);
      },
    };
  }
  const refusedBeforeModel = async (message: string): Promise<void> => {
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }))).toBe(1);
    expect(h.counter.setups).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
    expect(h.summary()).toContain(message);
  };

  it("a caller with no new input runs as today: both engines, guest users, the subscription credentials", async () => {
    h.routes({ head, base });
    const r = recordingSetup();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { setupEngines: r.setup }))).toBe(0);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]?.isolation).toBe("guest-users");
    expect(r.seen[0]?.config.engines.claude.enabled).toBe(true);
    expect(r.seen[0]?.config.engines.codex.enabled).toBe(true);
    expect(r.seen[0]?.secrets.claudeAuth).toBe("oauth");
    expect(r.seen[0]?.secrets.codexAuth).toBe("auth_json");
    expect(h.logs.some((l) => l.startsWith("::warning::"))).toBe(false);
  });

  it("both Claude credentials set: a loud error before any model call", async () => {
    h.routes({ head, base });
    h.env.ANTHROPIC_API_KEY = "fake-anthropic-api-value-0003";
    await refusedBeforeModel("both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; pass exactly one");
    expect(outbound()).not.toContain("fake-anthropic-api-value-0003");
  });

  it("both Codex credentials set: a loud error before any model call", async () => {
    h.routes({ head, base });
    h.env.OPENAI_API_KEY = "fake-openai-api-value-0004";
    await refusedBeforeModel("both OPENAI_API_KEY and CODEX_AUTH_JSON are set; pass exactly one");
  });

  it("API keys instead of the subscription credentials", async () => {
    h.routes({ head, base });
    delete h.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete h.env.CODEX_AUTH_JSON;
    h.env.ANTHROPIC_API_KEY = "fake-anthropic-api-value-0003";
    h.env.OPENAI_API_KEY = "fake-openai-api-value-0004";
    const r = recordingSetup();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { setupEngines: r.setup }))).toBe(0);
    expect(r.seen[0]?.secrets.claudeAuth).toBe("api_key");
    expect(r.seen[0]?.secrets.codexAuth).toBe("api_key");
  });

  it("engines claude: codex is disabled for the run and needs no credential", async () => {
    h.routes({ head, base });
    h.env.MYRABBIT_ENGINES = "claude";
    delete h.env.CODEX_AUTH_JSON;
    const r = recordingSetup();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { setupEngines: r.setup }))).toBe(0);
    expect(r.seen[0]?.config.engines.claude.enabled).toBe(true);
    expect(r.seen[0]?.config.engines.codex.enabled).toBe(false);
  });

  it("a selected engine with no credential fails before any model call", async () => {
    h.routes({ head, base });
    h.env.MYRABBIT_ENGINES = "codex";
    delete h.env.CODEX_AUTH_JSON;
    await refusedBeforeModel("missing secret CODEX_AUTH_JSON or OPENAI_API_KEY");
  });

  it("engines codex with a repository config that disables codex: nothing to run, an error", async () => {
    h.repo.git("checkout", "-q", "main");
    const newBase = h.repo.commit("config", { ".myrabbit.yaml": "version: 1\nengines:\n  codex:\n    enabled: false\n" });
    h.repo.git("checkout", "-q", "feature");
    h.repo.git("merge", "-q", "--no-edit", "main");
    h.routes({ head: h.repo.git("rev-parse", "HEAD"), base: newBase });
    h.env.MYRABBIT_ENGINES = "codex";
    await refusedBeforeModel("no engine to run");
  });

  it("isolation none with one engine reaches engine setup", async () => {
    h.routes({ head, base });
    h.env.MYRABBIT_ISOLATION = "none";
    h.env.MYRABBIT_ENGINES = "claude";
    delete h.env.CODEX_AUTH_JSON;
    const r = recordingSetup();
    expect(await runPipeline(h.deps({ claude: {}, codex: {} }, { setupEngines: r.setup }))).toBe(0);
    expect(r.seen[0]?.isolation).toBe("none");
    expect(r.seen[0]?.config.engines.codex.enabled).toBe(false);
  });

  it("isolation none with both engines (the default) is an error before any model call, saying why", async () => {
    h.routes({ head, base });
    h.env.MYRABBIT_ISOLATION = "none";
    await refusedBeforeModel("could read each other's credentials");
  });

  it.each(["off", "None", "guest"])("an unknown isolation %j is an error before any model call", async (value) => {
    h.routes({ head, base });
    h.env.MYRABBIT_ISOLATION = value;
    await refusedBeforeModel("invalid MYRABBIT_ISOLATION");
  });

  it.each(["", "  , "])("an empty trusted-authors %j (a missing action input) is an error before any model call, never a default login", async (value) => {
    h.routes({ head, base });
    h.env.MYRABBIT_TRUSTED_AUTHORS = value;
    await refusedBeforeModel("MYRABBIT_TRUSTED_AUTHORS is required");
  });

  it("an unknown engines value is an error before any model call", async () => {
    h.routes({ head, base });
    h.env.MYRABBIT_ENGINES = "all";
    await refusedBeforeModel("invalid MYRABBIT_ENGINES");
  });
});

describe("exitAfterFlush (main's exit path)", () => {
  let savedExitCode: typeof process.exitCode;
  beforeEach(() => {
    savedExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("sets process.exitCode before waiting on the streams", async () => {
    const exits: number[] = [];
    let seen: typeof process.exitCode;
    const probe = { write: (_c: string, cb: () => void) => ((seen = process.exitCode), cb(), true) };
    await exitAfterFlush(1, [probe], (code) => exits.push(code));
    expect(seen).toBe(1);
    expect(exits).toEqual([1]);
  });

  /** A stream whose write callback fires when `drain()` is called. */
  function stream(events: string[], name: string) {
    let pending: (() => void) | null = null;
    return {
      write(_chunk: string, cb: () => void) {
        events.push(`${name}:write`);
        pending = () => {
          events.push(`${name}:flushed`);
          cb();
        };
        return false;
      },
      drain() {
        pending?.();
      },
    };
  }

  it("exits with the pipeline's code only after both streams flushed", async () => {
    const events: string[] = [];
    const out = stream(events, "stdout");
    const err = stream(events, "stderr");
    const done = exitAfterFlush(1, [out, err], (code) => events.push(`exit:${code}`));
    await Promise.resolve();
    expect(events).toEqual(["stdout:write", "stderr:write"]);
    out.drain();
    err.drain();
    await done;
    expect(events).toEqual(["stdout:write", "stderr:write", "stdout:flushed", "stderr:flushed", "exit:1"]);
  });

  it("does not wait for abandoned work: exits while a long ref'd timer is still pending", async () => {
    // Stands in for a related lookup the time budget gave up on (a rate-limit sleep, say).
    const abandoned = setTimeout(() => undefined, 60_000);
    const exits: number[] = [];
    const now = { write: (_c: string, cb: () => void) => (cb(), true) };
    const started = Date.now();
    await exitAfterFlush(0, [now, now], (code) => exits.push(code));
    expect(exits).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(1_000);
    clearTimeout(abandoned);
  });

  it("exits anyway when a stream never calls back (closed pipe)", async () => {
    const exits: number[] = [];
    const stuck = { write: () => false };
    await exitAfterFlush(0, [stuck], (code) => exits.push(code), 20);
    expect(exits).toEqual([0]);
  });
});

describe("actionRoot", () => {
  it("is the parent of dist/ or src/", () => {
    expect(actionRoot("file:///opt/action/dist/main.js")).toBe("/opt/action");
    expect(actionRoot("file:///opt/action/src/main.ts")).toBe("/opt/action");
  });
});

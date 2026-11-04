// Review body (design §8.6) with the 60,000-char cap of §8.5.
//
//   **myrabbit: REQUEST_CHANGES** — 2 blocking (1 critical, 1 major) · 3 non-blocking · reviewed by claude+codex
//   <notes>
//   <2–4 sentence summary>
//   <details>Changes (N files)</details>
//   ### Blocking                       (new blocking findings + prior open blocking threads)
//   ### Unverified (budget)            (blocking single-model findings the verifier never confirmed)
//   <details>Blocking findings not posted inline</details>
//   ### Dismissed by human             (Q9 audit)
//   ### Superseded                     (old non-blocking threads replaced by a new blocker)
//   <details>Non-blocking</details>
//   <details>Review info</details>
//
// design-v2 items, each only when its input is present (so v1 bodies are unchanged):
//   **Merge risk:** … · **Review effort:** …      (after the header line, §4.1, §4.2)
//   **Suggested labels / reviewers**, Related issues and PRs   (after Changes, §4.5–§4.7)
//   ### Pre-merge checks table                    (before Blocking, §5.3)
//   <details>Static analysis</details>            (after Non-blocking, §7.4.4, §7.5)
//   <details>Proposed learnings</details>         (§6.2)
//   <details>🤖 Prompt for all review comments</details>   (§4.3; dropped first when over the cap)
//   Review info gains "Additional context" (§3.2)
//   <!-- myrabbit:state … -->
//
// When the body is over the cap, list items are dropped from the end of the <details> sections
// first (non-blocking, then changes, then blocking details, then review info), each with an
// "… N more omitted" line; the blocking list, the audit list and the state marker go last.

import type { MergedFinding } from "../types.js";
import { MarkerError, buildStateMarker } from "./markers.js";
import { Sanitizer, truncateBlock, truncateInline } from "./sanitize.js";
import { findingNeedsRedaction, MAX_TITLE_CHARS, severityLabel } from "./comment.js";
import {
  blobUrl,
  findingTags,
  formatCost,
  formatDuration,
  locationText,
  reviewedBy,
  severityBreakdown,
  shortSha,
  unavailableBanner,
} from "./format.js";
import { compareFindings, type Placement } from "./plan.js";
import type { RenderFinding, ReviewRenderInput, ThreadRef } from "./types.js";
import { riskBlocks } from "../merge/risk.js";
import { COVERAGE_TITLE } from "../merge/coverage.js";
import {
  agentPromptBlock,
  agentPromptEntry,
  agentPromptThread,
  checkRows,
  contextLine,
  LEARNINGS_FILE,
  labelsLine,
  learningItems,
  relatedItems,
  reviewersLine,
  ruleLine,
  staticAnalysisItems,
  walkthroughLine,
} from "./walkthrough.js";

/** §8.5. */
export const MAX_BODY_CHARS = 60000;
const MAX_SUMMARY_CHARS = 2000;
const MAX_ITEM_BODY_CHARS = 2000;
const MAX_FILES_PER_CHANGE = 10;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'`]+$/;

export class RenderError extends Error {
  override readonly name = "RenderError";
}

interface ListSection {
  before: string;
  after: string;
  items: string[];
  join: string;
  /** Lower is dropped first; null never drops. */
  dropOrder: number | null;
  omitted: number;
  omitNote: (n: number) => string;
  /** Render even with no items (e.g. a fixed paragraph). */
  always?: boolean;
}

function fixed(text: string): ListSection {
  return { before: text, after: "", items: [], join: "", dropOrder: null, omitted: 0, omitNote: () => "", always: true };
}

function renderSection(sec: ListSection): string {
  if (sec.items.length === 0 && sec.omitted === 0 && sec.always !== true) return "";
  const items = [...sec.items];
  if (sec.omitted > 0) items.push(sec.omitNote(sec.omitted));
  return `${sec.before}${items.join(sec.join)}${sec.after}`;
}

function assemble(sections: ListSection[], marker: string): string {
  const parts = sections.map(renderSection).filter((p) => p !== "");
  return [...parts, marker].join("\n\n");
}

/** Indents every line of block text by two spaces (list-item continuation). */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? "" : `  ${l}`))
    .join("\n");
}

function details(summary: string, body: Omit<ListSection, "before" | "after">): ListSection {
  return { ...body, before: `<details><summary>${summary}</summary>\n\n`, after: "\n\n</details>" };
}

/**
 * A design-v2 synthetic blocker (secret hit, secret scan not run, failed check): synthetic, but
 * not the v1 §7.5 coverage finding ("Review incomplete: …"), whose rendering stays as in v1.
 * Synthetic findings are built only by src/merge, never from model output.
 */
function isV2Synthetic(f: RenderFinding): boolean {
  return f.synthetic && !f.summary.startsWith(`${COVERAGE_TITLE}:`);
}

const omitted = (what: string) => (n: number) => `- … ${n} more ${what} omitted (body size limit)`;

export class BodyRenderer {
  readonly #s: Sanitizer;
  readonly #in: ReviewRenderInput;

  constructor(input: ReviewRenderInput, sanitizer: Sanitizer) {
    if (!REPO_RE.test(input.repo)) throw new RenderError("invalid repo");
    this.#in = input;
    this.#s = sanitizer;
  }

  /** `[`path:line`](link)` for a finding, or "" for synthetic findings without a location. */
  #location(f: Pick<MergedFinding, "path" | "line" | "end_line" | "side" | "synthetic">): string {
    if (f.synthetic || f.path === "") return "";
    const text = this.#s.codeSpan(locationText(f));
    // The old line does not exist at head; a path that needed redaction cannot go in a URL.
    if (f.side === "LEFT" || this.#s.needsRedaction(f.path)) return text;
    return `[${text}](${blobUrl(this.#in.repo, this.#in.state.head, f.path, f.line, f.end_line)})`;
  }

  #title(text: string): string {
    return truncateInline(this.#s.inline(text), MAX_TITLE_CHARS);
  }

  /** One-line entry: `- **[sev · cat]** title — loc · tags`. */
  #bullet(f: RenderFinding, extraTags: string[] = []): string {
    const loc = this.#location(f);
    let tags = [...findingTags(f, findingNeedsRedaction(f, this.#s)), ...extraTags];
    // A v2 synthetic item has no code location, so "outside diff" would be noise.
    if (isV2Synthetic(f)) tags = tags.filter((t) => t !== "outside diff");
    return [`- **${severityLabel(f)}** ${this.#title(f.summary)}`, loc === "" ? "" : ` — ${loc}`, tags.length > 0 ? ` · ${tags.join(" · ")}` : ""].join("");
  }

  /** Bullet plus indented body and failure scenario, for findings that are not posted inline. */
  #fullItem(f: RenderFinding): string {
    const parts = [this.#bullet(f)];
    const v2Synthetic = isV2Synthetic(f);
    const body = truncateBlock(this.#s.block(f.body), MAX_ITEM_BODY_CHARS);
    if (body.trim() !== "" && !(v2Synthetic && f.body.trim() === f.summary.trim())) parts.push(indent(body));
    if (f.failure_scenario && f.failure_scenario.trim() !== "") {
      parts.push(indent(`**Fails when:** ${truncateInline(this.#s.inline(f.failure_scenario), 600)}`));
    }
    const rule = ruleLine(f.rule, this.#s, 300);
    if (rule !== null) parts.push(indent(rule));
    parts.push(
      indent(
        v2Synthetic
          ? "<sub>added by myrabbit · no model vote · blocks until fixed or resolved by a person</sub>"
          : `<sub>found by ${f.sources.length > 0 ? f.sources.join("+") : "myrabbit"} · confidence ${f.confidence.toFixed(2)}</sub>`,
      ),
    );
    return parts.join("\n\n");
  }

  #threadBullet(t: ThreadRef, tags: string[]): string {
    const locText = this.#s.codeSpan(t.line === null ? t.path : `${t.path}:${t.line}`);
    let url: string | null =
      t.url && GITHUB_URL_RE.test(t.url) ? t.url : blobUrl(this.#in.repo, this.#in.state.head, t.path, t.line);
    if (this.#s.needsRedaction(url)) url = null;
    const tagText = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
    const loc = url === null ? locText : `[${locText}](${url})`;
    return `- **[${t.severity} · ${t.category}]** ${this.#title(t.title)} — ${loc}${tagText}`;
  }

  render(placement: Placement): { body: string; truncated: boolean } {
    const input = this.#in;
    const s = this.#s;
    let marker: string;
    try {
      marker = buildStateMarker(input.state);
    } catch (e) {
      throw new RenderError(e instanceof MarkerError ? e.message : "invalid state");
    }

    const newBlocking = [...placement.inline.filter((f) => f.blocking), ...placement.bodyBlocking].sort(compareFindings);
    const newNonBlocking = [...placement.inline.filter((f) => !f.blocking), ...placement.bodyNonBlocking];
    const countOnly = Object.values(placement.countOnly).reduce((a, b) => a + b, 0);
    const blockingSeverities = [...newBlocking.map((f) => f.severity), ...input.priorBlocking.map((t) => t.severity)];
    const blockingCount = blockingSeverities.length;
    const expected = blockingCount > 0 ? "REQUEST_CHANGES" : "APPROVE";
    if (input.verdict !== expected) {
      // The verdict is computed in src/merge/verdict.ts; a mismatch is a bug. Fail closed.
      throw new RenderError(`verdict ${input.verdict} does not match ${blockingCount} blocking item(s)`);
    }
    const wt = input.walkthrough ?? {};
    if (wt.risk !== undefined && riskBlocks(wt.risk) !== (input.verdict === "REQUEST_CHANGES")) {
      // design-v2 §4.2: risk ≥ moderate ⇔ REQUEST_CHANGES by construction; a mismatch is a bug.
      throw new RenderError(`merge risk ${wt.risk} contradicts verdict ${input.verdict}`);
    }

    const breakdown = blockingCount > 0 ? ` (${severityBreakdown(blockingSeverities)})` : "";
    const allFiltered = this.#allFiltered();
    const header = allFiltered
      ? `**myrabbit: ${input.verdict}** — no reviewable changes; ${input.files.filtered.length} files filtered` +
        (blockingCount > 0 ? ` · ${blockingCount} blocking${breakdown}` : "")
      : `**myrabbit: ${input.verdict}** — ${blockingCount} blocking${breakdown} · ` +
        `${newNonBlocking.length + countOnly} non-blocking · reviewed by ${reviewedBy(input.engines)}`;

    // An engine whose account was unusable is stated first, above the verdict line.
    const banner = unavailableBanner(input.engines);
    const sections: ListSection[] = [...(banner === null ? [] : banner.split("\n").map((l) => fixed(`**${l}**`))), fixed(header)];
    const riskLine = walkthroughLine(wt.risk, wt.effort, input.state.head);
    if (riskLine !== "") sections.push(fixed(riskLine));
    if (allFiltered) {
      sections.push({
        before: "### Not reviewed\n\n",
        after: "",
        items: this.#notReviewedItems(),
        join: "\n",
        dropOrder: 5,
        omitted: 0,
        omitNote: omitted("files"),
      });
    }

    if (input.notes.length > 0) sections.push(fixed(input.notes.map((n) => `> ${s.inline(n)}`).join("\n>\n")));

    const summary = truncateBlock(s.block(input.summary.trim()), MAX_SUMMARY_CHARS);
    if (summary !== "") sections.push(fixed(summary));

    // Changes table.
    if (input.changes.length > 0) {
      const rows = input.changes.map((c) => {
        const files = c.files.slice(0, MAX_FILES_PER_CHANGE).map((p) => s.codeSpan(p).replace(/\|/g, "\\|"));
        if (c.files.length > MAX_FILES_PER_CHANGE) files.push(`+${c.files.length - MAX_FILES_PER_CHANGE} more`);
        return `| ${s.cell(c.area)} | ${files.join("<br>")} | ${s.cell(c.summary)} |`;
      });
      const sec = details(`Changes (${input.files.reviewed.length} files)`, {
        items: rows,
        join: "\n",
        dropOrder: 2,
        omitted: 0,
        omitNote: (n) => `| … | ${n} more rows omitted (body size limit) | |`,
      });
      sec.before += "| Area | Files | Summary |\n|---|---|---|\n";
      sections.push(sec);
    }

    // design-v2 walkthrough extras (§4.5–§4.7). Suggestions only: nothing is applied, requested,
    // linked or notified.
    const suggested = [labelsLine(wt.labels, s), reviewersLine(wt.reviewers, s)].filter((l): l is string => l !== null);
    if (suggested.length > 0) sections.push(fixed(suggested.join("<br>\n")));
    if (wt.relatedUnavailable === true) {
      sections.push(fixed("**Related issues and PRs:** unavailable"));
    } else {
      const related = relatedItems(wt.related, s);
      if (related.length > 0) {
        sections.push({ before: "**Related issues and PRs:**\n\n", after: "", items: related, join: "\n", dropOrder: 2, omitted: 0, omitNote: omitted("related items") });
      }
    }

    // §5.3 pre-merge checks. A failed error-mode check is also in the blocking list below.
    const checks = checkRows(wt.checks, s);
    if (checks.length > 0) {
      sections.push({
        before: "### Pre-merge checks\n\n| Check | Mode | Result | Explanation |\n|---|---|---|---|\n",
        after: "",
        items: checks,
        join: "\n",
        dropOrder: null,
        omitted: 0,
        omitNote: () => "",
      });
    }

    // Blocking list: every reason for REQUEST_CHANGES, most severe first.
    if (blockingCount > 0) {
      const items = [
        ...newBlocking.map((f) => this.#bullet(f, placement.inline.includes(f) ? [] : ["details below"])),
        ...input.priorBlocking.map((t) => this.#threadBullet(t, ["still open from an earlier review"])),
      ];
      sections.push({ before: "### Blocking\n\n", after: "", items, join: "\n", dropOrder: 6, omitted: 0, omitNote: omitted("blocking items") });
    }

    const unverified = newBlocking.filter((f) => f.verification === "unverified_budget" || f.verification === "unverified_error");
    if (unverified.length > 0) {
      sections.push({
        before:
          "### Unverified (budget)\n\n" +
          "Reported by one engine only; the second check could not run (verification budget exhausted or the verifier failed). " +
          "They block until fixed or resolved by a person, so a budget limit never turns into an approval.\n\n",
        after: "",
        items: unverified.map((f) => this.#bullet(f)),
        join: "\n",
        dropOrder: 5,
        omitted: 0,
        omitNote: omitted("unverified findings"),
      });
    }

    if (placement.bodyBlocking.length > 0) {
      sections.push(
        details(`Blocking findings not posted inline (${placement.bodyBlocking.length})`, {
          items: placement.bodyBlocking.map((f) => this.#fullItem(f)),
          join: "\n\n",
          dropOrder: 3,
          omitted: 0,
          omitNote: omitted("findings"),
        }),
      );
    }

    if (input.dismissed.length > 0) {
      sections.push({
        before: "### Dismissed by human\n\nBlocking threads resolved by a person. They no longer block this PR; listed for audit.\n\n",
        after: "",
        items: input.dismissed.map((t) =>
          this.#threadBullet(t, t.resolvedBy ? [`resolved by ${s.inline(`@${t.resolvedBy}`)}`] : ["resolved by a person"]),
        ),
        join: "\n",
        dropOrder: 5,
        omitted: 0,
        omitNote: omitted("dismissed threads"),
      });
    }

    // Prior non-blocking threads replaced by a new blocking finding. The new inline comment has
    // no URL until the review is posted, so the link points at the new finding's code location.
    if (input.superseded.length > 0) {
      sections.push({
        before: "### Superseded\n\n",
        after: "",
        items: input.superseded.map((t) => {
          const next = input.findings.find((f) => f.fingerprint === t.supersededBy);
          const by = next
            ? `superseded by **${severityLabel(next)}** ${this.#title(next.summary)}${this.#location(next) === "" ? "" : ` — ${this.#location(next)}`}`
            : `superseded by a new finding (${s.codeSpan(t.supersededBy)})`;
          return this.#threadBullet(t, [by]);
        }),
        join: "\n",
        dropOrder: 4,
        omitted: 0,
        omitNote: omitted("superseded threads"),
      });
    }

    // Non-blocking: body-only findings in full, plus profile counts.
    const nbItems = placement.bodyNonBlocking.map((f) => this.#fullItem(f));
    if (countOnly > 0) {
      const counts = severityBreakdown(
        Object.entries(placement.countOnly).flatMap(([sev, n]) => Array<MergedFinding["severity"]>(n).fill(sev as MergedFinding["severity"])),
      );
      nbItems.push(`- ${counts} hidden by profile \`${input.config.profile}\``);
    }
    if (nbItems.length > 0) {
      const label = `Non-blocking findings not posted inline (${placement.bodyNonBlocking.length + countOnly})`;
      sections.push(details(label, { items: nbItems, join: "\n\n", dropOrder: 1, omitted: 0, omitNote: omitted("findings") }));
    }

    // §7.4.4 hits no engine confirmed (never blocking) and §7.5 tool failure notes.
    const sa = staticAnalysisItems(wt.tools, s);
    if (sa.notes.length > 0 || sa.hits.length > 0) {
      const sec = details(sa.hits.length > 0 ? `Static analysis (${sa.hits.length} not confirmed)` : "Static analysis", {
        items: sa.hits,
        join: "\n",
        dropOrder: 1,
        omitted: 0,
        omitNote: omitted("hits"),
        always: true,
      });
      const intro = sa.hits.length > 0 ? "Tool hits on changed lines that no engine confirmed. They never block.\n\n" : "";
      sec.before += `${sa.notes.length > 0 ? `${sa.notes.join("\n")}${sa.hits.length > 0 ? "\n\n" : ""}` : ""}${intro}`;
      sections.push(sec);
    }

    // §6.2 proposals: a snippet for a person to commit; myrabbit never writes the file.
    const learnings = learningItems(wt.proposedLearnings, s);
    if (learnings.length > 0) {
      const sec = details(`Proposed learnings (${learnings.length})`, { items: learnings, join: "\n\n", dropOrder: 1, omitted: 0, omitNote: omitted("proposals") });
      sec.before +=
        `From threads a person resolved after a trusted reviewer disagreed. To adopt one, append it to \`${LEARNINGS_FILE}\` ` +
        "in a normal PR; myrabbit never writes it.\n\n";
      sections.push(sec);
    }

    // §4.3 aggregated prompt for every open finding (new findings shown in this review, then
    // prior open blocking threads). Dropped first when the body is over the cap.
    if (wt.aiAgentPrompts === true) {
      const open = [...newBlocking, ...newNonBlocking].filter((f) => !f.synthetic);
      const entries = [...open.map((f) => agentPromptEntry(f, s)), ...input.priorBlocking.map((t) => agentPromptThread(t, s))];
      if (entries.length > 0) {
        sections.push(
          details("🤖 Prompt for all review comments with AI agents", {
            items: [agentPromptBlock(entries)],
            join: "",
            dropOrder: 0,
            omitted: 0,
            omitNote: () => "_Omitted (body size limit); see the prompt in each inline comment._",
          }),
        );
      }
    }

    // Review info last, so its redaction count covers everything above.
    const info = details("Review info", { items: [], join: "\n", dropOrder: 4, omitted: 0, omitNote: omitted("lines") });
    sections.push(info);
    info.items = this.#infoItems(placement);

    let truncated = false;
    let body = assemble(sections, marker);
    while (body.length > MAX_BODY_CHARS) {
      const victim = sections
        .filter((sec) => sec.dropOrder !== null && sec.items.length > 0)
        .sort((a, b) => (a.dropOrder ?? 0) - (b.dropOrder ?? 0))[0];
      truncated = true;
      if (!victim) {
        const head = assemble(sections, "").trimEnd();
        body = `${truncateBlock(head, MAX_BODY_CHARS - marker.length - 2)}\n\n${marker}`;
        break;
      }
      victim.items.pop();
      victim.omitted++;
      body = assemble(sections, marker);
    }
    return { body, truncated };
  }

  /** Every changed file is filtered: nothing was reviewed, nothing binary or over a limit. */
  #allFiltered(): boolean {
    const f = this.#in.files;
    return f.filtered.length > 0 && f.reviewed.length === 0 && f.binary.length === 0 && f.notReviewed.length === 0;
  }

  /** One line per changed file that was not reviewed, with the reason. */
  #notReviewedItems(): string[] {
    const s = this.#s;
    const f = this.#in.files;
    return [
      ...f.filtered.map(
        (x) =>
          `- ${s.codeSpan(x.path)} — ` +
          (x.reason === "excluded" && x.pattern !== null
            ? `filtered by ${s.codeSpan(x.pattern)}`
            : "not in path_filters allowlist"),
      ),
      ...f.binary.map((p) => `- ${s.codeSpan(p)} — binary`),
      ...f.notReviewed.map((p) => `- ${s.codeSpan(p)} — over limit`),
    ];
  }

  #infoItems(placement: Placement): string[] {
    const input = this.#in;
    const s = this.#s;
    const items: string[] = [];
    const range = `${shortSha(input.rangeFrom)}..${shortSha(input.state.head)}`;
    items.push(`- **Mode:** ${input.state.mode} · range \`${range}\``);
    items.push(`- **Profile:** ${input.config.profile} · **threshold:** ${input.config.request_changes_threshold}`);
    for (const e of input.engines) {
      const model = e.model ? ` (${s.inline(e.model)})` : "";
      const status =
        e.status === "ok"
          ? `ok in ${formatDuration(e.durationMs)}, ${formatCost(e.costUsd)}`
          : e.status === "disabled"
            ? "disabled"
            : e.status === "not_run"
              ? "not run (no reviewable text changes)"
              : `failed (${s.inline(e.error ?? "error")}) after ${formatDuration(e.durationMs)}`;
      items.push(`- **Engine** \`${e.engine}\`${model}: ${status}`);
    }
    const f = input.files;
    items.push(
      `- **Files:** ${f.reviewed.length} reviewed · ${f.filtered.length} filtered · ${f.binary.length} binary · ` +
        `${f.notReviewed.length} over limit`,
    );
    // Every changed file that was not reviewed, with its reason (myrabbit is the merge gate).
    // When everything was filtered the list is shown outside <details> instead.
    if (!this.#allFiltered()) {
      const notReviewed = this.#notReviewedItems();
      if (notReviewed.length > 0) items.push(`- **Not reviewed (${notReviewed.length}):**`, ...notReviewed.map((l) => `  ${l}`));
    }
    const ctx = contextLine(input.walkthrough?.context);
    if (ctx !== null) items.push(ctx);
    items.push(`- **Inline comments:** ${placement.inline.length} (max ${input.config.limits.max_inline_comments})`);
    items.push(`- **Findings dropped by validation:** ${input.droppedByValidation}`);
    items.push(`- **Threads addressed in this run:** ${input.addressed}`);
    if (input.runUrl && GITHUB_URL_RE.test(input.runUrl)) items.push(`- **Run:** ${input.runUrl}`);
    items.push(
      `- **Versions:** config \`${input.state.config}\` · prompt \`${input.state.prompt}\` · merge ${s.codeSpan(input.mergeVersion)}`,
    );
    if (input.configWarnings.length > 0) {
      items.push(`- **Config warnings** (defaults used):`);
      for (const w of input.configWarnings) items.push(`  - ${s.inline(w)}`);
    }
    if (s.redactions > 0) items.push(`- **Redacted strings:** ${s.redactions} (credential-shaped text was replaced with \`***\`)`);
    return items;
  }
}

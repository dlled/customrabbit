// Job summary markdown ($GITHUB_STEP_SUMMARY, design §2 step 12, §5.2, §9.3): outcome, engine
// durations and cost, finding counts, redaction count, and the run document.

import { Sanitizer, fenceFor, truncateInline } from "./sanitize.js";
import { formatCost, formatDuration, shortSha, unavailableBanner } from "./format.js";
import type { JobSummaryInput } from "./types.js";

/** GitHub allows 1 MiB per step summary; stay well under it. */
export const MAX_JOB_SUMMARY_CHARS = 900_000;

function outcomeLine(input: JobSummaryInput, s: Sanitizer): string {
  const o = input.outcome;
  switch (o.kind) {
    case "posted":
      return `**Posted review: ${o.verdict}**`;
    case "skipped":
      return `**Skipped:** ${s.inline(o.reason)} (no review posted)`;
    case "head_moved":
      return `**Head moved** from \`${shortSha(s.inline(o.reviewed))}\` to \`${shortSha(s.inline(o.current))}\` before posting; the newer run reviews it.`;
    case "failed":
      return `**Failed:** ${s.inline(o.reason)} (no review posted; the check fails so the PR cannot merge on this run)`;
  }
}

export function renderJobSummary(input: JobSummaryInput): string {
  const s = new Sanitizer();
  const lines: string[] = [];
  const verdict = input.outcome.kind === "posted" ? ` · ${input.outcome.verdict}` : "";
  lines.push(`## myrabbit · ${s.inline(input.repo)}#${input.pr}${verdict}`, "");
  lines.push(outcomeLine(input, s), "");
  const banner = unavailableBanner(input.engines);
  if (banner !== null) lines.push(`> [!WARNING]\n${banner.split("\n").map((l) => `> ${l}`).join("\n>\n")}`, "");
  if (input.mode) lines.push(`Mode: \`${input.mode}\``, "");

  if (input.engines.length > 0) {
    lines.push("| Engine | Model | Status | Duration | Cost |", "|---|---|---|---|---|");
    let total = 0;
    let anyCost = false;
    for (const e of input.engines) {
      const status = e.status === "failed" ? `failed: ${s.cell(e.error ?? "error")}` : e.status === "not_run" ? "not run" : e.status;
      if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) {
        total += e.costUsd;
        anyCost = true;
      }
      lines.push(
        `| ${e.engine} | ${e.model ? s.cell(e.model) : "default"} | ${status} | ${formatDuration(e.durationMs)} | ${formatCost(e.costUsd)} |`,
      );
    }
    lines.push("");
    const totals = [`Total cost: ${anyCost ? formatCost(total) : "n/a"}`];
    if (input.totalDurationMs !== null && input.totalDurationMs !== undefined) {
      totals.push(`run time: ${formatDuration(input.totalDurationMs)}`);
    }
    lines.push(totals.join(" · "), "");
  }

  if (input.counts) {
    const c = input.counts;
    lines.push(
      "| Blocking | Non-blocking | Inline | Body only | Dismissed by human | Addressed |",
      "|---|---|---|---|---|---|",
      `| ${c.blocking} | ${c.nonBlocking} | ${c.inline} | ${c.bodyOnly} | ${c.dismissed} | ${c.addressed} |`,
      "",
    );
  }

  // lines ends with "", so this ends with one blank line before what follows.
  const head = `${lines.join("\n")}\n`;
  let doc = "";
  if (input.runDocument) {
    const json = s.code(JSON.stringify(input.runDocument, null, 2));
    const fence = fenceFor(json);
    doc = `<details><summary>Run document</summary>\n\n${fence}json\n${json}\n${fence}\n\n</details>\n`;
  }

  // Count after the run document is sanitized, so its redactions are included.
  const redactions = input.redactions + s.redactions;
  const warning =
    redactions > 0
      ? `> [!WARNING]\n> ${redactions} string(s) contained credential-shaped text and were redacted. This can be a prompt-injection signal; inspect the PR.\n\n`
      : "";

  let out = `${head}${warning}${doc}`;
  if (out.length > MAX_JOB_SUMMARY_CHARS) {
    out = `${head}${warning}_Run document omitted: ${truncateInline(String(doc.length), 20)} chars is over the job summary limit; see \`$RUNNER_TEMP/myrabbit-run.json\`._\n`;
  }
  return out;
}

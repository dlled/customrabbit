// Inline review comments (design §8.6) and suggestion blocks (§6.1 rule 7, §7.2 step 3).
//
//   **[major · correctness]** <title>
//
//   <body>
//
//   **Fails when:** <failure_scenario>
//
//   ```suggestion
//   <replacement>
//   ```
//
//   <sub>found by claude+codex · confidence 0.82</sub>
//   <!-- myrabbit:f v=1 fp=… sev=major blk=1 -->

import { buildFindingMarker } from "./markers.js";
import { fenceFor, Sanitizer, truncateBlock, truncateInline } from "./sanitize.js";
import { findingTags } from "./format.js";
import type { CommentOptions, RenderFinding, ReviewComment } from "./types.js";
import { agentPromptDetails, ruleLine } from "./walkthrough.js";

/** GitHub renders longer comments, but §8.5 caps each at 4,000 chars. */
export const MAX_COMMENT_CHARS = 4000;
/** §6.1 rule 7. */
export const MAX_SUGGESTION_LINES = 15;
export const MAX_TITLE_CHARS = 200;
const MAX_FAILS_CHARS = 600;
const MAX_RULE_CHARS = 300;

/** True when any untrusted text of the finding contains something redact() would replace. */
export function findingNeedsRedaction(f: RenderFinding, s: Sanitizer): boolean {
  return [f.path, f.summary, f.body, f.failure_scenario, f.rule, f.suggestion].some(
    (t) => typeof t === "string" && s.needsRedaction(t),
  );
}

/**
 * The suggestion text to post, or null when the finding may not carry one. A suggestion is a
 * complete, exact replacement for line..end_line, so it is only offered when:
 *   - it is RIGHT side and anchored in the diff (inline, not outside_diff);
 *   - it is at most 15 lines;
 *   - sanitizing did not change it (a redacted or marker-stripped suggestion is no longer exact).
 * Merge (§7.2 step 3) already dropped suggestions the engines disagree on.
 */
export function suggestionText(f: RenderFinding, s: Sanitizer): string | null {
  if (f.suggestion === null || f.side !== "RIGHT" || f.outside_diff || f.synthetic) return null;
  if (f.end_line !== null && f.end_line < f.line) return null;
  const text = f.suggestion.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (text.split("\n").length > MAX_SUGGESTION_LINES) return null;
  if (s.needsRedaction(text) || s.code(text) !== text) return null;
  return text;
}

/** A ```suggestion block whose fence no line of the replacement can close. */
export function suggestionBlock(text: string): string {
  const fence = fenceFor(text);
  return `${fence}suggestion\n${text}\n${fence}`;
}

export function severityLabel(f: RenderFinding): string {
  return `[${f.severity} · ${f.category}]`;
}

function subLine(f: RenderFinding, redacted: boolean): string {
  const parts = [`found by ${f.sources.length > 0 ? f.sources.join("+") : "myrabbit"}`];
  parts.push(`confidence ${f.confidence.toFixed(2)}`);
  if (f.blocking) parts.push("blocking");
  parts.push(...findingTags(f, redacted));
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** Composes the comment body within MAX_COMMENT_CHARS, cutting the body text first. */
export function renderCommentBody(f: RenderFinding, s: Sanitizer, options: CommentOptions = {}): string {
  const redacted = findingNeedsRedaction(f, s);
  const header = `**${severityLabel(f)}** ${truncateInline(s.inline(f.summary), MAX_TITLE_CHARS)}`;
  const body = s.block(f.body);
  const fails =
    f.failure_scenario && f.failure_scenario.trim() !== ""
      ? `**Fails when:** ${truncateInline(s.inline(f.failure_scenario), MAX_FAILS_CHARS)}`
      : null;
  const rule = ruleLine(f.rule, s, MAX_RULE_CHARS);
  const suggestion = suggestionText(f, s);
  // design-v2 §4.3: collapsed, dropped before the suggestion when the comment is over the cap.
  const agentPrompt = options.aiAgentPrompt === true ? agentPromptDetails(f, s) : null;
  const tail = `${subLine(f, redacted)}\n${buildFindingMarker({ v: 1, fp: f.fingerprint, sev: f.severity, blk: f.blocking })}`;

  const compose = (bodyText: string, withSuggestion: boolean, withPrompt: boolean): string =>
    [
      header,
      bodyText.trim() === "" ? null : bodyText,
      fails,
      rule,
      withSuggestion && suggestion !== null ? suggestionBlock(suggestion) : null,
      withPrompt ? agentPrompt : null,
      tail,
    ]
      .filter((p): p is string => p !== null)
      .join("\n\n");

  const variants: [boolean, boolean][] = agentPrompt === null ? [[true, false], [false, false]] : [[true, true], [true, false], [false, false]];
  for (const [withSuggestion, withPrompt] of variants) {
    const full = compose(body, withSuggestion, withPrompt);
    if (full.length <= MAX_COMMENT_CHARS) return full;
    const room = MAX_COMMENT_CHARS - compose("", withSuggestion, withPrompt).length - 2;
    if (room >= 200) return compose(truncateBlock(body, room), withSuggestion, withPrompt);
  }
  // Unreachable with the caps above; keep the marker no matter what.
  return compose("", false, false);
}

/** The `comments[]` entry for POST /pulls/{n}/reviews. Caller ensures the finding is anchorable. */
export function renderInlineComment(f: RenderFinding, s: Sanitizer, options: CommentOptions = {}): ReviewComment {
  const comment: ReviewComment = { path: f.path, body: renderCommentBody(f, s, options), line: f.line, side: f.side };
  if (f.end_line !== null && f.end_line > f.line) {
    comment.start_line = f.line;
    comment.start_side = f.side;
    comment.line = f.end_line;
  }
  return comment;
}

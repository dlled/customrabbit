// Render step of the pipeline (design §2 step 10): one review body, its inline comments with
// suggestion blocks, sanitized (§8.3, §9.3) and capped (§8.5).

import { BodyRenderer } from "./body.js";
import { renderInlineComment } from "./comment.js";
import { placeFindings } from "./plan.js";
import { Sanitizer } from "./sanitize.js";
import type { RenderedReview, RenderOptions, ReviewRenderInput } from "./types.js";

export * from "./markers.js";
export * from "./types.js";
export { MAX_BODY_CHARS, RenderError } from "./body.js";
export { MAX_COMMENT_CHARS, MAX_SUGGESTION_LINES, renderCommentBody, suggestionText } from "./comment.js";
export { MAX_INLINE_COMMENTS_HARD, placeFindings, type Placement } from "./plan.js";
export { Sanitizer, ZWSP, stripMarkers } from "./sanitize.js";
export { renderJobSummary, MAX_JOB_SUMMARY_CHARS } from "./summary.js";
export { unavailableBanner } from "./format.js";
export { AI_AGENT_PREAMBLE, LEARNINGS_FILE, riskLabel, unlinkRefs } from "./walkthrough.js";

/**
 * Renders the review to post. With `inline: false` (the 422 retry of §2.2) there are no inline
 * comments and every finding is written into the body.
 * Throws RenderError when the verdict does not match the blocking set or a marker field is bad.
 */
export function renderReview(input: ReviewRenderInput, options: RenderOptions = {}): RenderedReview {
  const sanitizer = new Sanitizer();
  const placement = placeFindings(
    input.findings,
    input.config.profile,
    input.config.limits.max_inline_comments,
    options.inline ?? true,
  );
  // Every field is sanitized where it is placed; the final redact() over the assembled text is
  // belt and braces for anything a future change forgets (it is a no-op on clean output).
  const comments = placement.inline.map((f) => {
    const c = renderInlineComment(f, sanitizer, { aiAgentPrompt: input.walkthrough?.aiAgentPrompts === true });
    c.body = sanitizer.redact(c.body);
    return c;
  });
  const rendered = new BodyRenderer(input, sanitizer).render(placement);
  const body = sanitizer.redact(rendered.body);
  const truncated = rendered.truncated;
  const countOnly = Object.values(placement.countOnly).reduce((a, b) => a + b, 0);
  const inlineBlocking = placement.inline.filter((f) => f.blocking).length;
  return {
    event: input.verdict,
    body,
    comments,
    counts: {
      blocking: inlineBlocking + placement.bodyBlocking.length + input.priorBlocking.length,
      nonBlocking: placement.inline.length - inlineBlocking + placement.bodyNonBlocking.length + countOnly,
      inline: placement.inline.length,
      bodyOnly: placement.bodyBlocking.length + placement.bodyNonBlocking.length,
      dismissed: input.dismissed.length,
      addressed: input.addressed,
    },
    inlineFingerprints: placement.inline.map((f) => f.fingerprint),
    redactions: sanitizer.redactions,
    truncated,
  };
}

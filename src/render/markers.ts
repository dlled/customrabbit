// State markers (design §8.3). This module only BUILDS markers; parsing lives in src/github/
// (W2), which imports the format constants and patterns below so both sides cannot drift.
//
//   review body, last line:  <!-- myrabbit:state v=1 head=<40hex> base=<40hex> mode=<full|incremental> config=<12hex> prompt=<ver> -->
//   each inline comment:     <!-- myrabbit:f v=1 fp=<12hex> sev=<severity> blk=<0|1> -->
//   each proposed learning:  <!-- myrabbit:proposal v=1 fp=<12hex> -->   (design-v2 §6.2; fp = the
//                            fingerprint of the finding whose thread produced it, so later runs
//                            do not propose it again)

import { REVIEW_MODES, SEVERITIES, type FindingMarker, type ReviewState } from "../types.js";

export const MARKER_VERSION = 1;
export const MARKER_OPEN = "<!--";
export const MARKER_CLOSE = "-->";
/** Kind tag of the review-body marker. */
export const STATE_MARKER_KIND = "myrabbit:state";
/** Kind tag of the per-inline-comment marker. */
export const FINDING_MARKER_KIND = "myrabbit:f";
/** Kind tag of the marker under each proposed learning (design-v2 §6.2). */
export const PROPOSAL_MARKER_KIND = "myrabbit:proposal";

/** Field value patterns (regex sources, unanchored). */
export const SHA_PATTERN = "[0-9a-f]{40}";
export const CONFIG_HASH_PATTERN = "[0-9a-f]{12}";
export const FINGERPRINT_PATTERN = "[0-9a-f]{12}";
export const PROMPT_VERSION_PATTERN = "[A-Za-z0-9._-]{1,64}";
const MODE_PATTERN = REVIEW_MODES.join("|");
const SEVERITY_PATTERN = SEVERITIES.join("|");

/**
 * Matches one state marker exactly as built by buildStateMarker. Named groups:
 * head, base, mode, config, prompt. No `g` flag: callers that need every match should build
 * `new RegExp(STATE_MARKER_RE.source, "g")`.
 */
export const STATE_MARKER_RE = new RegExp(
  `${MARKER_OPEN} ${STATE_MARKER_KIND} v=${MARKER_VERSION} head=(?<head>${SHA_PATTERN}) ` +
    `base=(?<base>${SHA_PATTERN}) mode=(?<mode>${MODE_PATTERN}) config=(?<config>${CONFIG_HASH_PATTERN}) ` +
    `prompt=(?<prompt>${PROMPT_VERSION_PATTERN}) ${MARKER_CLOSE}`,
);

/** Matches one finding marker exactly as built by buildFindingMarker. Named groups: fp, sev, blk. */
export const FINDING_MARKER_RE = new RegExp(
  `${MARKER_OPEN} ${FINDING_MARKER_KIND} v=${MARKER_VERSION} fp=(?<fp>${FINGERPRINT_PATTERN}) ` +
    `sev=(?<sev>${SEVERITY_PATTERN}) blk=(?<blk>[01]) ${MARKER_CLOSE}`,
);

/** Matches one proposal marker exactly as built by buildProposalMarker. Named group: fp. */
export const PROPOSAL_MARKER_RE = new RegExp(
  `${MARKER_OPEN} ${PROPOSAL_MARKER_KIND} v=${MARKER_VERSION} fp=(?<fp>${FINGERPRINT_PATTERN}) ${MARKER_CLOSE}`,
);

/**
 * Anything that could be read as the start of a myrabbit marker, in any spacing or case. The
 * sanitizer removes these from model-written text (anti-forgery, §8.3).
 */
export const FORGED_MARKER_RE = /<!--\s*myrabbit/i;

export class MarkerError extends Error {
  override readonly name = "MarkerError";
}

function check(value: string, pattern: string, field: string): string {
  if (!new RegExp(`^(?:${pattern})$`).test(value)) {
    throw new MarkerError(`invalid marker field ${field}`);
  }
  return value;
}

/** Builds the review-body state marker. Throws MarkerError on any malformed field. */
export function buildStateMarker(state: ReviewState): string {
  const head = check(state.head, SHA_PATTERN, "head");
  const base = check(state.base, SHA_PATTERN, "base");
  const mode = check(state.mode, MODE_PATTERN, "mode");
  const config = check(state.config, CONFIG_HASH_PATTERN, "config");
  const prompt = check(state.prompt, PROMPT_VERSION_PATTERN, "prompt");
  return (
    `${MARKER_OPEN} ${STATE_MARKER_KIND} v=${MARKER_VERSION} head=${head} base=${base} ` +
    `mode=${mode} config=${config} prompt=${prompt} ${MARKER_CLOSE}`
  );
}

/** Builds the inline-comment finding marker. Throws MarkerError on any malformed field. */
export function buildFindingMarker(marker: FindingMarker): string {
  const fp = check(marker.fp, FINGERPRINT_PATTERN, "fp");
  const sev = check(marker.sev, SEVERITY_PATTERN, "sev");
  const blk = marker.blk ? "1" : "0";
  return `${MARKER_OPEN} ${FINDING_MARKER_KIND} v=${MARKER_VERSION} fp=${fp} sev=${sev} blk=${blk} ${MARKER_CLOSE}`;
}

/** Builds the proposed-learning marker. Throws MarkerError on a malformed fingerprint. */
export function buildProposalMarker(fp: string): string {
  return `${MARKER_OPEN} ${PROPOSAL_MARKER_KIND} v=${MARKER_VERSION} fp=${check(fp, FINGERPRINT_PATTERN, "fp")} ${MARKER_CLOSE}`;
}

/**
 * Fingerprints of every proposal marker in a myrabbit review body, in order, without duplicates.
 * Only exact matches count. Model text cannot carry a marker, because the sanitizer strips every
 * `<!-- myrabbit` opener from it. Callers must pass only bodies of myrabbit's own reviews.
 */
export function parseProposalMarkers(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(new RegExp(PROPOSAL_MARKER_RE.source, "g"))) {
    const fp = m.groups?.fp;
    if (fp !== undefined) out.add(fp);
  }
  return [...out];
}

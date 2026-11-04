// State markers (design §8.3): parsing. The format itself (kinds, version, field patterns) and the
// builders live in src/render/markers.ts, the single source both sides import, so they cannot drift.
//
//   review body, last line: <!-- myrabbit:state v=1 head=<40hex> base=<40hex> mode=<full|incremental> config=<sha1-12> prompt=<ver> -->
//   inline comment:         <!-- myrabbit:f v=1 fp=<12hex> sev=<s> blk=<0|1> -->
//
// Parsing is strict: every key must be present exactly once with a valid value, otherwise the
// marker is ignored (null). The renderer strips any `<!-- myrabbit` text that a model emits, and
// ownership also requires the bot login (src/github/reviews.ts, threads.ts), so a pasted marker
// in a human comment never counts.

import {
  CONFIG_HASH_PATTERN,
  FINDING_MARKER_KIND,
  FINGERPRINT_PATTERN,
  MARKER_CLOSE,
  MARKER_OPEN,
  MARKER_VERSION,
  PROMPT_VERSION_PATTERN,
  SHA_PATTERN,
  STATE_MARKER_KIND,
} from "../render/markers.js";
import { REVIEW_MODES, SEVERITIES, type FindingMarker, type ReviewMode, type ReviewState, type Severity } from "../types.js";

export { buildFindingMarker, buildStateMarker, MarkerError } from "../render/markers.js";
// design-v2 §6.2 proposal markers: format, builder and parser have one source, the renderer.
export { PROPOSAL_MARKER_KIND, parseProposalMarkers } from "../render/markers.js";

const exact = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`);
const SHA40 = exact(SHA_PATTERN);
const CONFIG_HASH = exact(CONFIG_HASH_PATTERN);
const FINGERPRINT = exact(FINGERPRINT_PATTERN);
const PROMPT_VERSION = exact(PROMPT_VERSION_PATTERN);
const VERSION = String(MARKER_VERSION);

export const STATE_MARKER_PREFIX = `${MARKER_OPEN} ${STATE_MARKER_KIND} `;
export const FINDING_MARKER_PREFIX = `${MARKER_OPEN} ${FINDING_MARKER_KIND} `;

/** Key/value pairs of every `<!-- myrabbit:<kind> ... -->` in `text`, in order. */
function markerFields(
  text: string,
  kind: typeof STATE_MARKER_KIND | typeof FINDING_MARKER_KIND,
): Map<string, string>[] {
  const re = new RegExp(`${MARKER_OPEN} ${kind} ([^<>]*?) ${MARKER_CLOSE}`, "g");
  const out: Map<string, string>[] = [];
  for (const m of text.matchAll(re)) {
    const fields = new Map<string, string>();
    let ok = true;
    for (const part of (m[1] ?? "").split(" ")) {
      const eq = part.indexOf("=");
      if (eq <= 0 || fields.has(part.slice(0, eq))) {
        ok = false;
        break;
      }
      fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
    if (ok) out.push(fields);
  }
  return out;
}

function onlyKeys(fields: Map<string, string>, keys: readonly string[]): boolean {
  return fields.size === keys.length && keys.every((k) => fields.has(k));
}

/** The last valid state marker in `body`, or null. */
export function parseStateMarker(body: string): ReviewState | null {
  const all = markerFields(body, STATE_MARKER_KIND);
  for (let i = all.length - 1; i >= 0; i--) {
    const f = all[i];
    if (!f || !onlyKeys(f, ["v", "head", "base", "mode", "config", "prompt"])) continue;
    const head = f.get("head") ?? "";
    const base = f.get("base") ?? "";
    const mode = f.get("mode") ?? "";
    const config = f.get("config") ?? "";
    const prompt = f.get("prompt") ?? "";
    if (
      f.get("v") === VERSION &&
      SHA40.test(head) &&
      SHA40.test(base) &&
      (REVIEW_MODES as readonly string[]).includes(mode) &&
      CONFIG_HASH.test(config) &&
      PROMPT_VERSION.test(prompt)
    ) {
      return { v: 1, head, base, mode: mode as ReviewMode, config, prompt };
    }
  }
  return null;
}

/** The last valid finding marker in `body`, or null. */
export function parseFindingMarker(body: string): FindingMarker | null {
  const all = markerFields(body, FINDING_MARKER_KIND);
  for (let i = all.length - 1; i >= 0; i--) {
    const f = all[i];
    if (!f || !onlyKeys(f, ["v", "fp", "sev", "blk"])) continue;
    const fp = f.get("fp") ?? "";
    const sev = f.get("sev") ?? "";
    const blk = f.get("blk");
    if (
      f.get("v") === VERSION &&
      FINGERPRINT.test(fp) &&
      (SEVERITIES as readonly string[]).includes(sev) &&
      (blk === "0" || blk === "1")
    ) {
      return { v: 1, fp, sev: sev as Severity, blk: blk === "1" };
    }
  }
  return null;
}

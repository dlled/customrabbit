import { describe, expect, it } from "vitest";
import {
  buildFindingMarker,
  buildStateMarker,
  FINDING_MARKER_RE,
  MarkerError,
  STATE_MARKER_RE,
} from "../../src/render/markers.js";
import { BASE, CONFIG_HASH, HEAD } from "./helpers.js";

describe("state marker", () => {
  const state = { v: 1, head: HEAD, base: BASE, mode: "incremental", config: CONFIG_HASH, prompt: "p1a2b3c" } as const;

  it("builds the exact §8.3 format", () => {
    expect(buildStateMarker(state)).toBe(
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=incremental config=${CONFIG_HASH} prompt=p1a2b3c -->`,
    );
  });

  it("round-trips through the exported pattern", () => {
    const m = STATE_MARKER_RE.exec(buildStateMarker(state));
    expect(m?.groups).toEqual({ head: HEAD, base: BASE, mode: "incremental", config: CONFIG_HASH, prompt: "p1a2b3c" });
  });

  it.each([
    ["head", { head: "A".repeat(40) }],
    ["head", { head: "a".repeat(39) }],
    ["base", { base: "z".repeat(40) }],
    ["config", { config: "c0ffee" }],
    ["prompt", { prompt: "has space" }],
    ["prompt", { prompt: "x -->" }],
    ["mode", { mode: "skip" }],
  ])("rejects a bad %s", (field, patch) => {
    expect(() => buildStateMarker({ ...state, ...patch } as typeof state)).toThrow(new MarkerError(`invalid marker field ${field}`));
  });
});

describe("finding marker", () => {
  it("builds the exact §8.3 format", () => {
    expect(buildFindingMarker({ v: 1, fp: "0123456789ab", sev: "major", blk: true })).toBe(
      "<!-- myrabbit:f v=1 fp=0123456789ab sev=major blk=1 -->",
    );
    expect(buildFindingMarker({ v: 1, fp: "0123456789ab", sev: "trivial", blk: false })).toBe(
      "<!-- myrabbit:f v=1 fp=0123456789ab sev=trivial blk=0 -->",
    );
  });

  it("round-trips through the exported pattern", () => {
    const m = FINDING_MARKER_RE.exec(buildFindingMarker({ v: 1, fp: "00000000beef", sev: "critical", blk: true }));
    expect(m?.groups).toEqual({ fp: "00000000beef", sev: "critical", blk: "1" });
  });

  it("rejects malformed fields", () => {
    expect(() => buildFindingMarker({ v: 1, fp: "xyz", sev: "major", blk: true })).toThrow(MarkerError);
    expect(() => buildFindingMarker({ v: 1, fp: "0123456789ab", sev: "huge" as "major", blk: true })).toThrow(MarkerError);
  });
});

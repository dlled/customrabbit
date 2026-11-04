import { describe, expect, it } from "vitest";

import {
  MarkerError,
  buildFindingMarker,
  buildStateMarker,
  parseFindingMarker,
  parseStateMarker,
} from "../../src/github/markers.js";
import type { ReviewState } from "../../src/types.js";
import { BASE, HEAD } from "./helpers.js";

const state: ReviewState = { v: 1, head: HEAD, base: BASE, mode: "incremental", config: "0123456789ab", prompt: "1.2" };

describe("state marker", () => {
  it("builds the exact §8.3 format", () => {
    expect(buildStateMarker(state)).toBe(
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=incremental config=0123456789ab prompt=1.2 -->`,
    );
  });

  it("round-trips and takes the last valid marker", () => {
    const older = buildStateMarker({ ...state, head: "d".repeat(40) });
    const body = `**myrabbit: APPROVE**\n${older}\nquote\n${buildStateMarker(state)}`;
    expect(parseStateMarker(body)).toEqual(state);
  });

  it("ignores malformed markers", () => {
    const bad = [
      `<!-- myrabbit:state v=2 head=${HEAD} base=${BASE} mode=full config=0123456789ab prompt=1 -->`,
      `<!-- myrabbit:state v=1 head=${HEAD.slice(1)} base=${BASE} mode=full config=0123456789ab prompt=1 -->`,
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=skip config=0123456789ab prompt=1 -->`,
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=full config=0123456789AB prompt=1 -->`,
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=full config=0123456789ab -->`,
      `<!-- myrabbit:state v=1 head=${HEAD} head=${HEAD} base=${BASE} mode=full config=0123456789ab prompt=1 -->`,
      `<!-- myrabbit:state v=1 head=${HEAD} base=${BASE} mode=full config=0123456789ab prompt=1 x=y -->`,
      "no marker here",
    ];
    for (const b of bad) expect(parseStateMarker(b)).toBeNull();
  });

  it("refuses to build invalid markers", () => {
    expect(() => buildStateMarker({ ...state, head: "HEAD" })).toThrow(MarkerError);
    expect(() => buildStateMarker({ ...state, prompt: "1 --> <x" })).toThrow(MarkerError);
    expect(() => buildStateMarker({ ...state, config: "abc" })).toThrow(MarkerError);
  });
});

describe("finding marker", () => {
  it("builds and parses", () => {
    const m = buildFindingMarker({ v: 1, fp: "abcdef012345", sev: "major", blk: true });
    expect(m).toBe("<!-- myrabbit:f v=1 fp=abcdef012345 sev=major blk=1 -->");
    expect(parseFindingMarker(`**[major · correctness]** x\n\nbody\n${m}`)).toEqual({
      v: 1,
      fp: "abcdef012345",
      sev: "major",
      blk: true,
    });
    expect(parseFindingMarker(buildFindingMarker({ v: 1, fp: "abcdef012345", sev: "trivial", blk: false }))?.blk).toBe(false);
  });

  it("ignores malformed markers", () => {
    expect(parseFindingMarker("<!-- myrabbit:f v=1 fp=abcdef012345 sev=huge blk=1 -->")).toBeNull();
    expect(parseFindingMarker("<!-- myrabbit:f v=1 fp=abc sev=major blk=1 -->")).toBeNull();
    expect(parseFindingMarker("<!-- myrabbit:f v=1 fp=abcdef012345 sev=major blk=yes -->")).toBeNull();
    expect(() => buildFindingMarker({ v: 1, fp: "XYZ", sev: "major", blk: true })).toThrow(MarkerError);
  });
});

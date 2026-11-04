// Pure helpers of src/config/git.ts only; createGitReader itself is exercised by W6 / S1
// (tests here never run git).

import { describe, expect, it } from "vitest";

import { utf8Prefix } from "../../src/config/git.js";

describe("utf8Prefix", () => {
  const bytes = Buffer.from("añ€😀z", "utf8"); // 1 + 2 + 3 + 4 + 1 bytes

  it.each([
    [0, ""],
    [1, "a"],
    [2, "a"],
    [3, "añ"],
    [5, "añ"],
    [6, "añ€"],
    [9, "añ€"],
    [10, "añ€😀"],
    [11, "añ€😀z"],
    [100, "añ€😀z"],
  ])("cuts at %i bytes without a partial character", (max, expected) => {
    expect(utf8Prefix(bytes, max)).toBe(expected);
  });

  it("never returns a replacement character", () => {
    for (let max = 0; max <= bytes.length; max++) expect(utf8Prefix(bytes, max)).not.toContain("�");
  });
});

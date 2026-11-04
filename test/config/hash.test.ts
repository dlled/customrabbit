import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, configHash } from "../../src/config/hash.js";
import { defaultConfig } from "../../src/config/schema.js";

const guide = { path: "AGENTS.md", scope: ["**"], content: "Be kind." };

describe("configHash", () => {
  it("is sha1 of the canonical document, first 12 hex chars", () => {
    const config = defaultConfig();
    const doc = canonicalJson({
      config,
      guides: [{ path: "AGENTS.md", scope: ["**"], sha1: createHash("sha1").update("Be kind.").digest("hex") }],
    });
    const expected = createHash("sha1").update(doc).digest("hex").slice(0, 12);
    expect(configHash(config, [guide])).toBe(expected);
  });

  it("is stable across key order", () => {
    const a = defaultConfig();
    const reversed = (o: object): object =>
      Object.fromEntries(
        Object.entries(o)
          .reverse()
          .map(([k, v]) => [k, v !== null && typeof v === "object" && !Array.isArray(v) ? reversed(v as object) : v]),
      );
    const b = reversed(a) as typeof a;
    expect(Object.keys(b)[0]).toBe("tools");
    expect(configHash(a)).toBe(configHash(b));
  });

  it("changes with any setting, guide text or guide scope", () => {
    const base = configHash(defaultConfig(), [guide]);
    expect(configHash({ ...defaultConfig(), request_changes_threshold: "critical" }, [guide])).not.toBe(base);
    expect(configHash(defaultConfig(), [{ ...guide, content: "Be kinder." }])).not.toBe(base);
    expect(configHash(defaultConfig(), [{ ...guide, scope: ["src/**"] }])).not.toBe(base);
    expect(configHash(defaultConfig(), [])).not.toBe(base);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

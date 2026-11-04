// schema/myrabbit.schema.json must be exactly what the zod schema generates.
// Regenerate after changing src/config/schema.ts:  UPDATE_SCHEMA=1 npx vitest run test/config/json-schema.test.ts

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildJsonSchema, configSchema, JSON_SCHEMA_ID } from "../../src/config/schema.js";

const SCHEMA_FILE = fileURLToPath(new URL("../../schema/myrabbit.schema.json", import.meta.url));

describe("schema/myrabbit.schema.json", () => {
  const generated = buildJsonSchema();

  if (process.env.UPDATE_SCHEMA === "1") {
    writeFileSync(SCHEMA_FILE, `${JSON.stringify(generated, null, 2)}\n`);
  }

  const committed = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;

  it("matches the zod schema", () => {
    expect(committed).toEqual(generated);
  });

  it("is draft-07 with the published $id", () => {
    expect(committed.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(committed.$id).toBe(JSON_SCHEMA_ID);
    expect(committed.additionalProperties).toBe(false);
  });

  it("lists every top-level key of the zod schema", () => {
    const props = Object.keys(committed.properties as Record<string, unknown>).sort();
    expect(props).toEqual(Object.keys(configSchema.shape).sort());
  });

  it("encodes the both-engines-disabled rule that zod expresses as a refinement", () => {
    const engines = (committed.properties as Record<string, Record<string, unknown>>).engines;
    expect(engines?.not).toBeDefined();
  });
});

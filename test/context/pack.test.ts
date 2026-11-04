import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { buildContextPack } from "../../src/context/index.js";
import { renderPack, type PackEntry } from "../../src/context/pack.js";
import type { ChangedSymbol } from "../../src/context/symbols.js";
import { CONFIG_ON, fixtureRepo, packInput, type FixtureRepo } from "./helpers.js";

const repos: FixtureRepo[] = [];
function repo(...args: Parameters<typeof fixtureRepo>): FixtureRepo {
  const r = fixtureRepo(...args);
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const LIB_BASE = `export function formatPrice(amount: number): string {
  return amount.toFixed(2);
}

export function unrelated(): number {
  return 1;
}
`;
const LIB_HEAD = `export function formatPrice(amount: number, currency: string): string {
  return currency + amount.toFixed(2);
}

export function unrelated(): number {
  return 1;
}
`;
const CART = `import { formatPrice } from "./lib";

export function total(xs: number[]): string {
  const sum = xs.reduce((a, b) => a + b, 0);
  return formatPrice(sum);
}
`;
const REPORT = `// formatPrice is not used here, only mentioned.
const label = "formatPrice";
export const r = label;
`;
const TEST = `import { formatPrice } from "../src/lib";

it("formats", () => {
  expect(formatPrice(1)).toBe("1.00");
});
`;

function tsRepo(extraBase: Record<string, string> = {}) {
  return repo(
    { "src/lib.ts": LIB_BASE, "src/cart.ts": CART, "other/report.ts": REPORT, "test/lib.test.ts": TEST, ...extraBase },
    { "src/lib.ts": LIB_HEAD },
  );
}

describe("buildContextPack: signal", () => {
  it("returns null at once for a signal that is already aborted (its abort event never fires)", async () => {
    const r = tsRepo();
    const input = await packInput(r);
    expect(await buildContextPack({ ...input, signal: AbortSignal.abort() })).toBeNull();
    // The same input without the aborted signal does produce a pack.
    expect(await buildContextPack(input)).not.toBeNull();
  });
});

describe("buildContextPack: TypeScript", () => {
  it("follows a changed signature to its callers, without comment/string hits", async () => {
    const r = tsRepo();
    const pack = await buildContextPack(await packInput(r));
    expect(pack).not.toBeNull();
    const text = pack?.text ?? "";
    expect(text).toContain("### formatPrice (function, exported, signature changed) — src/lib.ts:1");
    // The import and the call of one file share a snippet.
    expect(text).toContain("src/cart.ts:1,5\n>1 | import { formatPrice }");
    expect(text).toContain(">5 |   return formatPrice(sum);");
    expect(text).toContain("test/lib.test.ts:1,4");
    // The comment and the string in other/report.ts are not usages.
    expect(text).not.toContain("other/report.ts");
    // `unrelated` did not change.
    expect(text).not.toContain("### unrelated");
    expect(pack?.info).toEqual({ symbols: 1, usages: 4, resolver: "tree-sitter", dropped: 0 });
  });

  it("ranks same directory > importers > tests > others", async () => {
    const r = repo(
      {
        "src/lib.ts": LIB_BASE,
        "src/cart.ts": CART,
        "app/use.ts": `import { formatPrice } from "../src/lib";\nexport const a = formatPrice(1);\n`,
        "test/lib.test.ts": TEST,
        "zzz/loose.ts": `declare const formatPrice: (n: number) => string;\nexport const b = formatPrice(2);\n`,
      },
      { "src/lib.ts": LIB_HEAD },
    );
    const text = (await buildContextPack(await packInput(r)))?.text ?? "";
    const order = ["src/cart.ts:1,5", "app/use.ts:1,2", "test/lib.test.ts:1,4", "zzz/loose.ts:1,2"].map((p) => text.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps max_usages_per_symbol", async () => {
    const r = tsRepo();
    const pack = await buildContextPack(await packInput(r, { config: { ...CONFIG_ON, max_usages_per_symbol: 1 } }));
    expect(pack?.info.usages).toBe(1);
    expect(pack?.text).toContain("usages (4 found):");
    // Call sites before import lines of the same rank.
    expect(pack?.text).toContain("src/cart.ts:5\n");
    expect(pack?.text).not.toContain("test/lib.test.ts");
  });

  it("drops usages outside path_filters", async () => {
    const r = tsRepo();
    const pack = await buildContextPack(await packInput(r, { includePath: (p) => !p.startsWith("test/") }));
    expect(pack?.text).toContain("src/cart.ts:1,5");
    expect(pack?.text).not.toContain("test/lib.test.ts");
  });

  it("refines with the TypeScript LanguageService when a base tsconfig.json exists", async () => {
    const r = tsRepo({ "tsconfig.json": `{ "compilerOptions": { "strict": true, "plugins": [{ "name": "evil" }] }, "include": ["src", "test"] }` });
    const pack = await buildContextPack(await packInput(r, { config: { ...CONFIG_ON, typescript: true } }));
    expect(pack?.info.resolver).toBe("tree-sitter+ts");
    expect(pack?.text).toContain("src/cart.ts:1,5");
    expect(pack?.text).toContain("test/lib.test.ts:1,4");
  });

  it("falls back to grep when the TypeScript budget is spent", async () => {
    const r = tsRepo({ "tsconfig.json": `{ "include": ["src"] }` });
    const pack = await buildContextPack(await packInput(r, { config: { ...CONFIG_ON, typescript: true }, tsBudgetMs: -1 }));
    expect(pack?.info.resolver).toBe("tree-sitter");
    expect(pack?.text).toContain("src/cart.ts:1,5");
  });

  it("is off by default config and returns null", async () => {
    const r = tsRepo();
    expect(await buildContextPack(await packInput(r, { config: { ...CONFIG_ON, enabled: false } }))).toBeNull();
  });

  it("caps the pack at min(diff chars, max_chars) and counts dropped symbols", async () => {
    const r = tsRepo();
    const small = await buildContextPack(await packInput(r, { diffChars: 120 }));
    expect(small?.text.length ?? 0).toBeLessThanOrEqual(120);
    expect(small?.info.dropped).toBe(1);
    expect(small?.info.symbols).toBe(0);
    // Names still reach §4.6 keyword search when the budget drops the symbol's text.
    expect(small?.symbols).toEqual(["formatPrice"]);
    const capped = await buildContextPack(await packInput(r, { config: { ...CONFIG_ON, max_chars: 120 } }));
    expect(capped?.text.length ?? 0).toBeLessThanOrEqual(120);
  });

  it("validates against the eval run-document schema", async () => {
    const r = tsRepo();
    const pack = await buildContextPack(await packInput(r));
    const schema = JSON.parse(readFileSync("eval/schema/findings.schema.json", "utf8")) as {
      properties: { context: object };
    };
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema.properties.context);
    expect(validate(pack?.info)).toBe(true);
  });
});

describe("buildContextPack: other grammars", () => {
  it("Python: a removed function lists its remaining callers", async () => {
    const r = repo(
      {
        "app/billing.py": "def legacy_total(items):\n    return sum(items)\n\n\ndef keep():\n    return 0\n",
        "app/main.py": "from app.billing import legacy_total\n\nprint(legacy_total([1, 2]))\n",
      },
      { "app/billing.py": "def keep():\n    return 0\n" },
    );
    const pack = await buildContextPack(await packInput(r));
    expect(pack?.text).toContain("### legacy_total (function, exported, removed at head) — base app/billing.py:1");
    expect(pack?.symbols).toEqual(["legacy_total"]);
    expect(pack?.text).toContain("app/main.py:1,3");
  });

  it("Go: a changed exported function and its caller", async () => {
    const r = repo(
      {
        "pkg/calc/calc.go": "package calc\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n",
        "cmd/main.go": "package main\n\nimport \"example.com/m/pkg/calc\"\n\nfunc main() {\n\tprintln(calc.Add(1, 2))\n}\n",
      },
      { "pkg/calc/calc.go": "package calc\n\nfunc Add(a int, b int, c int) int {\n\treturn a + b + c\n}\n" },
    );
    const pack = await buildContextPack(await packInput(r));
    expect(pack?.text).toContain("### Add (function, exported, signature changed) — pkg/calc/calc.go:3");
    expect(pack?.text).toContain("cmd/main.go:6");
  });

  it("Rust: a pub fn and its caller", async () => {
    const r = repo(
      {
        "src/util.rs": "pub fn parse_port(s: &str) -> u16 {\n    s.parse().unwrap()\n}\n",
        "src/main.rs": "mod util;\nfn main() {\n    let p = util::parse_port(\"80\");\n    println!(\"{}\", p);\n}\n",
      },
      { "src/util.rs": "pub fn parse_port(s: &str) -> Option<u16> {\n    s.parse().ok()\n}\n" },
    );
    const pack = await buildContextPack(await packInput(r));
    expect(pack?.text).toContain("### parse_port (function, exported, signature changed) — src/util.rs:1");
    expect(pack?.text).toContain("src/main.rs:3");
  });

  it("Bash: a function body change and its caller", async () => {
    const r = repo(
      {
        "scripts/lib.sh": "log_line() {\n  echo \"$1\"\n}\n",
        "scripts/run.sh": "#!/bin/sh\n. ./lib.sh\nlog_line start\n# log_line in a comment\n",
      },
      { "scripts/lib.sh": "log_line() {\n  printf '%s\\n' \"$1\" >&2\n}\n" },
    );
    const pack = await buildContextPack(await packInput(r));
    expect(pack?.text).toContain("### log_line (function, exported, body changed) — scripts/lib.sh:1");
    expect(pack?.text).toContain("scripts/run.sh:3");
    expect(pack?.text).not.toContain("scripts/run.sh:4\n");
  });

  it("text fallback: a changed YAML key and its users", async () => {
    const r = repo(
      {
        "config/app.yml": "server:\n  timeout_seconds: 30\n",
        "src/server.py": "def load(cfg):\n    return cfg['server']['timeout_seconds']\n",
      },
      { "config/app.yml": "server:\n  timeout_seconds: 60\n" },
    );
    const pack = await buildContextPack(await packInput(r));
    expect(pack?.text).toContain("### timeout_seconds (config-key");
    // A string key in Python is how config is read: the text fallback keeps config-key hits.
    expect(pack?.info.symbols).toBeGreaterThan(0);
  });

  it("an empty diff gives an empty pack with zero counts", async () => {
    const r = repo({ "a.ts": "export const x = 1;\n" }, {});
    const pack = await buildContextPack(await packInput(r));
    expect(pack).toEqual({ text: "", info: { symbols: 0, usages: 0, resolver: "tree-sitter", dropped: 0 }, symbols: [] });
  });
});

describe("step budget", () => {
  it("returns what was collected when the 60 s budget runs out", async () => {
    const r = tsRepo();
    const input = await packInput(r);
    // A git that never answers grep: the step must still end at its budget.
    const slowGit: typeof input.git = (args) =>
      args.includes("grep") ? new Promise(() => undefined) : input.git(args);
    const started = Date.now();
    const pack = await buildContextPack({ ...input, git: slowGit, budgetMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pack?.info.symbols).toBe(0);
    expect(pack?.info.dropped).toBe(1);
  });

  it("returns null when git fails outright", async () => {
    const r = tsRepo();
    const input = await packInput(r);
    const pack = await buildContextPack({ ...input, git: () => Promise.reject(new Error("boom")) });
    expect(pack).toBeNull();
  });
});

describe("renderPack", () => {
  const sym = (name: string, signatureChanged: boolean, exported: boolean): ChangedSymbol => ({
    name,
    kind: "function",
    path: "a.ts",
    side: "head",
    lang: "typescript",
    def: { name, kind: "function", startLine: 1, endLine: 2, nameLine: 1, nameIndex: 0, signatureEnd: 1, exported },
    exported,
    signatureChanged,
    deleted: false,
  });
  const entry = (s: ChangedSymbol, outside: number): PackEntry => ({
    symbol: s,
    outside,
    total: outside,
    header: `### ${s.name}\n`,
    definition: "a.ts:1\n 1 | x\n",
    usages: Array.from({ length: outside }, (_, i) => ({ text: `b.ts:${i + 1}\n>${i + 1} | y\n`, count: 1 })),
  });

  it("orders signature changed > exported > usages outside", () => {
    const r = renderPack([entry(sym("body", false, true), 9), entry(sym("sigLocal", true, false), 0), entry(sym("sigExp", true, true), 1), entry(sym("bodyMany", false, true), 10)], 10_000);
    const idx = ["sigExp", "sigLocal", "bodyMany", "body"].map((n) => r.text.indexOf(`### ${n}\n`));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("never exceeds the cap and keeps whole lines", () => {
    const entries = [entry(sym("aaa", true, true), 5), entry(sym("bbb", true, true), 5)];
    for (const cap of [0, 10, 40, 60, 100, 200]) {
      const r = renderPack(entries, cap);
      expect(r.text.length).toBeLessThanOrEqual(cap);
      expect(r.symbols + r.dropped).toBe(2);
    }
  });
});

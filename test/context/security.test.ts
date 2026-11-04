// design-v2 §1.1 / §3.4: PR content is read only as git blobs. Symlinks and submodules are never
// followed, the working tree is never read, tsconfig paths stay inside the repo, and names reach git
// only as literals.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { grepWord, isSafeName, listTree, MAX_BLOB_BYTES } from "../../src/context/git.js";
import { buildContextPack } from "../../src/context/index.js";
import { confine, loadBaseTsconfig, refineWithTypeScript } from "../../src/context/typescript.js";
import type { GitResult, GitRunner } from "../../src/github/git.js";
import { CONFIG_ON, fixtureRepo, packInput, type FixtureRepo } from "./helpers.js";

const CANARY = "CANARY-7f3e1d-secret-value";

let secretDir = "";
let secretFile = "";
beforeAll(() => {
  secretDir = mkdtempSync(join(tmpdir(), "myrabbit-secret-"));
  secretFile = join(secretDir, "token.txt");
  // Looks like code, so a parser or grep that followed the link would surface it.
  writeFileSync(secretFile, `export function formatPrice() { return "${CANARY}"; }\n// formatPrice ${CANARY}\n`);
});
afterAll(() => {
  rmSync(secretDir, { recursive: true, force: true });
});

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** Records every git invocation, so tests can assert what was (not) asked of git. */
function recording(git: GitRunner): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: (args) => {
      calls.push([...args]);
      return git(args);
    },
  };
}

const LIB_BASE = "export function formatPrice(amount: number): string {\n  return amount.toFixed(2);\n}\n";
const LIB_HEAD = "export function formatPrice(amount: number, c: string): string {\n  return c + amount.toFixed(2);\n}\n";

describe("symlink-to-secret fixture", () => {
  it("never reads, parses or greps through a symlink, a submodule or the working tree", async () => {
    const r = fixtureRepo(
      {
        "src/lib.ts": LIB_BASE,
        "src/cart.ts": 'import { formatPrice } from "./lib";\nexport const t = formatPrice(1);\n',
        // Base tsconfig is a symlink to the secret: must count as absent.
        "tsconfig.json": { link: secretFile },
      },
      {
        "src/lib.ts": LIB_HEAD,
        // Absolute and relative links to the secret, one of them with a changed-file name.
        "src/leak.ts": { link: secretFile },
        "src/rel.ts": { link: `../../../../../../../../../../..${secretFile}` },
        "config/app.yml": { link: secretFile },
      },
    );
    repos.push(r);
    // A submodule entry (160000) at head.
    r.sh("update-index", "--add", "--cacheinfo", `160000,${r.base},vendor/sub`);
    r.sh("commit", "-q", "-m", "submodule");
    const head = r.sh("rev-parse", "HEAD");
    // An uncommitted working-tree file: the pack must reflect commits only.
    writeFileSync(join(r.dir, "src/dirty.ts"), `import { formatPrice } from "./lib";\nformatPrice("${CANARY}");\n`);
    writeFileSync(join(r.dir, "src/cart.ts"), `export const t = formatPrice("${CANARY}");\n`);

    const rec = recording(r.git);
    const input = await packInput({ ...r, head }, { config: { ...CONFIG_ON, typescript: true } });
    // The diff lists the symlinks; the pack must still skip them.
    expect(input.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/leak.ts", "src/rel.ts"]));
    const pack = await buildContextPack({ ...input, git: rec.git });

    expect(pack).not.toBeNull();
    const text = pack?.text ?? "";
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(secretDir);
    expect(text).not.toContain("src/leak.ts");
    expect(text).not.toContain("src/rel.ts");
    expect(text).not.toContain("vendor/sub");
    expect(text).not.toContain("src/dirty.ts");
    expect(text).toContain("src/cart.ts:1,2");
    // No tsconfig at base (it is a symlink), so no TypeScript refinement.
    expect(pack?.info.resolver).toBe("tree-sitter");

    // git saw only tree, blob and grep commands, never a working-tree read.
    const verbs = new Set(rec.calls.map((a) => a.find((x) => ["ls-tree", "cat-file", "grep"].includes(x)) ?? a.join(" ")));
    expect([...verbs].sort()).toEqual(["cat-file", "grep", "ls-tree"]);
    for (const a of rec.calls.filter((x) => x.includes("grep"))) {
      expect(a).toContain("-F");
      expect(a[a.indexOf("-e") + 2]).toMatch(/^[0-9a-f]{40}$/);
      expect(a.at(-1)).toBe("--");
      expect(a.some((x) => x.startsWith("--attr-source="))).toBe(true);
    }
  });

  it("listTree keeps regular files only", async () => {
    const r = fixtureRepo({ "a.ts": "x\n", "l.ts": { link: secretFile }, "b.sh": "y\n" }, {});
    repos.push(r);
    r.sh("update-index", "--add", "--cacheinfo", `160000,${r.base},sub`);
    r.sh("commit", "-q", "-m", "sub");
    const tree = await listTree(r.git, r.sh("rev-parse", "HEAD"));
    expect([...tree.files.keys()].sort()).toEqual(["a.ts", "b.sh"]);
    expect(await tree.read("l.ts")).toBeNull();
    expect(await tree.read("sub")).toBeNull();
    expect(await tree.read("../../etc/passwd")).toBeNull();
  });

  it("skips blobs over 1 MB and binary blobs", async () => {
    const r = fixtureRepo({ "big.ts": `${"a".repeat(MAX_BLOB_BYTES + 1)}\n`, "bin.ts": "a\0b\n", "ok.ts": "ok\n" }, {});
    repos.push(r);
    const tree = await listTree(r.git, r.head);
    expect(await tree.read("big.ts")).toBeNull();
    expect(await tree.read("bin.ts")).toBeNull();
    expect(await tree.read("ok.ts")).toBe("ok\n");
  });
});

describe("git arguments", () => {
  it("passes names as literals after -e, never as options or regexes", async () => {
    const r = fixtureRepo({ "a.txt": "--help\n.*\nfoo\n" }, {});
    repos.push(r);
    const tree = await listTree(r.git, r.head);
    expect((await grepWord(r.git, tree, "--help", { attrSource: r.base })).map((h) => h.line)).toEqual([1]);
    expect(await grepWord(r.git, tree, ".*", { attrSource: r.base })).toHaveLength(1);
  });

  it("drops names with NUL, newlines or over 200 chars", async () => {
    expect(isSafeName("ok_name")).toBe(true);
    expect(isSafeName("a\nb")).toBe(false);
    expect(isSafeName("a\0b")).toBe(false);
    expect(isSafeName("x".repeat(201))).toBe(false);
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve<GitResult>({ code: 1, stdout: "", stderr: "" });
    };
    const tree = { commit: "a".repeat(40), has: () => true } as unknown as Parameters<typeof grepWord>[1];
    expect(await grepWord(git, tree, "a\nb", { attrSource: "b".repeat(40) })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("tsconfig confinement", () => {
  it("confine() keeps repo paths only", () => {
    expect(confine("", "src")).toBe("src");
    expect(confine("pkg", "../src/x")).toBe("src/x");
    expect(confine("", ".")).toBe("");
    expect(confine("", "../outside")).toBeNull();
    expect(confine("pkg", "../../outside")).toBeNull();
    expect(confine("", "/etc/passwd")).toBeNull();
    expect(confine("", "C:/x")).toBeNull();
    expect(confine("", "a\\b")).toBeNull();
    expect(confine("", "node_modules/@types")).toBeNull();
    expect(confine("", "src/../node_modules/x")).toBeNull();
  });

  it("drops plugins, escapes, absolute paths, node_modules and package extends", async () => {
    const r = fixtureRepo(
      {
        "tsconfig.json": `{
          // JSONC comments are fine
          "extends": ["./tsconfig.base.json", "@tsconfig/node20/tsconfig.json", "/etc/evil.json", "../up.json"],
          "compilerOptions": {
            "strict": true,
            "plugins": [{ "name": "evil-plugin" }],
            "outDir": "/tmp/out",
            "baseUrl": ".",
            "paths": { "@app/*": ["src/*"], "@evil/*": ["../../etc/*"], "@nm/*": ["node_modules/x/*"] },
            "typeRoots": ["./types", "/usr/lib/types", "./node_modules/@types"],
            "rootDir": "/"
          },
          "include": ["src", "../outside", "/abs"],
          "references": [{ "path": "./pkg" }, { "path": "/abs" }]
        }`,
        "tsconfig.base.json": `{ "compilerOptions": { "target": "es2022", "plugins": [{ "name": "x" }] }, "exclude": ["dist"] }`,
      },
      {},
    );
    repos.push(r);
    const base = await listTree(r.git, r.base);
    const cfg = await loadBaseTsconfig(base);
    expect(cfg).not.toBeNull();
    expect(cfg?.compilerOptions).toEqual({
      target: "es2022",
      strict: true,
      baseUrl: "/repo",
      paths: { "@app/*": ["/repo/src/*"] },
      typeRoots: ["/repo/types"],
    });
    expect(cfg?.include).toEqual(["src"]);
    expect(cfg?.exclude).toEqual(["dist"]);
    expect(cfg?.references).toEqual(["pkg"]);
    expect(cfg?.dropped).toEqual(
      expect.arrayContaining([
        "compilerOptions.plugins",
        "compilerOptions.outDir",
        "compilerOptions.rootDir",
        "extends:@tsconfig/node20/tsconfig.json",
        "extends:/etc/evil.json",
        "extends:../up.json",
        "include:../outside",
        "include:/abs",
      ]),
    );
  });

  it("serves only head-tree files to the LanguageService", async () => {
    const r = fixtureRepo(
      {
        "tsconfig.json": `{ "compilerOptions": { "allowJs": true, "baseUrl": ".", "paths": { "secret": ["${secretFile}"] } } }`,
        "src/lib.ts": LIB_BASE,
        "src/use.ts": 'import { formatPrice } from "./lib";\nimport "secret";\nexport const x = formatPrice(1);\n',
        "src/link.ts": { link: secretFile },
      },
      { "src/lib.ts": LIB_HEAD },
    );
    repos.push(r);
    const base = await listTree(r.git, r.base);
    const head = await listTree(r.git, r.head);
    const text = (await head.read("src/lib.ts")) ?? "";
    const res = await refineWithTypeScript(base, head, [{ key: "formatPrice", path: "src/lib.ts", index: text.indexOf("formatPrice") }]);
    expect(res?.timedOut).toBe(false);
    const refs = res?.refs.get("formatPrice") ?? [];
    expect(refs).toEqual(expect.arrayContaining([{ path: "src/use.ts", line: 1 }, { path: "src/use.ts", line: 3 }]));
    expect(refs.every((x) => x.path.startsWith("src/") && x.path !== "src/link.ts")).toBe(true);
  });
});

// Bundles src/main.ts -> dist/main.js (design §3) and src/orchestrator/tools-install.ts ->
// dist/tools-install.js (design-v2 §7.2). The SDKs ship native binaries, so they stay
// external and are installed by `npm ci --omit=dev --ignore-scripts` in the composite action.
// The prompt templates (src/prompts/*.md) are embedded through `define`, so the bundle does not
// read them from disk at run time (src/orchestrator/templates.ts).
import { readdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const TEMPLATE_NAMES = ["system", "review", "verify", "resolve"];
const templates = Object.fromEntries(
  TEMPLATE_NAMES.map((name) => [name, readFileSync(`src/prompts/${name}.md`, "utf8")]),
);
// design-v2 §4.4 rule packs: every src/prompts/packs/*.md, keyed by basename. rulePacks()
// (src/prompts/packs/index.ts) takes them in RULE_PACK_NAMES order and throws if one is missing.
const packs = Object.fromEntries(
  readdirSync("src/prompts/packs")
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => [f.slice(0, -3), readFileSync(`src/prompts/packs/${f}`, "utf8")]),
);

await build({
  // design-v2 §7.2: dist/tools-install.js is the second entry point, spawned by the orchestrator in
  // a minimal-env child to install the pinned static-analysis tools.
  entryPoints: { main: "src/main.ts", "tools-install": "src/orchestrator/tools-install.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],
  define: {
    __MYRABBIT_TEMPLATES__: JSON.stringify(templates),
    __MYRABBIT_RULE_PACKS__: JSON.stringify(packs),
    // design-v2 §6.2 proposal prompt; separate because it is not part of prompt_version.
    __MYRABBIT_LEARNING_TEMPLATE__: JSON.stringify(readFileSync("src/prompts/learning.md", "utf8")),
  },
  // CJS dependencies bundled into ESM need a real require().
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

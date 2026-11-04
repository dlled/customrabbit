// web-tree-sitter grammars (design-v2 §3.1 step 1). The parser and every grammar are WASM files from
// myrabbit's own lockfile (no native build, so `npm ci --ignore-scripts` is enough). They are loaded
// from node_modules at run time, next to the bundle, never from the PR checkout.
//
// The symbol queries are each grammar's own `queries/tags.scm` (`@definition.*` / `@reference.*`),
// plus small supplements for what tags.scm leaves out (type aliases, exported constants, Go/Rust
// constants). Bash ships no tags.scm, so its one pattern is inline.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type * as TreeSitter from "web-tree-sitter";

export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "bash";

interface GrammarSpec {
  wasm: string;
  tags: string[];
  supplements: string[];
}

const JS_EXPORTED_CONST =
  "(export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @definition.constant";

const GRAMMARS: Record<LanguageId, GrammarSpec> = {
  typescript: {
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    tags: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"],
    supplements: [
      "(type_alias_declaration name: (type_identifier) @name) @definition.type",
      "(enum_declaration name: (identifier) @name) @definition.enum",
      JS_EXPORTED_CONST,
    ],
  },
  tsx: {
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
    tags: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"],
    supplements: [
      "(type_alias_declaration name: (type_identifier) @name) @definition.type",
      "(enum_declaration name: (identifier) @name) @definition.enum",
      JS_EXPORTED_CONST,
    ],
  },
  javascript: {
    wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm",
    tags: ["tree-sitter-javascript/queries/tags.scm"],
    supplements: [JS_EXPORTED_CONST],
  },
  python: {
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    tags: ["tree-sitter-python/queries/tags.scm"],
    supplements: ["(module (expression_statement (assignment left: (identifier) @name)) @definition.constant)"],
  },
  go: {
    wasm: "tree-sitter-go/tree-sitter-go.wasm",
    tags: ["tree-sitter-go/queries/tags.scm"],
    supplements: [
      "(source_file (const_declaration (const_spec name: (identifier) @name) @definition.constant))",
      "(source_file (var_declaration (var_spec name: (identifier) @name) @definition.constant))",
    ],
  },
  rust: {
    wasm: "tree-sitter-rust/tree-sitter-rust.wasm",
    tags: ["tree-sitter-rust/queries/tags.scm"],
    supplements: [
      "(const_item name: (identifier) @name) @definition.constant",
      "(static_item name: (identifier) @name) @definition.constant",
    ],
  },
  bash: {
    wasm: "tree-sitter-bash/tree-sitter-bash.wasm",
    tags: [],
    supplements: ["(function_definition name: (word) @name) @definition.function"],
  },
};

const EXTENSIONS: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
};

/** The grammar for a path, by extension; null means the text fallback. */
export function languageFor(path: string): LanguageId | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[base.slice(dot + 1).toLowerCase()] ?? null;
}

export function isTsLike(lang: LanguageId | null): boolean {
  return lang === "typescript" || lang === "tsx" || lang === "javascript";
}

export interface LoadedLanguage {
  id: LanguageId;
  parser: TreeSitter.Parser;
  /** One query per tags file / supplement; a pattern that fails to compile is left out. */
  queries: TreeSitter.Query[];
}

const require = createRequire(import.meta.url);

type WebTreeSitter = typeof TreeSitter;

let modulePromise: Promise<WebTreeSitter> | null = null;
const languages = new Map<LanguageId, Promise<LoadedLanguage | null>>();

/** Loads web-tree-sitter once (from node_modules, with its own WASM). */
function loadModule(): Promise<WebTreeSitter> {
  modulePromise ??= (async () => {
    // A computed specifier keeps the bundler from inlining the package; its WASM sits next to it.
    const specifier = pathToFileURL(require.resolve("web-tree-sitter")).href;
    const mod = (await import(specifier)) as WebTreeSitter;
    const wasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
    await mod.Parser.init({ locateFile: () => wasm });
    return mod;
  })();
  return modulePromise;
}

/** The parser and queries for a language; null when the grammar cannot be loaded. */
export function loadLanguage(id: LanguageId): Promise<LoadedLanguage | null> {
  let p = languages.get(id);
  if (!p) {
    p = (async () => {
      try {
        const mod = await loadModule();
        const spec = GRAMMARS[id];
        const language = await mod.Language.load(readFileSync(require.resolve(spec.wasm)));
        const parser = new mod.Parser();
        parser.setLanguage(language);
        const sources = [...spec.tags.map((t) => readFileSync(require.resolve(t), "utf8")), ...spec.supplements];
        const queries: TreeSitter.Query[] = [];
        for (const src of sources) {
          try {
            queries.push(new mod.Query(language, src));
          } catch {
            // A tags file that does not compile against this grammar version is skipped.
          }
        }
        return { id, parser, queries };
      } catch {
        return null;
      }
    })();
    languages.set(id, p);
  }
  return p;
}

/** Node types whose text is not code: hits inside them are not usages. */
const NOT_CODE = /comment|string|heredoc|regex|char_literal/;
/** Code islands inside strings (template `${}`, f-string `{}`, shell `$()` / `${}`). */
const CODE_ISLAND = /^(template_substitution|interpolation|expansion|command_substitution|simple_expansion)$/;

/** True when the character at `index` of the parsed text is inside a comment or string literal. */
export function inCommentOrString(root: TreeSitter.Node, index: number): boolean {
  let n: TreeSitter.Node | null = root.descendantForIndex(index, index);
  while (n) {
    if (CODE_ISLAND.test(n.type)) return false;
    if (NOT_CODE.test(n.type)) return true;
    n = n.parent;
  }
  return false;
}

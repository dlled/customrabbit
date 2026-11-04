// Prompt templates (design §6). The dist bundle embeds them at build time (esbuild `define` in
// esbuild.config.mjs), so dist/main.js is self-contained; from source (tests) they are read from
// src/prompts/*.md.

import { loadLearningTemplate } from "../learnings/index.js";
import { loadTemplates, type Templates } from "../prompts/builder.js";

declare const __MYRABBIT_TEMPLATES__: Templates | undefined;
declare const __MYRABBIT_LEARNING_TEMPLATE__: string | undefined;

/** The templates embedded in the bundle, else src/prompts/*.md. */
export function bundledTemplates(): Templates {
  if (typeof __MYRABBIT_TEMPLATES__ !== "undefined") return __MYRABBIT_TEMPLATES__;
  return loadTemplates();
}

/**
 * The design-v2 §6.2 proposal template (src/prompts/learning.md), embedded in the bundle, else
 * read from disk. It is not part of `Templates`, so it stays out of `prompt_version` (lead, P4).
 */
export function bundledLearningTemplate(): string {
  if (typeof __MYRABBIT_LEARNING_TEMPLATE__ !== "undefined") return __MYRABBIT_LEARNING_TEMPLATE__;
  return loadLearningTemplate();
}

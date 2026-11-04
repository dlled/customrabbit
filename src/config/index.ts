// Public API of src/config (design.md §4, §4.1, §8.3).

export { createGitReader, type GitReader } from "./git.js";
export { configHash, canonicalJson, CONFIG_HASH_LENGTH } from "./hash.js";
export { LEARNINGS_PATH, parseLearnings, type Learning } from "./learnings.js";
export {
  CONFIG_PATH,
  loadConfig,
  loadReviewConfig,
  parseConfigText,
  type ConfigSource,
  type LoadedConfig,
  type ReviewConfig,
} from "./load.js";
export {
  compilePathFilter,
  DEFAULT_PATH_FILTERS,
  partitionPaths,
  type FilteredPath,
  type PathFilter,
  type PathPartition,
} from "./path-filters.js";
export {
  applicableRules,
  indexInstructions,
  instructionsFor,
  type FileRules,
  type IndexedInstruction,
} from "./path-instructions.js";
export { buildJsonSchema, configSchema, defaultConfig, type ConfigInput } from "./schema.js";
export {
  AUTO_GUIDE_GLOBS,
  collectStyleGuides,
  GUIDE_READ_LIMIT_BYTES,
  guidesFor,
  STYLE_GUIDE_CHAR_CAP,
  type StyleGuide,
  type StyleGuideCollection,
} from "./style-guide.js";

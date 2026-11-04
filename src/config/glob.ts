// Shared minimatch options. `dot: true` so "**" also walks dot directories (".github/…", ".claude/…").
// Matching is case-sensitive, like CodeRabbit.

import type { MinimatchOptions } from "minimatch";

/** For patterns whose "!" prefix is handled by the caller (path_filters, scopes, listFiles). */
export const GLOB_OPTIONS: MinimatchOptions = { dot: true, nocomment: true, nonegate: true };

/** For path_instructions: minimatch semantics, so a leading "!" negates the glob. */
export const INSTRUCTION_GLOB_OPTIONS: MinimatchOptions = { dot: true, nocomment: true };

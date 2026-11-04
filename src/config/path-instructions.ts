// path_instructions matching (design.md §4, §4.1 step 3) and the per-file rule map the prompt
// builder uses (§6.2: "reviewed file paths, each with the ids of the guides and instructions that apply").

import { Minimatch } from "minimatch";

import type { PathInstruction } from "../types.js";
import { INSTRUCTION_GLOB_OPTIONS } from "./glob.js";
import { normalizePath } from "./path-filters.js";
import { guideApplies, type StyleGuide } from "./style-guide.js";

export interface IndexedInstruction extends PathInstruction {
  /** Stable id in config order: "P1", "P2", … */
  id: string;
}

export function indexInstructions(instructions: readonly PathInstruction[]): IndexedInstruction[] {
  return instructions.map((pi, i) => ({ id: `P${i + 1}`, path: pi.path, instructions: pi.instructions }));
}

/** Every instruction whose minimatch glob matches `path`, in config order. */
export function instructionsFor<T extends PathInstruction>(path: string, instructions: readonly T[]): T[] {
  const p = normalizePath(path);
  return instructions.filter((pi) => new Minimatch(pi.path, INSTRUCTION_GLOB_OPTIONS).match(p));
}

export interface FileRules {
  /** Ids of the style guides whose scope covers the file. */
  guides: string[];
  /** Ids of the path_instructions whose glob matches the file. */
  instructions: string[];
}

/** For each reviewed path, the guides and instructions that apply to it. */
export function applicableRules(
  paths: readonly string[],
  guides: readonly StyleGuide[],
  instructions: readonly IndexedInstruction[],
): Map<string, FileRules> {
  const matchers = instructions.map((pi) => ({
    id: pi.id,
    m: new Minimatch(pi.path, INSTRUCTION_GLOB_OPTIONS),
  }));
  const out = new Map<string, FileRules>();
  for (const path of paths) {
    const p = normalizePath(path);
    out.set(path, {
      guides: guides.filter((g) => guideApplies(g, p)).map((g) => g.id),
      instructions: matchers.filter(({ m }) => m.match(p)).map(({ id }) => id),
    });
  }
  return out;
}

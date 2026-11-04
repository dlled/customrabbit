// §7.2 step 2: anchor check against the merge-base diff (§8.2).

import type { Side } from "../types.js";
import type { AnchorMap, AnchorTuple } from "./types.js";

/** AnchorMap over `(path, side, line, hunk)` tuples: a range anchors iff all its lines share one hunk. */
export class TupleAnchorMap implements AnchorMap {
  private readonly hunkOf = new Map<string, number>();

  constructor(tuples: Iterable<AnchorTuple>) {
    for (const t of tuples) this.hunkOf.set(key(t.path, t.side, t.line), t.hunk);
  }

  isAnchored(path: string, side: Side, line: number, endLine: number | null): boolean {
    const hunk = this.hunkOf.get(key(path, side, line));
    if (hunk === undefined) return false;
    for (let l = line + 1; l <= (endLine ?? line); l++) {
      if (this.hunkOf.get(key(path, side, l)) !== hunk) return false;
    }
    return true;
  }
}

function key(path: string, side: Side, line: number): string {
  return `${side}\0${String(line)}\0${path}`;
}

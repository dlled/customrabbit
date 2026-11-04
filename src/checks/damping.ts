// §5.2 damping across engines: the same "agreement or confirmation" idea as v1 §7.2, with no
// verify call. Pure.
//
// Each engine that ran casts one vote per check: its status, or `missing` when its output has no
// item with that check's name. An engine that did not run (failed, timed out, skipped: v1 §2.2)
// casts no vote, so it never splits one.
//
//   votes                    → combined
//   fail, fail               → fail
//   fail  (other not run)    → fail
//   pass, pass               → pass
//   pass  (other not run)    → pass
//   anything else            → inconclusive   (split, an inconclusive or missing vote, no engine)

import type { CheckStatus } from "../types.js";

export type CheckVote = CheckStatus | "missing";

/** The combined status of one check from the votes of the engines that ran. */
export function dampStatus(votes: readonly CheckVote[]): CheckStatus {
  if (votes.length === 0) return "inconclusive";
  if (votes.every((v) => v === "fail")) return "fail";
  if (votes.every((v) => v === "pass")) return "pass";
  return "inconclusive";
}

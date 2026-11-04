// Public surface of the merge step (design §7). The orchestrator calls, in order:
//   1. mergeReview(outputs, opts)               — §7.2 steps 1-8, including verification
//   2. (incremental) resolve open threads       — §6.4, outside this module; update PriorThread.state
//   3. computeVerdict({ findings, priorThreads, threshold, coverage, sources })   — §7.4, §7.5
//   4. buildRunDocument(...) / serializeRunDocument(doc)                          — §5.2

export { TupleAnchorMap } from "./anchor.js";
export { isBlocking, isConfirmed } from "./blocking.js";
export { cluster, dampSeverity, reduceCluster, sameIssue } from "./cluster.js";
export { COVERAGE_TITLE, coverageFinding, isCoverageIncomplete } from "./coverage.js";
export { fingerprint, normalizeTitle } from "./fingerprint.js";
export { mergeReview, type EngineSummary, type FindingDetails, type MergeResult } from "./merge.js";
export { isInlineEligible, orderFindings, placeFindings } from "./profile.js";
export {
  buildRunDocument,
  evalVerdict,
  priorThreadFinding,
  serializeRunDocument,
  toRunDocumentJSON,
  type RunDocumentInput,
} from "./run-document.js";
export { meetsThreshold, severityRank } from "./severity.js";
export * from "./types.js";
export { LIMITS, validateEngineOutput } from "./validate.js";
export { computeVerdict, priorThreadBlocks, type VerdictInput, type VerdictResult } from "./verdict.js";
export { verifyAll } from "./verify.js";

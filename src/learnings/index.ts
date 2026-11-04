// Learnings (design-v2 §6). §6.1 parsing lives in src/config/learnings.ts (it runs with the config,
// from the base SHA); this module is §6.2: selecting threads for proposals, the proposal prompt,
// and turning an engine answer into a ProposedLearning for the body.
//
// Wiring (PW), per run with `learnings.propose` on:
//   1. for each myrabbit thread, build a LearningThread (replies + anchorUnchanged);
//   2. selectProposals(threads, trustedAuthors, engines that ran, { alreadyProposed }) → ≤ 3
//      requests; alreadyProposed = fps from the `myrabbit:proposal` markers of earlier bodies;
//   3. per request: buildLearningPrompt → engine call with LEARNING_OUTPUT_SCHEMA /
//      parseLearningOutput → toProposal(request, output, titles of the parsed learnings); a failed
//      call yields no proposal and never fails the run;
//   4. the proposals go to the run document (`proposed_learnings`) and the body, rendered with
//      formatLearning (src/config/learnings.ts) as the snippet to append.

export {
  buildLearningPrompt,
  LEARNING_OUTPUT_SCHEMA,
  loadLearningTemplate,
  parseLearningOutput,
  titleKey,
  toProposal,
  type LearningOutput,
  type LearningPrompt,
} from "./prompt.js";
export {
  anchorUnchanged,
  MAX_PROPOSAL_CALLS,
  selectProposals,
  type LearningThread,
  type ProposalRequest,
  type SelectOptions,
  type ThreadReply,
} from "./select.js";

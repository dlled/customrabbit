# GitHub Actions

Flag these only in workflow or action files the diff adds or changes. This pack leaves syntax, expression injection, unpinned `uses:`, broad `permissions` and dangerous triggers to actionlint and zizmor. Rules marked WTR apply only when the repository's jobs run on WTR (labels `self-hosted, wtr-ci`).

- **wtr-labels** (WTR): every job must request exactly three labels, `[self-hosted, wtr-ci, "wtr-${{ github.run_id }}-${{ github.run_attempt }}-<job-key>"]`. The last label must equal the YAML job key (`GITHUB_JOB`, not `name:`), be unique across all jobs in the run attempt, and for matrix jobs append every distinguishing axis after `--` (`quality--node24`). Failure: duplicate labels are rejected and the jobs stay queued; a wrong key fails the pre-job hook [1].
- **wtr-hosted-fallback** (WTR): any `ubuntu-latest` or other GitHub-hosted `runs-on`, including in matrices and called workflows. Owner policy is no hosted minutes and no hosted fallback [1].
- **wtr-fork-guard** (WTR): a job that runs on `pull_request` without `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`. The guard skips fork jobs in GitHub; without it they are left queued for the controller to reject [1].
- **wtr-trigger** (WTR): a trigger other than `workflow_dispatch`, `push`, `pull_request`, `schedule` (or `workflow_call` from one of them). The controller never gives it a VM, so the job queues forever [1].
- **no-timeout**: a job without `timeout-minutes`. The default is 360 minutes [2]; a hung job holds the runner (on WTR, the single VM) that long.
- **masked-failure**: `continue-on-error: true`, `|| true` or `set +e` on a test, build or security step of a required check. It allows "a job to pass when this step fails" [2]: the check is green while the step failed.
- **derived-secret**: a value derived from a secret (decoded, exchanged for a token, a field extracted from JSON) echoed, written to a file or output without `::add-mask::`. Derived values must be "formally registered as a secret" or they are not redacted in logs [3].

Sources:
[1] WTR CI workflow conventions (exactly three labels, trusted actors, no forks)
[2] https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
[3] https://docs.github.com/en/actions/reference/security/secure-use

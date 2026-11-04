# customrabbit

customrabbit (formerly myrabbit) is a self-hosted pull request reviewer. It runs as a GitHub
Actions job on a runner you choose. Claude (through the Claude Agent SDK) and Codex (through the
Codex SDK) review the PR in parallel, with the same prompt and output schema. Their findings are
merged and deduplicated. A deterministic verdict then posts **one** review from your GitHub App,
`APPROVE` or `REQUEST_CHANGES`, with a walkthrough in its body. Each review follows the repository's
`.myrabbit.yaml` and style guide, both read from the PR's **base** commit, so a PR can't change
the rules it is reviewed by.

Internal names keep the original prefix: the config file `.myrabbit.yaml`, the `myrabbit-claude`,
`myrabbit-codex` and `myrabbit-tools` guest users, the `myrabbit:` labels and markers, and the
`MYRABBIT_*` secrets.

Licensed under the [Apache License 2.0](LICENSE).

## Quick start

1. **Create a GitHub App** in your account or organization (see [GitHub App](#github-app)) and
   install it on the repositories you want reviewed.
2. **Add the secrets** to each repository: the App's `MYRABBIT_APP_CLIENT_ID` and
   `MYRABBIT_APP_PRIVATE_KEY`, plus exactly one credential per engine you run (see
   [Engine credentials](#engine-credentials)).
3. **Copy an example caller** into the repository as `.github/workflows/customrabbit.yml`:
   - [`examples/caller.yml`](examples/caller.yml): a GitHub-hosted runner (`ubuntu-latest`),
     `isolation: none`, Claude only, with an Anthropic API key;
   - [`examples/self-hosted.yml`](examples/self-hosted.yml): your own Linux runner, both engines,
     guest-user isolation;
   - [`examples/wtr.yml`](examples/wtr.yml): an optional profile for a WTR host (ephemeral-VM
     runners selected by three labels).
4. **Pin a release.** Replace the all-zero SHA in `uses:` with a release SHA from this
   repository's releases (see [Releases](#releases)). Never pin a branch.
5. Set `trusted-authors` to the logins whose PRs may be reviewed, open a PR, and make the
   `customrabbit / review` check required once you're happy with it.

A minimal caller job:

```yaml
jobs:
  customrabbit:
    if: >-
      !endsWith(github.actor, '[bot]') && (
        github.event_name == 'workflow_dispatch' || (
          github.event.pull_request.head.repo.full_name == github.repository &&
          !endsWith(github.event.pull_request.user.login, '[bot]')))
    permissions:
      contents: read
    uses: dlled/customrabbit/.github/workflows/review.yml@<release-sha>
    with:
      runs-on: '["ubuntu-latest"]'
      trusted-authors: alice,bob
      isolation: none
      engines: claude
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      MYRABBIT_APP_CLIENT_ID: ${{ secrets.MYRABBIT_APP_CLIENT_ID }}
      MYRABBIT_APP_PRIVATE_KEY: ${{ secrets.MYRABBIT_APP_PRIVATE_KEY }}
```

## Inputs

`.github/workflows/review.yml` (the reusable workflow):

| Input | Required | Default | Meaning |
|---|---|---|---|
| `runs-on` | **yes** | — | JSON list of runner labels, e.g. `'["ubuntu-latest"]'` or `'["self-hosted","linux","x64"]'`. There is no default and no fallback runner. |
| `trusted-authors` | **yes** | — | Comma-separated GitHub logins. A PR by anyone else is skipped without a model call. |
| `engines` | no | `both` | `both`, `claude` or `codex`. A repository's `.myrabbit.yaml` can still disable an engine. |
| `isolation` | no | `guest-users` | `guest-users` or `none` (see [Isolation](#isolation)). |
| `pr` | no | `0` | The PR number for a `workflow_dispatch` run; `0` takes the PR from the `pull_request` event. |

Values are matched exactly, so `" none"` or `None` is an error, not a fallback.

| Secret | Required | |
|---|---|---|
| `MYRABBIT_APP_CLIENT_ID` | yes | The GitHub App's Client ID. |
| `MYRABBIT_APP_PRIVATE_KEY` | yes | The App's private key (`.pem`). |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | one, if Claude runs | See below. |
| `CODEX_AUTH_JSON` / `OPENAI_API_KEY` | one, if Codex runs | See below. |

## Engine credentials

Each selected engine needs **exactly one** credential:

| Engine | Subscription | API key |
|---|---|---|
| Claude | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) | `ANTHROPIC_API_KEY` |
| Codex | `CODEX_AUTH_JSON` (an access-token-only `auth.json`, see [Codex subscription credential](#codex-subscription-credential)) | `OPENAI_API_KEY` |

- If both credentials of one engine are set, the run fails before any model call, for example
  with "both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; pass exactly one". customrabbit
  never picks one for you, so a repository can't switch between subscription and API billing
  without anyone noticing.
- A selected engine with no credential is also an error.
- Each credential reaches only its own engine. `ANTHROPIC_API_KEY` goes into the Claude CLI's
  allowlisted environment. `OPENAI_API_KEY` goes on stdin to `codex login --with-api-key`, which
  stores it in a fresh `CODEX_HOME` (file storage, never a keyring).
- No credential ever goes on a command line or into a log. Logs and posted reviews are redacted.

## Isolation

**`guest-users`** (the default) runs each engine CLI as its own unprivileged user,
`myrabbit-claude` and `myrabbit-codex`, and the static-analysis tools as `myrabbit-tools`.
- The engine users get read-only ACLs on the checkout and on the action, and traverse-only access
  to their parent directories. Everything else the runner user owns along those paths gets an
  explicit deny: the runner's `.runner` and `.credentials*` files, `_diag`, other actions,
  dotfiles and `$RUNNER_TEMP`. Before any credential exists, the job checks as each guest user
  that all of it is unreadable.
- The tools user gets nothing in the runner's tree; it only reads the staging directories
  customrabbit creates.
- It needs passwordless `sudo` and the `acl` package on the runner, and fails closed without them.
  Use an ephemeral runner (one job per machine) if you can.

**`none`** skips the guest users, the ACL setup and the sudo checks. The engine CLI and the tools
run as the runner user, each with a fresh temporary HOME and the same allowlisted environment, and
the job prints a `::warning::`.
- In this mode they **can read everything the runner user can**: the checkout, `$RUNNER_TEMP`, the
  runner's own files, and the engine's own model credential.
- **Prompt injection in PR or issue content could get the engine to leak its credential in the
  posted review.** Use `none` only with a credential you can afford to rotate, on a runner whose
  user holds nothing else of value, such as a GitHub-hosted runner.
- `none` allows **one engine only**: set `engines` to `claude` or `codex`. With both, the two
  engines would run as the same user and could read each other's credentials, so `isolation: none`
  with `engines: both` (the default) is an error before any model call.
- `review.yml` skips its `apt-get install` step, so the runner must already have `libatomic1`
  (GitHub-hosted Ubuntu runners do).
- `none` assumes the kernel restricts ptrace between processes, i.e. `kernel.yama.ptrace_scope` is
  1 or higher (the default on Ubuntu and GitHub-hosted runners). With 0, an engine could read the
  GitHub App token from the orchestrator's memory through `/proc/<pid>/mem`. Check with
  `cat /proc/sys/kernel/yama/ptrace_scope`.

In both modes the action passes the secrets to the orchestrator in a 0600 file, never in the
process environment (which a same-user process could read from `/proc`). The orchestrator reads
and deletes the file before it starts anything else.

## Security model

- **Who triggers a review.** Callers run on `pull_request` and `workflow_dispatch` only, never
  `pull_request_target` or `workflow_run`. The caller's `if:` skips PRs from forks and from bots,
  so a fork never gets the secrets or a runner. Inside the job, a PR whose author isn't in
  `trusted-authors` is skipped before any model call.
- **What the engines see.** The PR diff, the files of the checkout, the repository's
  `.myrabbit.yaml` and style guide from the base commit, and (if enabled) related issues. The
  engines are read-only reviewers: Claude gets only `Read`, `Grep` and `Glob`, Codex runs in its
  read-only sandbox, and only the orchestrator talks to GitHub.
- **What each engine can read.** Under `guest-users`: the checkout, the action, its own credential
  and nothing else of the runner's. Under `none`: everything the runner user can (see above).
- **Tokens.** `review.yml` mints a one-hour App installation token scoped to the calling
  repository only, with `pull-requests: write`, `contents: read` and `issues: read`. The job's
  `GITHUB_TOKEN` stays read-only. The checkout uses `persist-credentials: false`.
- **Supply chain.** Every action is pinned by full commit SHA, and callers pin `review.yml` by the
  SHA of a release. The action installs its dependencies with `npm ci --omit=dev --ignore-scripts`
  on every run and never uses a cache: a cache entry would live in the target repository's scope,
  where another job could plant a poisoned `node_modules`. Static-analysis tools are downloaded at
  pinned versions and checked against the checksums in `tools/tools.lock`.
- **Failure policy.** Exit `0` means a review was posted, the run was skipped, or the head moved.
  Exit `1` fails closed: no review is posted and the check goes red.

## GitHub App

Create an App with the webhook **inactive** and these repository permissions: Pull requests
**Read and write**, Contents **Read-only**, Issues **Read-only** (for related-issue suggestions),
Metadata Read-only. No other permissions and no events. Install it only on selected repositories.
The bot posts as `<your-app-slug>[bot]`.

## Configuration: `.myrabbit.yaml`

Optional, at the repository root, read from the PR's base commit. The JSON Schema is
[`schema/myrabbit.schema.json`](schema/myrabbit.schema.json); add
`# yaml-language-server: $schema=https://raw.githubusercontent.com/dlled/customrabbit/main/schema/myrabbit.schema.json`
for editor completion. The main keys:

| Key | Default | |
|---|---|---|
| `profile` | `chill` | `quiet`, `chill` or `assertive`: how much to comment. |
| `request_changes_threshold` | `major` | The lowest severity (`critical`, `major`, `minor`) that makes the verdict `REQUEST_CHANGES`. |
| `language`, `tone_instructions` | `en-US`, `""` | Review language and extra tone guidance. |
| `style_guide` | `auto: true` | With `auto`, every `AGENTS.md`, `CLAUDE.md` and `.claude/rules/**/*.md` applies to its directory; `files` adds more. |
| `path_filters`, `path_instructions` | `[]` | Globs to skip (`!docs/**`) and per-path instructions. |
| `auto_review` | enabled, no drafts | `ignore_title_keywords` (`WIP`, `[skip review]`) and `labels` (`!no-myrabbit` skips). |
| `engines` | both enabled | Per engine: `enabled`, `model`, `effort`, plus Claude's `max_turns` and `max_budget_usd`; `timeout_minutes`. |
| `limits` | 150 files, 400 kB diff, 15 inline comments | Larger PRs are reviewed in part, and the review says so. |
| `context`, `rule_packs`, `learnings`, `walkthrough`, `pre_merge_checks`, `labels`, `tools` | off | Cross-file context, language rule packs, repository learnings, walkthrough extras, title/description/docstring/linked-issue checks, labels, and pinned static-analysis tools (shellcheck, actionlint, hadolint, zizmor, ruff, yamllint, squawk, gitleaks). |

Example:

```yaml
version: 1
profile: chill
request_changes_threshold: major
path_filters: ["!dist/**"]
path_instructions:
  - path: "src/**/*.ts"
    instructions: "Prefer explicit return types."
tools:
  enabled: true
```

Labels are read on every run: `myrabbit:ignore-checks` stops failed pre-merge checks from
blocking, and `auto_review.labels` can skip a PR. The caller's `pull_request` trigger includes
`labeled` and `unlabeled` for that reason.

## Codex subscription credential

`CODEX_AUTH_JSON` is an `auth.json` holding only a ChatGPT **access token**, with an empty refresh
token: a runner never receives a refresh token. `scripts/codex-auth-refresh.sh` keeps a dedicated
Codex login in its own `CODEX_HOME` on a machine you control, forces a refresh, checks that the
new access token is valid for at least one more hour, and publishes the derived JSON to each
listed repository with `gh secret set` (over stdin, never printed):

```sh
mkdir -p ~/.config/myrabbit/codex
CODEX_HOME=~/.config/myrabbit/codex codex login         # a ChatGPT login dedicated to this
printf 'owner/repo\n' > ~/.config/myrabbit/repos.txt    # one owner/name per line
scripts/codex-auth-refresh.sh --dry-run                 # fake-valued shape and target repos only
scripts/codex-auth-refresh.sh                           # refresh and publish
```

Run it on a schedule (cron, a systemd timer or a launchd agent) more often than the access token
expires, for example every 6 hours. With `OPENAI_API_KEY` instead, none of this is needed.

## Releases

A commit can't contain its own SHA, so a release takes two commits:

```sh
scripts/release.sh prepare [<code-sha>] [--dry-run]   # default: origin/main
scripts/release.sh pin <pr-number>                    # after that PR is merged
```

- Code commit **A** must already be on `origin/main` and contain `action.yml` and `dist/`.
- `prepare` creates release commit **B** on `release/<A>`, which changes only the
  `# myrabbit-action-pin` line of `review.yml` to `uses: dlled/customrabbit@A`, pushes that
  branch and opens a PR. It never pushes `main`.
- `pin` verifies the merged release commit and prints the SHA callers pin:
  `uses: dlled/customrabbit/.github/workflows/review.yml@<that sha>`.
- The repository is taken from `origin` (or `MYRABBIT_REPO_SLUG=owner/name`), so a fork can cut
  its own releases.

Before the first release the pin is all zeros on purpose: an unreleased `review.yml` fails loudly.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test && npm run build
git diff --exit-code -- dist/     # dist/ is committed; it must match a fresh build
```

`dist/` is committed because the action runs it without a build step. A PR that changes `src/`
commits the rebuilt bundle with it, never a hand edit. `actionlint .github/workflows/*.yml
examples/*.yml` picks up `.github/actionlint.yaml`, which declares the `wtr-ci` label.

| Path | What |
|---|---|
| `action.yml` | Composite action: `npm ci` → guest users → `node dist/main.js` |
| `.github/workflows/review.yml` | The reusable workflow callers pin |
| `.github/workflows/ci.yml` | This repository's CI (lint, typecheck, test, build, dist freshness) on WTR labels, dispatch-only |
| `examples/` | Caller workflows |
| `src/`, `bin/`, `dist/` | Orchestrator, engine and tool wrappers, committed bundle |
| `schema/` | JSON Schema for `.myrabbit.yaml` |
| `tools/` | Pinned static-analysis tools and their configs |
| `scripts/` | Releases, the Codex credential refresher, the guest-ACL container test |

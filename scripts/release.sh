#!/usr/bin/env bash
# Two-commit release of myrabbit (design.md §10.3). A commit can't contain its own SHA, so:
#   A = a reviewed code commit already on origin/main (action.yml + dist/)
#   B = a release commit that only sets `uses: <owner>/<repo>@A` in .github/workflows/review.yml
# Callers pin review.yml at B as merged on main. This script never pushes to main: it pushes a
# release/<A> branch and opens a PR; after that PR is merged, `pin` prints the SHA to pin.
#
#   scripts/release.sh prepare [A] [--dry-run]   A defaults to origin/main
#   scripts/release.sh pin <pr-number>           after merge: verify and print the caller SHA
#
# The repository is MYRABBIT_REPO_SLUG (owner/name) if set, else the GitHub repo of `origin`.
set -euo pipefail

workflow=".github/workflows/review.yml"

die() { echo "release: $*" >&2; exit 1; }
usage() { sed -n '2,11p' "$0" >&2; exit 64; }

root="$(git rev-parse --show-toplevel)"
cd "$root"

# owner/name from an origin URL: https://github.com/o/n(.git), git@github.com:o/n(.git), ssh://git@github.com/o/n
slug_from_url() {
  local url="$1"
  url="${url%/}"
  url="${url%.git}"
  [[ "$url" =~ ^(https://|ssh://git@|git@)github\.com[:/]([^/]+/[^/]+)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]}"
}
if [[ -n "${MYRABBIT_REPO_SLUG:-}" ]]; then
  repo_slug="$MYRABBIT_REPO_SLUG"
else
  origin_url="$(git remote get-url origin 2>/dev/null)" || die "no origin remote; set MYRABBIT_REPO_SLUG=owner/name"
  repo_slug="$(slug_from_url "$origin_url")" || die "origin is not a github.com repository: set MYRABBIT_REPO_SLUG=owner/name"
fi
[[ "$repo_slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid repository slug: $repo_slug"
# The slug inside an extended regex: `.` is its only special character allowed above.
slug_re="${repo_slug//./\\.}"
pin_re="^( *- uses: ${slug_re}@)[0-9a-f]{40}( # myrabbit-action-pin)\$"

tmp="" # temporary worktree of prepare, removed on exit
cleanup_tmp() {
  if [[ -n "$tmp" ]]; then
    git worktree remove --force "$tmp" >/dev/null 2>&1 || true
    rm -rf "$tmp"
  fi
}

prepare() {
  local ref="origin/main" dry_run=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      -*) usage ;;
      *) ref="$arg" ;;
    esac
  done

  git fetch --quiet origin main
  local a
  a="$(git rev-parse --verify --quiet "${ref}^{commit}")" || die "unknown commit: $ref"
  git merge-base --is-ancestor "$a" origin/main || die "$a is not on origin/main: release only reviewed, merged code"
  for f in action.yml dist/main.js dist/tools-install.js package-lock.json; do
    git cat-file -e "$a:$f" 2>/dev/null || die "$a has no $f"
  done
  git show "origin/main:$workflow" | grep -Eq "$pin_re" || die "$workflow on origin/main has no '# myrabbit-action-pin' line"
  if git show "origin/main:$workflow" | grep -Eq "${slug_re}@$a "; then
    die "origin/main already pins $a"
  fi

  local short="${a:0:12}" branch="release/${a:0:12}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/myrabbit-release.XXXXXX")"
  trap cleanup_tmp EXIT
  git worktree add --quiet --detach "$tmp" origin/main

  # `|` as the delimiter: the pattern contains `/`.
  sed -E -i.bak "s|$pin_re|\\1$a\\2|" "$tmp/$workflow"
  rm -f "$tmp/$workflow.bak"
  [[ "$(git -C "$tmp" diff --numstat | wc -l | tr -d ' ')" == "1" ]] || die "unexpected diff while pinning"
  grep -Eq "${slug_re}@$a # myrabbit-action-pin" "$tmp/$workflow" || die "pin was not written"

  git -C "$tmp" switch --quiet -c "$branch"
  git -C "$tmp" commit --quiet -m "release: pin action to $short" -m "Release commit B for code commit $a (two-commit release, design.md §10.3)." -- "$workflow"
  local b
  b="$(git -C "$tmp" rev-parse HEAD)"
  echo "release commit $b on $branch pins $repo_slug@$a"
  git -C "$tmp" show --stat --format='%h %s' HEAD

  if (( dry_run )); then
    echo "dry run: not pushed; branch $branch kept locally"
    return
  fi
  [[ "$branch" != "main" ]] || die "refusing to push main"
  git -C "$tmp" push --quiet origin "$branch:refs/heads/$branch"
  gh pr create --repo "$repo_slug" --base main --head "$branch" \
    --title "release: pin action to $short" \
    --body "Release commit for code commit \`$a\` (design.md §10.3, two-commit release).

Only \`$workflow\` changes: \`uses: $repo_slug@$a\`.

After merge, run \`scripts/release.sh pin <this PR number>\` to get the SHA callers pin."
}

pin() {
  local pr="${1:-}"
  [[ "$pr" =~ ^[0-9]+$ ]] || usage
  local state merge
  state="$(gh pr view "$pr" --repo "$repo_slug" --json state --jq .state)"
  [[ "$state" == "MERGED" ]] || die "PR #$pr is $state, not MERGED"
  merge="$(gh pr view "$pr" --repo "$repo_slug" --json mergeCommit --jq .mergeCommit.oid)"
  [[ "$merge" =~ ^[0-9a-f]{40}$ ]] || die "PR #$pr has no merge commit"
  git fetch --quiet origin main
  git merge-base --is-ancestor "$merge" origin/main || die "$merge is not on origin/main"
  local line action
  line="$(git show "$merge:$workflow" | grep -E "$pin_re")" || die "$merge has no pin line"
  action="$(grep -Eo '@[0-9a-f]{40}' <<<"$line" | tr -d @)"
  [[ "$action" != "0000000000000000000000000000000000000000" ]] || die "$merge still has the unreleased all-zero pin"
  for f in dist/main.js dist/tools-install.js; do
    git cat-file -e "$action:$f" 2>/dev/null || die "pinned action $action has no $f"
  done
  cat <<EOF
release SHA (pin this in callers): $merge
action code commit:                $action

  uses: $repo_slug/.github/workflows/review.yml@$merge

Optional tag (points at the release commit):
  git tag -a vX.Y.Z $merge -m "myrabbit vX.Y.Z" && git push origin vX.Y.Z
EOF
}

case "${1:-}" in
  prepare) shift; prepare "$@" ;;
  pin) shift; pin "$@" ;;
  *) usage ;;
esac

#!/usr/bin/env bash
# Refreshes myrabbit's dedicated Codex login and publishes the access-token-only CODEX_AUTH_JSON
# secret to every enabled repository (design.md §9.1). Runs on the operator's Mac under a user LaunchAgent
# (examples/launchagent.plist), every 6 hours. Never on the WTR host, never in a job.
#
# It never prints a token: the derived JSON goes from node straight into `gh secret set` on stdin.
#
#   scripts/codex-auth-refresh.sh            refresh + publish
#   scripts/codex-auth-refresh.sh --dry-run  no refresh, no gh: print the JSON shape with fake values
#                                            and the repositories that would be updated
#
# Environment (all optional):
#   MYRABBIT_CODEX_HOME  dedicated login           default ~/.config/myrabbit/codex
#   MYRABBIT_REPOS_FILE  one owner/name per line   default ~/.config/myrabbit/repos.txt (# comments)
#   CODEX_BIN, GH_BIN, NODE_BIN                    default codex, gh, node from PATH
set -euo pipefail
umask 077

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 64 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/codex-auth.mjs"
codex_home="${MYRABBIT_CODEX_HOME:-$HOME/.config/myrabbit/codex}"
repos_file="${MYRABBIT_REPOS_FILE:-$HOME/.config/myrabbit/repos.txt}"
node_bin="${NODE_BIN:-node}"
gh_bin="${GH_BIN:-gh}"
export CODEX_BIN="${CODEX_BIN:-codex}"

log() { printf '%s codex-auth-refresh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ -f "$codex_home/auth.json" ]] || die "no login at $codex_home/auth.json (run: CODEX_HOME=$codex_home codex login)"
[[ "$codex_home" != "$HOME/.codex" ]] || die "refusing to use the everyday login ~/.codex; use a dedicated CODEX_HOME"
[[ -f "$repos_file" ]] || die "repository list $repos_file not found"

repos=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "bad repository name in $repos_file: $line"
  repos+=("$line")
done < "$repos_file"
(( ${#repos[@]} > 0 )) || die "no repositories in $repos_file"

if (( dry_run )); then
  log "dry run: no refresh, no secrets written"
  "$node_bin" "$helper" shape "$codex_home/auth.json"
  for r in "${repos[@]}"; do log "would run: gh secret set CODEX_AUTH_JSON --repo $r"; done
  exit 0
fi

# One run at a time: a second refresh would rotate the refresh token under the first.
# The lock holds the owner's PID. A lock left by a crash, SIGKILL or reboot (dead PID, or older
# than an hour) is broken, so it can't block later LaunchAgent runs.
lock_dir="${MYRABBIT_LOCK_DIR:-${TMPDIR:-/tmp}/myrabbit-codex-auth-refresh.lock}"
take_lock() { mkdir "$lock_dir" 2>/dev/null && echo "$$" > "$lock_dir/pid"; }
if ! take_lock; then
  owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  stale_age="$(find "$lock_dir" -maxdepth 0 -mmin +60 2>/dev/null || true)"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null && [[ -z "$stale_age" ]]; then
    die "another refresh is running (pid $owner, $lock_dir)"
  fi
  log "breaking stale lock (pid ${owner:-unknown})"
  rm -rf "$lock_dir"
  take_lock || die "cannot take lock $lock_dir"
fi
trap 'rm -rf "$lock_dir"' EXIT

CODEX_HOME="$codex_home" "$node_bin" "$helper" refresh

# The secret lives only in this shell variable and the gh stdin pipe (printf is a builtin, so it
# never appears on a command line).
derived="$("$node_bin" "$helper" derive "$codex_home/auth.json")"
failed=0
for r in "${repos[@]}"; do
  if printf '%s' "$derived" | "$gh_bin" secret set CODEX_AUTH_JSON --repo "$r" >/dev/null; then
    log "updated CODEX_AUTH_JSON on $r"
  else
    log "ERROR: gh secret set failed for $r"
    failed=1
  fi
done
unset derived
exit "$failed"

#!/usr/bin/env bash
# Runs inside ubuntu:24.04 (see scripts/test-guest-acl.sh): simulates a WTR guest runner layout,
# runs action.yml's guest-user step, then probes as each guest user. Exit 0 = no leak, no block.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq sudo acl >/dev/null
useradd --create-home --shell /bin/bash runner
chmod 0750 /home/runner
echo 'runner ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/runner
R=/home/runner/actions-runner
sudo -u runner bash -c "
  umask 022
  mkdir -p $R/_diag $R/_work/_temp $R/_work/repo/repo/src $R/_work/_tool/node/bin \
    $R/_work/_actions/dlled/customrabbit/abc/dist $R/_work/_actions/dlled/customrabbit/abc/node_modules/pkg \
    $R/_work/_actions/actions/checkout/v7
  echo secret > $R/.credentials; echo secret > $R/.runner; echo log > $R/_diag/Worker.log
  echo rc > /home/runner/.bashrc; echo tmp > $R/_work/_temp/event.json
  echo code > $R/_work/repo/repo/src/a.ts; echo main > $R/_work/_actions/dlled/customrabbit/abc/dist/main.js
  echo pkg > $R/_work/_actions/dlled/customrabbit/abc/node_modules/pkg/index.js
  echo other > $R/_work/_actions/actions/checkout/v7/action.yml
  ln -s /etc/hostname $R/link
"
cd /tmp
sudo -u runner env HOME=/home/runner GITHUB_WORKSPACE=$R/_work/repo/repo \
  GITHUB_ACTION_PATH=$R/_work/_actions/dlled/customrabbit/abc RUNNER_TEMP=$R/_work/_temp \
  bash /step/guest-step.sh
echo "--- step exited 0; probing as guests"
# Entries created after the step inherit the deny (default ACL).
sudo -u runner bash -c "echo later > $R/_diag/Later.log; echo later > $R/.credentials_rsaparams"
fail=0
for u in myrabbit-claude myrabbit-codex; do
  for p in $R/.credentials $R/.runner $R/_diag/Worker.log $R/_diag/Later.log $R/.credentials_rsaparams \
           /home/runner/.bashrc $R/_work/_temp/event.json $R/_work/_actions/actions/checkout/v7/action.yml; do
    if sudo -u $u cat "$p" >/dev/null 2>&1; then echo "LEAK $u $p"; fail=1; fi
  done
  for p in $R/_work/repo/repo/src/a.ts $R/_work/_actions/dlled/customrabbit/abc/dist/main.js \
           $R/_work/_actions/dlled/customrabbit/abc/node_modules/pkg/index.js; do
    sudo -u $u cat "$p" >/dev/null || { echo "BLOCKED $u $p"; fail=1; }
  done
  sudo -u $u ls $R/_work/repo/repo >/dev/null || { echo "cannot list workspace $u"; fail=1; }
done
# W6a: CODEX_HOME = mkdtemp 0700 under /tmp, chowned to myrabbit-codex.
d=$(sudo -u runner mktemp -d /tmp/myrabbit-codex-XXXX); sudo -u runner bash -c "echo '{}' > $d/auth.json; chmod 600 $d/auth.json"
chown -R myrabbit-codex "$d"
sudo -u myrabbit-codex cat "$d/auth.json" >/dev/null || { echo "codex cannot read CODEX_HOME"; fail=1; }
sudo -u myrabbit-claude cat "$d/auth.json" >/dev/null 2>&1 && { echo "claude reads CODEX_HOME"; fail=1; }
# Idempotent: a second run (e.g. rerun in same VM) also succeeds.
sudo -u runner env HOME=/home/runner GITHUB_WORKSPACE=$R/_work/repo/repo \
  GITHUB_ACTION_PATH=$R/_work/_actions/dlled/customrabbit/abc RUNNER_TEMP=$R/_work/_temp \
  bash /step/guest-step.sh >/dev/null

# --- design-v2 §7.3: myrabbit-tools ------------------------------------------------------------
STEP_ENV=(env HOME=/home/runner GITHUB_WORKSPACE=$R/_work/repo/repo
  GITHUB_ACTION_PATH=$R/_work/_actions/dlled/customrabbit/abc RUNNER_TEMP=$R/_work/_temp)
sudo -u runner "${STEP_ENV[@]}" bash /step/tools-step.sh
sudo -u runner "${STEP_ENV[@]}" bash /step/tools-step.sh >/dev/null # idempotent
echo "--- tools step exited 0; probing as myrabbit-tools"
for p in $R/.credentials $R/.runner $R/_diag/Worker.log /home/runner/.bashrc $R/_work/_temp/event.json \
         $R/_work/repo/repo/src/a.ts $R/_work/_actions/dlled/customrabbit/abc/dist/main.js \
         $R/_work/_actions/dlled/customrabbit/abc/node_modules/pkg/index.js; do
  if sudo -u myrabbit-tools cat "$p" >/dev/null 2>&1; then echo "LEAK myrabbit-tools $p"; fail=1; fi
done
sudo -u myrabbit-tools ls $R/_work/repo/repo >/dev/null 2>&1 && { echo "myrabbit-tools lists the workspace"; fail=1; }

# A tool dir and a staging dir as src/tools creates them: runner-owned mkdtemp under /tmp, 0755.
# bin/as-tools needs to live where the runner user can run it.
install -m 0755 /myrabbit-bin/as-tools /usr/local/bin/as-tools
tools=$(sudo -u runner mktemp -d /tmp/myrabbit-tools-XXXX)
stage=$(sudo -u runner mktemp -d /tmp/myrabbit-stage-XXXX)
sudo -u runner bash -c "
  chmod 0755 $tools $stage; mkdir -m 0755 $tools/bin $tools/cwd
  printf '#!/bin/sh\necho real\n' > $tools/bin/other; chmod 0755 $tools/bin/other
  echo 'x=1' > $stage/a.sh; chmod 0644 $stage/a.sh
  # An exploited tool: tries to replace another tool, write into staging, read runner secrets.
  cat > $tools/bin/evil <<'EOF'
#!/bin/sh
echo pwned > \"\$1/bin/other\" 2>/dev/null && echo WROTE-TOOL
echo pwned > \"\$2/a.sh\" 2>/dev/null && echo WROTE-STAGE
touch \"\$1/new\" 2>/dev/null && echo CREATED-IN-TOOLS
cat \"\$3\" 2>/dev/null && echo READ-SECRET
env
EOF
  chmod 0755 $tools/bin/evil
"
out=$(cd "$tools/cwd" && sudo -u runner env -i PATH=/usr/bin:/bin MYRABBIT_SECRET=leak /usr/local/bin/as-tools \
  "$tools/bin/evil" "$tools" "$stage" "$R/.credentials")
echo "$out" | grep -E 'WROTE-|CREATED-|READ-SECRET|MYRABBIT_SECRET|^SUDO_' && { echo "myrabbit-tools escaped"; fail=1; }
envkeys=$(echo "$out" | sed -n 's/^\([A-Z_]*\)=.*/\1/p' | sort | tr '\n' ' ')
[[ "$envkeys" == "HOME LANG PATH PWD " || "$envkeys" == "HOME LANG PATH " ]] || { echo "tool env not minimal: $envkeys"; fail=1; }
echo "$out" | grep -qx 'HOME=/home/myrabbit-tools' || { echo "tool HOME is not its own"; fail=1; }
[[ "$(sudo -u runner /usr/local/bin/as-tools "$tools/bin/other")" == real ]] || { echo "as-tools cannot run a tool"; fail=1; }
sudo -u runner /usr/local/bin/as-tools relative/path >/dev/null 2>&1 && { echo "as-tools ran a relative path"; fail=1; }
# No tool process outlives its run (review of #46): a tool that leaves a child behind holding
# stdout, and one stuck past a timeout that the caller ends with --kill-all.
uid=$(id -u myrabbit-tools)
alive() { local n=0 f; for f in /proc/[0-9]*/status; do awk -v u="$uid" '/^Uid:/ && $2==u {f=1} END {exit !f}' "$f" 2>/dev/null && n=$((n+1)); done; echo $n; }
sudo -u runner bash -c "printf '#!/bin/sh\nsleep 300 &\necho done\n' > $tools/bin/stray; printf '#!/bin/sh\nsleep 300\n' > $tools/bin/stuck; chmod 0755 $tools/bin/stray $tools/bin/stuck"
[[ "$(timeout 20 sudo -u runner /usr/local/bin/as-tools "$tools/bin/stray")" == done ]] || { echo "as-tools hung on a stray child"; fail=1; }
[[ "$(alive)" == 0 ]] || { echo "a stray myrabbit-tools process survived its run"; fail=1; }
sudo -u runner /usr/local/bin/as-tools "$tools/bin/stuck" & stuck_pid=$!
sleep 1
[[ "$(alive)" -ge 1 ]] || { echo "stuck tool did not start"; fail=1; }
sudo -u runner /usr/local/bin/as-tools --kill-all
wait "$stuck_pid" 2>/dev/null || true
[[ "$(alive)" == 0 ]] || { echo "--kill-all left a myrabbit-tools process"; fail=1; }
# A tool that leaves a fork loop behind (P6b): children born while kill(-1) walks the process list
# must not survive the run.
sudo -u runner bash -c "printf '#!/bin/bash\n( while :; do sleep 300 & done ) &\nsleep 0.3\necho done\n' > $tools/bin/forker; chmod 0755 $tools/bin/forker"
for i in 1 2 3 4 5; do
  [[ "$(timeout 30 sudo -u runner /usr/local/bin/as-tools "$tools/bin/forker")" == done ]] || { echo "as-tools hung on a fork loop"; fail=1; }
  n=$(alive)
  [[ "$n" == 0 ]] || { echo "fork loop: $n myrabbit-tools process(es) survived run $i"; fail=1; sudo -u runner /usr/local/bin/as-tools --kill-all; }
done

# The engine users' rights are unchanged by the tools step.
sudo -u myrabbit-claude cat $R/_work/repo/repo/src/a.ts >/dev/null || { echo "BLOCKED myrabbit-claude after tools step"; fail=1; }
echo "fail=$fail"; exit $fail

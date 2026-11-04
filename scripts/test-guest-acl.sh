#!/usr/bin/env bash
# Local check of action.yml's "Create engine guest users" step (design.md §9.2) and "Create
# static-analysis guest user" step (design-v2 §7.3, with bin/as-tools) in a throwaway
# ubuntu:24.04 container that mimics the WTR guest's runner layout. Needs Docker; touches nothing
# outside the container. Not part of `npm test` (no Docker in the offline suite).
#
#   scripts/test-guest-acl.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
step_dir="$(mktemp -d "${TMPDIR:-/tmp}/myrabbit-guest-acl.XXXXXX")"
trap 'rm -rf "$step_dir"' EXIT
cd "$root" # node resolves the yaml package from here

# Extract the steps' scripts from action.yml exactly as the runner would run them.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { parse } from "yaml";
  const action = parse(readFileSync(process.argv[1], "utf8"));
  const steps = { "Create engine guest users": "guest-step.sh", "Create static-analysis guest user": "tools-step.sh" };
  for (const [name, file] of Object.entries(steps)) {
    const step = action.runs.steps.find((s) => s.name === name);
    if (!step) throw new Error(`step not found in action.yml: ${name}`);
    writeFileSync(`${process.argv[2]}/${file}`, step.run);
  }
' "$root/action.yml" "$step_dir"

docker run --rm --platform linux/amd64 \
  -v "$step_dir:/step:ro" -v "$root/scripts/guest-acl:/harness:ro" -v "$root/bin:/myrabbit-bin:ro" \
  ubuntu:24.04 bash /harness/in-container.sh

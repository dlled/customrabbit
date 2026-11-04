**myrabbit: APPROVE** — 0 blocking · 0 non-blocking · reviewed by claude+codex

Adds a config loader and wires it into the CLI. Defaults are applied when the file is missing.

<details><summary>Changes (3 files)</summary>

| Area | Files | Summary |
|---|---|---|
| Config | `src/config.ts`<br>`src/defaults.ts` | New loader with zod validation |
| CLI | `src/app.ts` | Calls the loader at startup |

</details>

<details><summary>Review info</summary>

- **Mode:** full · range `bbbbbbb..aaaaaaa`
- **Profile:** chill · **threshold:** major
- **Engine** `claude` (claude-opus-5-5): ok in 3m 12s, $1.23
- **Engine** `codex`: ok in 4m 02s, n/a
- **Files:** 3 reviewed · 1 filtered · 0 binary · 0 over limit
- **Not reviewed (1):**
  - `package-lock.json` — filtered by `!**/package-lock.json`
- **Inline comments:** 0 (max 15)
- **Findings dropped by validation:** 0
- **Threads addressed in this run:** 0
- **Run:** https://github.com/dlled/example/actions/runs/123456789
- **Versions:** config `c0ffee000001` · prompt `p1a2b3c` · merge `m1`

</details>

<!-- myrabbit:state v=1 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb mode=full config=c0ffee000001 prompt=p1a2b3c -->
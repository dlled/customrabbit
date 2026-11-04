**myrabbit: REQUEST_CHANGES** — 5 blocking (2 critical, 3 major) · 3 non-blocking · reviewed by claude only (codex failed: timeout)

> This PR changes `.myrabbit.yaml`; config changes take effect after merge.

Adds a config loader and wires it into the CLI. Defaults are applied when the file is missing.

<details><summary>Changes (6 files)</summary>

| Area | Files | Summary |
|---|---|---|
| Config | `src/config.ts`<br>`src/defaults.ts` | New loader with zod validation |
| CLI | `src/app.ts` | Calls the loader at startup |

</details>

### Blocking

- **[critical · security]** SQL query built from request input — [`src/db.ts:40-42`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/db.ts#L40-L42) · details below
- **[critical · correctness]** Migration drops a column that the old code still reads — [`db/schema.sql:3`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/db/schema.sql#L3) · outside diff · unverified (budget) · details below
- **[major · reliability]** Review incomplete: 4 files not reviewed (limit 150). Split the PR or raise `limits` on the base branch. · details below
- **[major · reliability]** Retry loop never gives up — [`src/net.ts:7`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/net.ts#L7) · unverified (budget) · details below
- **[major · security]** Token compared with == (timing leak) — [`src/auth.ts:21`](https://github.com/dlled/example/pull/7#discussion_r100) · still open from an earlier review

### Unverified (budget)

Reported by one engine only; the second check could not run (verification budget exhausted or the verifier failed). They block until fixed or resolved by a person, so a budget limit never turns into an approval.

- **[critical · correctness]** Migration drops a column that the old code still reads — [`db/schema.sql:3`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/db/schema.sql#L3) · outside diff · unverified (budget)
- **[major · reliability]** Retry loop never gives up — [`src/net.ts:7`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/net.ts#L7) · unverified (budget)

<details><summary>Blocking findings not posted inline (4)</summary>

- **[critical · security]** SQL query built from request input — [`src/db.ts:40-42`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/db.ts#L40-L42)

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by claude+codex · confidence 0.95</sub>

- **[critical · correctness]** Migration drops a column that the old code still reads — [`db/schema.sql:3`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/db/schema.sql#L3) · outside diff · unverified (budget)

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by claude · confidence 0.60</sub>

- **[major · reliability]** Review incomplete: 4 files not reviewed (limit 150). Split the PR or raise `limits` on the base branch.

  Coverage is incomplete, so myrabbit does not approve unreviewed code.

  <sub>found by myrabbit · confidence 1.00</sub>

- **[major · reliability]** Retry loop never gives up — [`src/net.ts:7`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/net.ts#L7) · unverified (budget)

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by codex · confidence 0.70</sub>

</details>

### Dismissed by human

Blocking threads resolved by a person. They no longer block this PR; listed for audit.

- **[major · correctness]** Off-by-one in pagination — [`src/legacy.ts:9`](https://github.com/dlled/example/pull/7#discussion_r101) · resolved by @​dlled

### Superseded

- **[minor · reliability]** Retry has no backoff — [`src/net.ts:7`](https://github.com/dlled/example/pull/7#discussion_r102) · superseded by **[major · reliability]** Retry loop never gives up — [`src/net.ts:7`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/net.ts#L7)
- **[minor · style]** Old thread whose successor is unknown — [`src/old.ts:1`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/old.ts#L1) · superseded by a new finding (`0000000000ff`)

<details><summary>Non-blocking findings not posted inline (3)</summary>

- **[major · testing]** No test covers the new error branch — [`src/app.ts:55`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/app.ts#L55) · unconfirmed

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by claude · confidence 0.50</sub>

- **[minor · maintainability]** Duplicate helper; reuse `toSlug` from utils — [`src/util/slug.ts:4`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/util/slug.ts#L4)

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by claude+codex · confidence 0.70</sub>

- **[trivial · docs]** Typo in README heading — [`README.md:1`](https://github.com/dlled/example/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/README.md#L1)

  `parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

  **Fails when:** calling load() twice → the second call sees stale defaults

  <sub>found by claude+codex · confidence 0.90</sub>

</details>

<details><summary>Review info</summary>

- **Mode:** incremental · range `ddddddd..aaaaaaa`
- **Profile:** chill · **threshold:** major
- **Engine** `claude` (claude-opus-5-5): ok in 3m 12s, $1.23
- **Engine** `codex`: failed (timeout) after 12m 00s
- **Files:** 6 reviewed · 2 filtered · 1 binary · 4 over limit
- **Not reviewed (7):**
  - `dist/main.js` — filtered by `!dist/**`
  - `docs/notes.txt` — not in path_filters allowlist
  - `img/logo.png` — binary
  - `gen/a.ts` — over limit
  - `gen/b.ts` — over limit
  - `gen/c.ts` — over limit
  - `gen/d.ts` — over limit
- **Inline comments:** 0 (max 15)
- **Findings dropped by validation:** 1
- **Threads addressed in this run:** 2
- **Run:** https://github.com/dlled/example/actions/runs/123456789
- **Versions:** config `c0ffee000001` · prompt `p1a2b3c` · merge `m1`
- **Config warnings** (defaults used):
  - limits.max_files: expected number, received string

</details>

<!-- myrabbit:state v=1 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb mode=incremental config=c0ffee000001 prompt=p1a2b3c -->
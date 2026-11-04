**[minor · maintainability]** Return value of parse() is ignored

`parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

**Fails when:** calling load() twice → the second call sees stale defaults

<sub>found by codex · confidence 0.60</sub>
<!-- myrabbit:f v=1 fp=000000000001 sev=minor blk=0 -->
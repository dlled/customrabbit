**[major · correctness]** Return value of parse() is ignored

`parse()` returns a new object; the caller keeps using the old one, so config edits are lost.

**Fails when:** calling load() twice → the second call sees stale defaults

**Rule:** "Never ignore return values of pure functions" (AGENTS.md)

```suggestion
const cfg = parse(raw);
return cfg;
```

<sub>found by claude+codex · confidence 0.82 · blocking</sub>
<!-- myrabbit:f v=1 fp=000000000001 sev=major blk=1 -->
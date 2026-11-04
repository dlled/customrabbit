## myrabbit · dlled/example#42 · REQUEST_CHANGES

**Posted review: REQUEST_CHANGES**

Mode: `full`

| Engine | Model | Status | Duration | Cost |
|---|---|---|---|---|
| claude | claude-opus-5-5 | ok | 3m 12s | $1.23 |
| codex | default | ok | 4m 02s | $0.50 |

Total cost: $1.73 · run time: 5m 00s

| Blocking | Non-blocking | Inline | Body only | Dismissed by human | Addressed |
|---|---|---|---|---|---|
| 1 | 2 | 2 | 1 | 0 | 1 |

<details><summary>Run document</summary>

````json
{
  "schema_version": "1",
  "run": {
    "prompt_version": "p1a2b3c",
    "merge_version": "m1",
    "sources": [
      "claude",
      "codex"
    ]
  },
  "verdict": "REQUEST_CHANGES",
  "findings": [
    {
      "path": "src/app.ts",
      "line": 10,
      "end_line": null,
      "side": "RIGHT",
      "severity": "major",
      "category": "correctness",
      "summary": "Return value of parse() is ignored",
      "body": "uses `x` in ```code```",
      "suggestion": null,
      "blocking": true,
      "sources": [
        "claude",
        "codex"
      ],
      "confidence": 0.82,
      "fingerprint": "000000000001",
      "status": "new",
      "outside_diff": false,
      "verification": "agreed",
      "synthetic": false,
      "failure_scenario": "calling load() twice → the second call sees stale defaults",
      "rule": null
    }
  ]
}
````

</details>

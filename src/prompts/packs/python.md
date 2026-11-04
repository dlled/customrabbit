# Python

Flag these only in code the diff adds or changes, and only with the failure it causes. This pack leaves lint-detectable patterns (`shell=True`, `pickle`, `yaml.load`, mutable defaults, bare `except`, naive `datetime`) to static analysis; these need data-flow reasoning a linter can't do.

- **path-escape**: an untrusted name joined to a base dir with `os.path.join` and opened. "If a segment is an absolute path … all previous segments are ignored" [1], and `..` walks out. A `startswith` or `commonprefix` check is not containment: `commonprefix` "works a character at a time" and "is not secure" [1]. Fix: `realpath` both, then `commonpath([base, p]) == base`.
- **timing-compare**: a MAC, signature, token or password hash compared with `==`. Use `hmac.compare_digest()` "instead of the `==` operator to reduce the vulnerability to timing attacks" [2]. Not: comparing non-secret ids.
- **float-money**: currency or other exact decimal amounts held in `float` and summed or compared: `0.1 + 0.1 + 0.1 == 0.3` is `False` [3]. Use `decimal.Decimal` ("suitable for accounting applications") [3] or integer minor units.
- **iterator-reuse**: a generator, `map`, `filter`, `zip` or file object iterated twice (or checked with `len`/truthiness then iterated). An exhausted iterator returns nothing on the second pass, "making it appear like an empty container" [4]. Fix: `list(...)` once.
- **falsy-default**: `x or default`, `if not x:` or `d.get(k) or default` where `0`, `0.0`, `''`, `[]` or `{}` is a valid value: those are false [5], so a real zero or empty value is replaced or treated as missing. Fix: compare with `is None`.
- **option-injection**: an untrusted value passed as an argument to `subprocess` (list form) for a command that parses options, without `--` before operands. A value starting with `-` becomes an option; `--` marks the end of options [6].

Sources:
[1] https://docs.python.org/3/library/os.path.html
[2] https://docs.python.org/3/library/hmac.html
[3] https://docs.python.org/3/tutorial/floatingpoint.html
[4] https://docs.python.org/3/glossary.html#term-iterator
[5] https://docs.python.org/3/library/stdtypes.html#truth-value-testing
[6] https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html (Guideline 10)

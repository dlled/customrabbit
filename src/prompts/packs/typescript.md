# TypeScript / JavaScript

Flag these only in code the diff adds or changes, and only with the failure it causes. No JS/TS linter runs in this review.

- **floating-promise**: a call that returns a Promise is neither awaited, returned, `.catch`ed nor explicitly `void`ed, so its rejection is unhandled and later code runs before it finishes ("improperly sequenced operations, ignored Promise rejections") [1]. Also an `async` callback passed where a void callback is expected (`forEach`, `addEventListener`, `setTimeout`): it "can lead to a floating unhandled Promise" [2]. Not: a `void`-prefixed call with a documented reason.
- **shell-injection**: request, CLI, env or file data reaches `child_process.exec`/`execSync`, or `spawn`/`execFile` with `shell: true`. "Any input containing shell metacharacters may be used to trigger arbitrary command execution" [3]. Fix: `execFile`/`spawn` with an argument array and no shell. Not: constant strings.
- **path-escape**: an untrusted name is joined to a base dir with `path.join`/`path.resolve` and opened without a containment check. `resolve` restarts at any absolute segment and `..` survives `join` normalisation, so the result can leave the base [4]. Fix: resolve, then check `path.relative(base, p)` does not start with `..` and is not absolute.
- **unchecked-cast**: `as T`, `as any`, `<T>` or a non-null `!` on data from `JSON.parse`, `fetch().json()`, env or a file, then used as `T`. "There is no runtime checking associated with a type assertion" [5], so a wrong shape fails later, far from the cause. Fix: validate (schema or type guard) at the boundary.
- **sql-concat**: SQL built with template literals or `+` from variables and passed to a driver. Bind values as parameters [6]. Table and column names cannot be parameters: map them through a fixed allow-list [6].

Sources:
[1] https://typescript-eslint.io/rules/no-floating-promises/
[2] https://typescript-eslint.io/rules/no-misused-promises/
[3] https://nodejs.org/api/child_process.html
[4] https://nodejs.org/api/path.html
[5] https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions
[6] https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

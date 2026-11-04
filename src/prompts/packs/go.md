# Go

Flag these only in code the diff adds or changes, and only with the failure it causes. No Go linter runs in this review.

- **discarded-error**: an error assigned to `_` or a call returning an error used as a statement. "Do not discard errors using `_` variables" [1]: the failure is silently ignored and later code runs on a zero value. Not: documented never-failing calls (`bytes.Buffer.Write`).
- **error-equality**: `err == ErrX` or a type switch on `err` where the error may be wrapped (`%w`, `errors.Join`). `errors.Is` "will succeed if err wraps" the target and `==` will not [2]; same for `errors.As` vs type assertion.
- **context-misuse**: a `context.Context` stored in a struct field, not the first parameter, `nil` passed as a Context, or `context.Background()`/`TODO()` created inside a request path that already has a ctx (cancellation and deadlines are lost) [3]. A `WithCancel`/`WithTimeout` whose cancel func is not called on every path "leaks the child and its children" [3].
- **goroutine-leak**: a goroutine with no clear exit: blocked on a send/receive nobody completes, or looping without a `ctx.Done()` case. "Goroutines can leak by blocking on channel sends or receives" [1].
- **in-band-error**: a new function signalling failure with a sentinel value (`-1`, `""`, `nil` slice) instead of an extra `ok` or `error` result; callers forget to check [1].
- **copied-value**: a value whose methods have pointer receivers (`bytes.Buffer`, a struct with a `sync.Mutex`) copied by value (assignment, value receiver, range variable, by-value parameter): "do not copy a value of type `T` if its methods are associated with the pointer type" [1]. The copy aliases internal state or splits the lock.
- **mixed-receivers**: a type gaining a method with a different receiver kind than its others. "Don't mix receiver types" [1]: value-receiver methods mutate a copy.

Sources:
[1] https://go.dev/wiki/CodeReviewComments
[2] https://pkg.go.dev/errors
[3] https://pkg.go.dev/context

# Rust

Flag these only in code the diff adds or changes, and only with the failure it causes. Clippy does not run in this review.

- **panic-on-input**: `unwrap()`, `expect()`, `[i]` indexing or `panic!` on a value that depends on input, I/O, parsing or the network, in library or server code. "When failure is expected, it's more appropriate to return a `Result`" [1]; a panic takes down the thread or process. A public function that can still panic needs a "Panics" doc section [2]. Not: tests, examples, or invariants proved just above.
- **undocumented-unsafe**: an `unsafe { }` block without a `// SAFETY:` comment saying why its contract holds, or a new `unsafe fn`/`unsafe trait` without a `# Safety` doc section listing the caller's obligations [3][2]. Also an `unsafe` block whose stated reason does not hold in the changed code.
- **blocking-in-async**: `std::fs`, `std::thread::sleep`, a blocking HTTP/DB client, or long CPU work inside an `async fn` or future on a Tokio runtime. It "may prevent the executor from driving other futures forward" [4]. Fix: `tokio::task::spawn_blocking` or the async API.
- **guard-across-await**: a `std::sync::Mutex`/`RwLock` guard alive across an `.await`. That "virtually never leads to correct concurrent code in practice as it can easily lead to deadlocks" [5]. Fix: drop the guard before awaiting, or use `tokio::sync::Mutex` if the lock must span the await. Not: a std mutex locked and released without awaiting (preferred) [5].
- **ffi-unwind**: an `extern "C"` function exported to foreign code that can panic: the panic aborts the process. A foreign exception (e.g. C++) entering Rust through a non-`-unwind` ABI is undefined behaviour [6]. Fix: `catch_unwind` at the boundary and return an error code, or `"C-unwind"` when unwinding is intended [6].
- **overflow**: arithmetic or `as` casts on input-derived sizes, lengths or money. Debug builds panic; release builds wrap silently, and "relying on integer overflow's wrapping behavior is considered an error" [7]. Fix: `checked_*`/`saturating_*` or `try_from`.

Sources:
[1] https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html
[2] https://rust-lang.github.io/api-guidelines/documentation.html (C-FAILURE)
[3] https://doc.rust-lang.org/std/keyword.unsafe.html
[4] https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html
[5] https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html
[6] https://doc.rust-lang.org/nomicon/ffi.html
[7] https://doc.rust-lang.org/book/ch03-02-data-types.html

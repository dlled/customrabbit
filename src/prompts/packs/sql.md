# SQL (PostgreSQL)

Flag these only in SQL the diff adds or changes, and only with the failure it causes. This pack leaves migration locking and breaking DDL (index creation, NOT NULL, type changes, renames, drops, constraints, timeouts, column types) to Squawk; these are query and function semantics it does not check.

- **null-equality**: `col = NULL` or `col <> NULL`. It yields null, never true, so the filter matches no rows: "Do *not* write `expression = NULL`"; use `IS [NOT] NULL` or `IS [NOT] DISTINCT FROM` [1].
- **not-in-null**: `x NOT IN (SELECT col …)` where `col` can be null. If any row is null "the result of the `NOT IN` construct will be null, not true", so the query returns nothing [2]. Fix: `NOT EXISTS`, or filter nulls in the subquery.
- **definer-search-path**: a `SECURITY DEFINER` function without `SET search_path` that excludes user-writable schemas and lists `pg_temp` last. Without it, any user can create a temp object that masks one the function uses and run it with the owner's privileges [3].
- **dynamic-sql**: `EXECUTE` (PL/pgSQL) on a string concatenated from parameters or variables. Pass values with `USING $1…` and identifiers through `format('%I')`/`quote_ident`; concatenation is open to SQL injection [4].
- **limit-without-order**: `LIMIT`/`OFFSET` (pagination, "pick one", batch loops) without an `ORDER BY` that gives a unique order. "Otherwise you will get an unpredictable subset of the query's rows", so pages skip or repeat rows [5].

Sources:
[1] https://www.postgresql.org/docs/current/functions-comparison.html
[2] https://www.postgresql.org/docs/current/functions-subquery.html
[3] https://www.postgresql.org/docs/current/sql-createfunction.html (Writing SECURITY DEFINER Functions Safely)
[4] https://www.postgresql.org/docs/current/plpgsql-statements.html (Executing Dynamic Commands)
[5] https://www.postgresql.org/docs/current/queries-limit.html

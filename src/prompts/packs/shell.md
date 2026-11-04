# Shell

Flag these only in code the diff adds or changes, and only with the failure it causes. This pack leaves quoting, globbing and syntax to ShellCheck; these are semantic failures it does not report by default.

- **errexit-ignored**: a script relies on `set -e` for a command that runs where errexit is off: in an `if`/`while` condition, in a `&&`/`||` list (except the last command), after `!`, or in any non-last pipeline stage. A function or compound command called in such a context runs its **whole body** with `-e` ignored [1]. Command substitution `$(…)` clears `-e` unless `inherit_errexit` or POSIX mode is on [1]. Failure: a failed step is skipped silently and the script continues.
- **pipeline-status**: a pipeline whose early stage can fail (`curl … | jq`, `make | tee log`, `grep … | sort`) used as a success check or under `set -e` without `set -o pipefail`. "The return status of a pipeline is the exit status of the last command, unless the pipefail option is enabled" [1]. Check `PIPESTATUS` right away if stages need separate handling [2].
- **predictable-temp**: a temp path built from a fixed name or `$$` (`/tmp/build.$$`). "This kind of naming scheme is predictable and the race condition it creates is easy for an attacker to win" [3]. Fix: `mktemp`/`mktemp -d`, removed by a `trap '…' EXIT` (the action "is executed on exit from the shell") [1][3]. Also flag a `mktemp` file with no cleanup on the error path.
- **eval-data**: `eval` (or `bash -c "$var"`, `source "$var"`) over values from arguments, env, files or command output. "`eval` should be avoided" [2]: the data runs as code.
- **option-injection**: an untrusted value passed to a command that parses options (`rm`, `cp`, `git`, `tar`, `grep`) without `--` before it. A value starting with `-` becomes an option; "the first `--` argument … should be accepted as a delimiter indicating the end of options" [4].

Sources:
[1] GNU Bash Reference Manual (bash(1) 5.3): Pipelines; The Set Builtin (`-e`, `pipefail`); Command Substitution; `inherit_errexit`; `trap`. https://www.gnu.org/software/bash/manual/bash.html
[2] https://google.github.io/styleguide/shellguide.html
[3] mktemp(1), BSD/macOS manual. https://man.freebsd.org/cgi/man.cgi?query=mktemp
[4] https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html (Guideline 10)

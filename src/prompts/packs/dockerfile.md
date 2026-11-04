# Dockerfile

Flag these only in Dockerfiles and entrypoint scripts the diff adds or changes. This pack leaves tags, `latest`, package pinning, `ADD` for local files, sensitive `ARG`/`ENV` names, JSON-form `CMD`/`ENTRYPOINT` and a final `USER root` to hadolint.

- **unpinned-digest**: a `FROM` (or `COPY --from=<image>`) referencing a registry image by tag only, in an image that is released or deployed. "Image tags are mutable, meaning a publisher can update a tag to point to a new image"; pin with `@sha256:` [1]. Not: local stage names.
- **apt-update-split**: `apt-get update` in a different `RUN` than its `apt-get install`. "Using `apt-get update` alone in a `RUN` statement causes caching issues": the cached index goes stale and later installs fetch outdated or missing packages [1]. Same for `apk update`/`dnf makecache`.
- **no-user**: a service image that never sets `USER`, so the process runs as root. "If a service can run without privileges, use `USER` to change to a non-root user" [1]. Hadolint only reports an explicit final `USER root`. Not: build-only stages, or images whose purpose needs root (documented).
- **secret-in-layer**: a credential file (`.npmrc` with a token, `id_rsa`, `.env`, cloud credentials) brought in with `COPY`/`ADD` or written by `RUN`, even if deleted in a later step: it persists in the image layer. Use `RUN --mount=type=secret` [2]. Also `COPY . .` when the repo has no `.dockerignore` excluding `.git` and env files [1].
- **remote-add-unverified**: `ADD https://…` or `RUN curl|wget …` of a binary or archive with no checksum check. `ADD --checksum=sha256:…` verifies remote resources [1][3]; for `curl`, verify with `sha256sum -c`.
- **entrypoint-no-exec**: an entrypoint shell script that starts the long-running process without `exec`. The process is not PID 1, "will not receive Unix signals", and so gets no `SIGTERM` from `docker stop` (killed after the grace period) [3].

Sources:
[1] https://docs.docker.com/build/building/best-practices/
[2] https://docs.docker.com/build/building/secrets/
[3] https://docs.docker.com/reference/dockerfile/

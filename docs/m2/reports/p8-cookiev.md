# Report: p8-cookiev (verify p8-cookie)

**Verdict: PASS.** No HIGH or MEDIUM findings. Five LOW findings, all in docs or comments. The cluster compose
requires one shared `COOKIE_KEY` from the environment and names it when missing. The CI key is random per run and
masked. No secret is in the diff.

**Full `bun test` is not green on the shared tree, and the cause is other jobs' in-flight edits, not this diff** (see
"Tests"). Nothing in the tree was changed by me except this report.

## What I checked, and how

| Check | Result | How |
|---|---|---|
| No secret in the repo | OK | Grepped the added lines of `git diff -- deploy .github` for hex/base64 runs and `COOKIE_KEY` literals. Only placeholders (`<openssl rand -hex 32>`) and `${COOKIE_KEY:?…}`. |
| Cluster compose fails loudly and names it | OK | `docker-compose config` (Compose 5.1.3, `env -i`, cwd in scratchpad). Unset: exit 1, `required variable COOKIE_KEY is missing a value: set COOKIE_KEY (…)`. Empty: same. Also run from the repo root: the root `.env` (which has a `COOKIE_KEY`) is **not** picked up, so the error still fires. |
| Same key on every node | OK | With a random key set, `config --format json`: app-1, app-2, app-3 each had exactly that value (compared in a script, never printed), and each had `DATABASE_URL` and `NATS_URL` (cluster mode). postgres, nats, blobs, blobs-init and lb get no `COOKIE_KEY`. |
| Single-node compose matches the docs | OK | `COOKIE_KEY:` (null pass-through). Unset: `null`, not passed. Shell value: passed through. Value in a `.env` beside `compose.yml`, run from another directory: passed through. |
| CI YAML parses, key per run, never echoed | OK | All three YAML files parse (`Bun.YAML.parse`). The step runs `openssl rand -hex 32`, then `::add-mask::`, then writes to `$GITHUB_ENV`. Nothing prints it. It sits in `test-cluster-services` before Test; that job's env has `DATABASE_URL` and `NATS_URL`. |
| CI env matches main.js | OK | `start(env)` reads only its argument. The one test that spawns main.js (`test/server/main.test.js:16`) passes a clean env, so the job's `COOKIE_KEY` is unused today, as the builder said. |
| Everything else cluster mode needs | OK | main.js (`server/main.js:91-100`) requires only `COOKIE_KEY` in cluster mode. `HOST=0.0.0.0` comes from the Dockerfile. `PUBLIC_URL`, `OIDC_REDIRECT_URI` and `GOOGLE_*` are optional. They default to localhost:8080, which is wrong behind the LB, but they only matter for Google sign-in. The README says so (`deploy/README.md`, cluster section). |
| Cluster bring-up | Not repeated | The builder already ran it on Podman. I relied on `config` only, as the brief allows ("if cheap"). |

## Ensemble review (sdd)

- **codex (medium):** one MEDIUM. It claimed a `COOKIE_KEY` stored in `deploy/.env` would not reach the single-node
  container through the null pass-through entry. **Refuted.** I put a `.env` beside a copy of `compose.yml` and ran
  `config` from another directory, and the container env got the exact value. The builder saw the same.
- **agy:** failed twice with empty output (`missing AGY_RESULT marker`, raw empty). No review from it.
- Both ran in a scratchpad copy of the diff and files, not in the repo, so they could not touch the tree.
- No finding had two harnesses agreeing.

## Findings

| # | Sev | Where | Finding |
|---|---|---|---|
| 1 | LOW | `deploy/README.md:28` | The table says "these are the variables `server/main.js` reads; nothing else is read". It still omits `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `PUBLIC_URL`, `PLENARY_MAX_CONNS_PER_USER`, `POST_LOGIN_URL` and `BOARD_URL`. It also omits `DATABASE_URL` and `NATS_URL` as the cluster-mode switch. The builder added two rows but left the "nothing else" claim wrong. Most of this predates the job. |
| 2 | LOW | `deploy/compose.yml:31` | The comment "Google sign-in: server/main.js does not read these yet" is stale, because main.js reads `GOOGLE_*`. It predates the job but is in a file the builder owns and edited next to it. The README's "What runs today" section is stale in the same way (builder flagged it). |
| 3 | LOW | `deploy/compose.yml:28`, `deploy/README.md:41` | "Leaves it unset otherwise" is not true for an empty value. A `COOKIE_KEY=` line in `deploy/.env` passes `""`. main.js then throws `COOKIE_KEY must be at least 32 bytes`, and `restart: unless-stopped` keeps restarting it. That failure is loud, so it is only a doc gap. |
| 4 | LOW | `deploy/cluster.compose.yml:56` | Compose accepts a short key (`COOKIE_KEY=short`: `config` exits 0). Every node then refuses to start with a clear error. The builder disclosed this. A length check can't be expressed in Compose interpolation, so I'd accept it. |
| 5 | LOW | `deploy/README.md:74` | "The cluster job generates…" comes one sentence before the paragraph that introduces the cluster job (`test-cluster-services`). Move it after that paragraph. The `echo … >> deploy/.env` one-liner (lines 44, 122) also appends a second line if run twice. Harmless (the last value wins in Compose's .env parsing, unverified), but "once" is worth keeping in both places. |

**Not a finding, but carried forward:** the app healthcheck splits under Docker Compose against Podman's API. The
builder found it, it predates this job, and it is outside the brief. The team uses Podman, so it needs its own job.

## Tests

- **Run 1:** 893 pass, 80 skip, 1 fail: `R6: a drop() while a connect() is opening its socket wins…` in
  `test/server/harness.test.js` (untracked, another job's). `test/server/rig.js` and that test file were modified at
  03:04, during the run. The file then passed 5 of 5 times on its own.
- **Run 2:** 802 pass, 80 skip, 4 fail, 4 errors. Every failure was `SyntaxError: Export named 'localRoom' not
  found in module web/core/sync.js`, in `test/web/ui-token`, `ui-land`, `ui-session` and `sync.test.js`. Another
  session is restructuring `web/` (many `web/` files deleted or modified in `git status`).
- **Tie to this job:** none. The diff touches only `deploy/` and `.github/workflows/ci.yml`. No test reads either
  (`grep -rlE "deploy/|ci\.yml" test` finds nothing).
- A green full run needs a quiet tree. I did not get one.

## Not verified

- The CI job on GitHub (not run). Docker itself (not installed; Podman here).
- A cluster bring-up by me: I relied on `config` and the builder's Podman run.
- Whether Compose keeps the first or last of duplicate `.env` keys (finding 5).

## Cleanup

No containers or processes started. Scratchpad only: config outputs (deleted), test logs, a copy of the diff for the
harnesses. Engram's Podman containers untouched.

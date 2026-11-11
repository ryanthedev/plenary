**PASS.** Verifier report: p8-deployv (verify p8-deploy: deploy/ matches server/main.js). No HIGH or MEDIUM
findings. One LOW (below). Verified 2026-11-11 by simulation; no Docker on this machine,
so the image was never built and compose was never run.

## Findings

| Sev | Where | Finding | Status |
|---|---|---|---|
| LOW | `deploy/Dockerfile:40` vs `server/main.js:58` | An empty `PORT` (`docker run -e PORT=`) makes main.js listen on a random port (`Number("" ?? 8080)` is 0), while the HEALTHCHECK's `process.env.PORT \|\| 8080` probes 8080, so the container reports unhealthy. Compose always sets `PORT: "8080"`, so the shipped path is unaffected. The root cause is main.js using `??` instead of `\|\|`; that file is the engine's, not this job's. | Confirmed by `bun -e 'Number("" ?? 8080)'` = 0. Not fixed (out of scope). |

No HIGH: no secret value in any file, no wrong env name, no missing runtime file, nothing that publishes.

## Checks against the brief

- **Env vars match exactly.** A walk of main.js's import graph found `process.env`/`env.` reads of only `PORT`,
  `HOST`, `PLENARY_DATA_DIR`, `PLENARY_DEV_TOKENS`, `LOG_LEVEL`, all in `server/main.js`; a grep of `server/`,
  `packages/` and `web/` found no others. deploy/ names exactly these (compose: `PORT`, `PLENARY_DATA_DIR`,
  `LOG_LEVEL`, `PLENARY_DEV_TOKENS`; Dockerfile adds `HOST`). Defaults in the README table match the code. The
  Google vars are commented out, correctly, because nothing reads them.
- **Dev-token semantics, run in-process via `start()`:** empty string is off with no error log (`if ("")` is
  falsy); `[]` and `{nope` each log "PLENARY_DEV_TOKENS is not a JSON object" and stay off; a valid object logs
  "dev tokens are ON: not for production" with a board id. The README's "Unset or empty = off. Invalid JSON is
  logged and treated as off" is accurate.
- **Import graph is inside the image.** 22 files, all under `server/` and `packages/` (core: doc, model, text).
  External imports are `bun:sqlite`, `node:fs`, `node:fs/promises`, `node:path` only, so no install step is needed.
  I copied the COPY set (`package.json`, `packages/`, `server/`, `web/`) with the `.dockerignore` patterns applied
  (rsync excludes) to a scratch dir: its `.js` set equals the source's, and the graph walker resolved all 22 files
  there with no misses. `data` and `blobs` in `.dockerignore` are root-anchored, so `server/blobs/` survives.
  The only runtime file read (`server/blobs/disk.js:84`) is inside the data dir.
- **Container start, simulated.** In the filtered copy: `env -i PATH HOME PLENARY_DATA_DIR=<tmp> PORT=0 HOST=0.0.0.0
  LOG_LEVEL=info PLENARY_DEV_TOKENS= bun run server/main.js` (the image ENV plus compose's environment, with port 0
  and a temp data dir). It logged "dev tokens are off…", then "server listening" on `0.0.0.0`; `lsof` showed
  `TCP *:<port> (LISTEN)`. `GET /health` returned 200 + JSON; `/ws` without an upgrade returned 426. The
  HEALTHCHECK string, run verbatim through `sh -c` with `PORT=<port>`, exited 0. `plenary.db` (+ WAL) appeared in
  the data dir. SIGTERM to the recorded PID: exit 0. HEALTHCHECK afterwards exited 1.
- **compose:** `ruby -ryaml` parses it. Ports `["127.0.0.1:8080:8080"]` only, `restart: unless-stopped`, one
  service. No `${VAR}` carries a value except `LOG_LEVEL:-info`.
- **Secrets, names, publish paths:** no secret values; the README's token example is the placeholder
  `<a-long-random-token>`; "ann" is the placeholder user already in main.js's header, not a real person. No
  `push`, registry or login step anywhere; "published" appears only in the port-publishing sense and in "nothing is
  published". `grep -rniE "phase 3|pending|placeholder|skeleton" deploy .dockerignore` and a grep for the
  person's names/handles/LLC in the same files both return nothing (phase 4 notes for Postgres/NATS are current).
- **`bun test`:** 206 pass, 0 fail across 17 files, including `test/server/*`. The brief expected 4 failing
  engine tests; none fail today. No test references `deploy/`, `.dockerignore`, the Dockerfile or compose.

## sdd ensemble review

| Harness | Ran | Result |
|---|---|---|
| codex (effort high) | yes | 1 LOW: the empty-`PORT` HEALTHCHECK mismatch. Confirmed (table above). |
| grok | yes | MEDIUM: "empty `PLENARY_DEV_TOKENS` is parsed and logs an error". **Refuted**: main.js:35 guards with `if (env.PLENARY_DEV_TOKENS)`, and the simulated start with an empty value logged no error. LOW: README abbreviates the log line to "dev tokens are ON"; it is a correct substring, not a defect. |
| agy | no | `check_adapter` failed: quota exhausted (429, resets in ~69 h). |
| kimi | no | `check_adapter` failed: not logged in. |
| mistral | no | `check_adapter` failed: no API key. |
| qwen | no | binary not installed. |

No finding had two harnesses agreeing, so there was no HIGH candidate. The harnesses reviewed a scratch copy of
the files, not the repo tree; a `find` in that copy for `.env*`, `*.db*`, `*.pem`, `*.key` and `client_secret*`
returned nothing, so no local secret or database reached them.

## Builder's not-verified list (re-checked)

- **Image never built, compose never run:** still true; same for `/data` writability for `bun`, HEALTHCHECK inside
  the real image, and the named volume keeping the `chown` (Docker seeds a new empty named volume from the image
  path, ownership included, but that is unverified here).
- **0.0.0.0 bind:** seen on macOS only, again.
- **Compose `.env` quoting:** the README's single-quoted JSON example in `deploy/.env` was never run through
  Compose's `.env` parsing and `${PLENARY_DEV_TOKENS:-}` interpolation; my simulation passed values directly.
- **Dev tokens off means every hello is refused; dev board id changes per restart; `web/` copied but unused:**
  all confirmed as described, and all documented in deploy/README.md.

## For the engine track (not this job's files)

- `server/main.js:58`: `Number(env.PORT ?? 8080)` turns `PORT=""` into port 0. `Number(env.PORT || 8080)` maps an
  empty `PORT` to 8080 (matching the HEALTHCHECK) and still leaves `PORT=0` as 0, because the string `"0"` is
  truthy.

# Report: p8-deploy (deploy/ matches server/main.js)

**Status:** the deploy work is complete, but the `bun test` gate is not met: 1 test fails, outside my files
(below). Not committed. The image was never built and compose was never run (no Docker on this machine).

**Tests added:** none. This job is config and docs only, and I own no test files.

## What changed

| File | Change |
|---|---|
| `deploy/Dockerfile` | `ENV HOST=0.0.0.0` added, with a comment on why. PENDING/PLACEHOLDER comments removed. HEALTHCHECK command unchanged; its comment now describes the real `/health`. CMD `bun run server/main.js` unchanged (it matches the entry). Comment added on `COPY web/` (copied, not served yet). |
| `deploy/compose.yml` | `PLENARY_DEV_TOKENS: ${PLENARY_DEV_TOKENS:-}` added (by name, no value). `restart: unless-stopped` enabled. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` commented out, because nothing in `server/` reads them yet. Phase-3 comments removed. |
| `deploy/README.md` | Rewritten for today: how to run it, what runs (only `/health` and `/ws`, no UI), an env table matching main.js, dev tokens are local-only, the `deploy/.env` quoting example with a placeholder token. "Not runnable until phase 3" removed. |
| `.dockerignore` | Unchanged. Checked against the import graph (below). |

## Env main.js reads (matched exactly)

`PORT` (default 8080), `HOST` (default 127.0.0.1), `PLENARY_DATA_DIR` (default ./data; holds `plenary.db` and
`blobs/`), `PLENARY_DEV_TOKENS` (JSON object; unset, empty or invalid = off), `LOG_LEVEL`. A grep of `server/`,
`packages/protocol/` and `web/` found no other `process.env` reads (re-checked 2026-11-11 17:36 CST; sibling
sessions are editing `server/`, so re-check if it has changed since). Logs go to stdout (`server/log.js:1`).

## How I checked it

- **Import graph:** walked from `server/main.js`. It reaches 22 files, all under `server/` and `packages/`
  (core: doc.js, model.js, text.js). External imports are `bun:sqlite`, `node:fs`, `node:fs/promises` and
  `node:path`, so no dependencies are needed. No runtime file reads outside the data dir. No graph file matches a
  `.dockerignore` pattern: `blobs` and `data` are anchored at the root, so `server/blobs/` and `server/store/`
  survive.
- **Container start, simulated** (script at
  `/private/tmp/claude-501/-Users-r-repos-plenary/a9f1e217-5325-4220-897b-543cfbdea1ea/scratchpad/sim.sh`,
  session-local; the env it uses is given here): I copied exactly the COPY list (`package.json`,
  `packages/`, `server/`, `web/`) to a temp dir and ran `bun run server/main.js` there with `HOST=0.0.0.0`,
  `PORT=0`, a temp `PLENARY_DATA_DIR` and `LOG_LEVEL=info`. I ran it twice:
  - **`PLENARY_DEV_TOKENS=""`** (what compose passes when unset): logs "dev tokens are off". Listens on `*:<port>`
    (lsof). `/health` returns 200 + JSON. The HEALTHCHECK string, run verbatim with `PORT=<port>`, exits 0.
    SIGTERM to the recorded PID gives exit 0. `plenary.db` was created in the data dir. After the stop, the
    HEALTHCHECK exits 1.
  - **Two dev tokens:** logs "dev tokens are ON" with the board id. Every other result was the same.
- **YAML:** `ruby -ryaml` parses compose.yml. Env keys are PORT, PLENARY_DATA_DIR, LOG_LEVEL and
  PLENARY_DEV_TOKENS; restart is unless-stopped.
- **Bun version:** local 1.4.4, the same as the pinned `oven/bun:1.4.4-slim`.

## Not verified

- **No image or compose run:** the image was never built and `docker compose up` never ran.
- **Base image behaviour:** I did not check that `/data` is writable by the `bun` user on the real image, that
  `HEALTHCHECK` runs inside it, or that the named volume keeps the Dockerfile's `chown`.
- **Linux bind:** the 0.0.0.0 bind was seen on macOS only. I did not test reaching the server through a published
  port.

## Test failure (not this job)

`test/server/gateway.test.js:134`, "bad frames get an error and/or a close…", fails every run (3 of 3). For a
hello with `v: 99`, `server/gateway.js:117` now answers with code `version`. The test only accepts `bad-op`, `auth`
or `too-large`. This looks like in-flight protocol work: PROTOCOL.md's uncommitted diff adds `version` to the error
codes. Both files are untracked, so which side is stale is unverified. The test or the gateway needs updating
by the engine track. I touched neither.

## Risks

- **No UI yet:** `restart: unless-stopped` plus dev tokens off means a container that runs fine and refuses every
  hello. That is expected today, and the README says so.
- **Dev board changes per restart:** the dev board id changes on every restart (in-memory registry), so a restart
  under `restart:` orphans clients pointed at the old id.
- **Unused `web/` copy:** `web/` is in the image but unused until the server serves it.

## For README.md (another session owns it; I didn't touch it)

- **Env vars:** if it lists them, it should use exactly the five above, and `HOST` must be `0.0.0.0` in a container.
- **Google sign-in:** it should not say the vars are read by the server yet.
- **Running it:** `docker compose -f deploy/compose.yml up --build` now runs the server. It needs dev tokens in
  `deploy/.env` before any client can join.

**Question for the manager:** who fixes `test/server/gateway.test.js:134` against `server/gateway.js:117` (code
`version` for a wrong protocol version), so the `bun test` gate passes?

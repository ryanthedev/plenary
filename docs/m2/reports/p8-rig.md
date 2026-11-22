# Report: p8-rig (local cluster rig for the M2 load test)

**Status:** the rig is built and tested live against real Postgres 17.11, NATS 2.15.3 and Caddy 2.11.4.
`bun test test/deploy` passed 3 times in a row (6 pass, 1 skip). The full `bun test` has 2 failures. One is the
known core-source drift. The other is **test/architecture.test.js, which now flags scripts/cluster-rig.js**: every
new script must be listed as a composition root. That file is not mine. The one-line fix is in "Needs from others"
below.

## Files changed

| File | Change |
|---|---|
| scripts/cluster-rig.js | NEW. CLI `up \| status [--json] \| kill <node> \| down`. Exports `startRig`, `stopRig`, `readRig`, `rigStatus`, `killNode`, `isOurs`, `portFree`, `missingBins`, `bins`, `defaultDir`. Bun only, no new deps, imports no project module. |
| test/deploy/cluster-rig.test.js | NEW. 6 live tests and 1 `test.skip` end-to-end test. |
| test/deploy/stub-node.js | NEW. HTTP + WebSocket stub node. It reports its node id and env (hashes for the keys) and never prints. `--die-if-role=host` makes it exit at once. |
| deploy/cluster/RIG.md | NEW. The "Local cluster rig" doc, including the rig.json schema for p8-load. |
| deploy/cluster.compose.yml | Header now says exactly what main.js is missing. Roles are split like the rig (app-1 and app-2 `gateway`, app-3 `host`; app-1 was `gateway,host`). Adds `PLENARY_LEASE_TTL_MS` (once, in the shared env) and `PLENARY_MAX_CONNS_PER_USER`. Points to RIG.md. The "NOT FUNCTIONAL YET" header is kept. |
| deploy/cluster/Caddyfile | Now proxies every path to the gateways. It used to pass only `/ws` and `/health`, so `/boards`, `/auth` and the web app returned 404 through the LB. |
| .gitignore | `.rig/` |

Not touched: server/*, test/server/*, PROTOCOL.md, deploy/README.md.

## How to run it

```sh
bun scripts/cluster-rig.js up [--hosts 2] [--gateways 2] [--lease-ttl-ms 10000] [--name default]
bun scripts/cluster-rig.js status [--json]
bun scripts/cluster-rig.js kill host-1
bun scripts/cluster-rig.js down
bun test test/deploy
```

The rig dir is `.rig/<name>/`. RIG.md has every flag, the env each node gets and the files in the rig dir.

**For p8-load:**
- **Endpoints:** `rig.json` (or `status --json`) gives `lb.wsUrl`, `lb.url`, `tokensFile` and `nodes[].port`.
- **Tokens file:** it is in `PLENARY_DEV_TOKENS` format and every token has domain `rig.test`. There is one owner
  token with `admin: true` (`rig-admin`), plus `editor-1..8`, `annotator-1..32` and `viewer-1..64`.
- **Connection cap:** `PLENARY_MAX_CONNS_PER_USER` defaults to 100000 in the rig, because main.js's own default of
  64 would cap a load test that shares tokens.

## Proven live

**With the real server/main.js** (scratchpad rig `real1`):
- **Startup:** `up` started all 3 nodes. Their logs say `"cluster":true`, `devTokens: "[redacted]"`, and the dev
  tenant `rig.test` was created with `dev:rig-admin` as admin.
- **Through the LB:** `GET /health` returned 200 JSON. `POST /boards` with the admin token returned `201 {board}`
  twice. The token was read from the file, never printed.
- **Process list before and after `down`:**

```
BEFORE
49851 /opt/homebrew/bin/postgres -D …/scratchpad/real1/pg -p 52682 -c listen_addresses=127.0.0.1 …
49982 /opt/homebrew/bin/nats-server --config …/real1/nats.conf
49990 bun /Users/r/repos/plenary/server/main.js
49992 bun /Users/r/repos/plenary/server/main.js
49994 bun /Users/r/repos/plenary/server/main.js
50016 /opt/homebrew/bin/caddy run --config …/real1/Caddyfile --adapter caddyfile
rig down: stopped caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres
AFTER
  PID COMMAND        (ps -p <those 6 pids> exit 1: none left)
```

**With stub nodes (CLI, separate processes):**
- **LB WebSocket check:** 4 WebSockets through Caddy went to `gw-1, gw-2, gw-1, gw-2`, never to `host-1`.
- **kill and down:** `kill gw-1` returned `killed gw-1 (pid 44022) with SIGKILL`. `down` then printed
  `stopped caddy, node:host-1, node:gw-2, nats, postgres; already gone: node:gw-1`, and ps found none of the 6 PIDs.
- **Same checks in the tests:** the tests repeat all of the above with assertions. They also check that every node
  gets the contract env and nothing else (no `.env` or `process.env` leak), runs with its cwd outside the repo, and
  shares the same COOKIE_KEY and SESSION_KEY hashes. They check that `DATABASE_URL` reaches database `plenary`, that
  NATS reports `max_payload` 2097152, and that after `down` every rig port can be bound again.

## Tests

| Run | Result |
|---|---|
| `bun test test/deploy` ×3 | 6 pass, 1 skip, 0 fail each time (6.3 s, 6.3 s, 6.2 s) |
| `bun test` (full suite, run before the SIGTERM test was added) | 1400 pass, 151 skip, 2 fail, 1553 tests across 82 files |

**The 2 full-suite failures:**
- **test/architecture.test.js, "packages/, server/ and scripts/ follow the hexagonal import rules":** it lists
  `scripts/cluster-rig.js` (mine) and `scripts/load/{client,run,server,stats,tokens,worker}.js` (p8-load's
  uncommitted files) as "neither core, adapter nor a composition root". The test requires every new script to be
  added to `COMPOSITION_ROOTS`. That needs a change to a file I don't own.
- **test/core-source.test.js:** known and unrelated (herdr-draw's editor.js sha has drifted).

**Note for other sessions:** a full `bun test` from any session now runs test/deploy too. That adds about 8 s, starts
real Postgres, NATS and Caddy on probed ports, and skips cleanly when a binary is missing. During my run another
session's `bun test` had its own rig up at the same time, in its own temp dir. I left it alone.

### Guard mutations: each guard's test fails without it

Each mutation was applied to scripts/cluster-rig.js and then restored; `diff` against the backup was clean.

| Guard | Mutation | Test that failed |
|---|---|---|
| Teardown only-ours | `isOurs` ignores the start time (`return !!info`) | "down and kill only signal a PID whose start time still matches…" (the test failed; I did not check which assertion) |
| Crash-midway cleanup (in process) | removed `await stopRig(dir, { final: "failed" })` from `startRig`'s catch | "up failing midway (the host node exits at once) stops everything that had started" |
| Crash-midway cleanup (`up` SIGKILLed) | `save()` skips writes while `state === "starting"` (rig.json only at the end) | "CLI: `up` SIGKILLed midway leaves rig.json naming what it started…" |
| Secrets not printed (status) | `status` prints the first token | "CLI: keys and dev tokens never reach stdout or stderr…" |
| Secrets not printed (failure path) | `up`'s failure message includes keys.json | the same test, through its failing-`up` leg |
| Nodes get a minimal env (no `.env` leak) | `baseEnv` spreads `process.env` | "up: env contract on every node…" |
| SIGTERM or Ctrl-C during `up` tears down | removed the abort check from the wait loop | "CLI: SIGTERM (or Ctrl-C) during `up`…" (timed out at 120 s) |

The SIGKILLed-`up` mutation leaked by design: with no rig.json, nothing records the orphans. My mutation run left
one NATS and three `sleep 300` processes in a deleted temp dir. I identified them by PID, parent 1 and start time
13:39:42 and SIGTERMed those 4 PIDs.

**Mistake: my in-place mutations reached another session's test run.** Another session started a full `bun test`
at 13:40:19, while the M3 mutation was in the shared working tree, so its run loaded the mutated rig. It left
**nats-server PID 62656** (start time Thu Nov 12 13:40:27 2026, parent 1, config in the deleted temp dir
`plenary-rig-zDGthh`). Its other results may also have been affected. I did not start that PID, so I left it.
**Manager: please stop PID 62656, or ask that session to; and treat that session's 13:40 test result as suspect.**
Future mutation runs belong in a copy or a git worktree, not the shared tree.

## Skipped until p4-wire

**The skipped test:** "e2e (needs p4-wire): hello over the LB, an op acked, the entry visible from a client on the
other gateway". It creates a board with `POST /boards` through the LB using `rig-admin`. Client A says hello through
the LB as owner; client B connects straight to gw-2's port as `viewer-1`. A sends an op and expects
`ack {id: "a:1", seq: 1}`; B expects `entries[0]` with `seq: 1` and `by: "dev:rig-admin"`.

I re-checked main.js just before writing this report. It still reads only `DATABASE_URL`/`NATS_URL` as a cluster-mode
switch, plus `COOKIE_KEY`.

**The env the rig sets on every node, which main.js must read after p4-wire:**

| Variable | Value the rig gives it |
|---|---|
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:<port>/plenary` (trust auth, superuser) |
| `NATS_URL` | `nats://127.0.0.1:<port>` (max_payload 2 MB) |
| `PLENARY_NODE_ID` | `gw-1`, `gw-2`, `host-1`, … (`[a-z0-9-]`, unique per rig) |
| `PLENARY_ROLES` | `gateway` or `host` |
| `PLENARY_LEASE_TTL_MS` | the same value on every node, default 10000 (`--lease-ttl-ms`) |
| Today's env | `PORT`, `HOST=127.0.0.1`, `PLENARY_DATA_DIR` (one per node), `PLENARY_DEV_TOKENS`, `COOKIE_KEY`, `SESSION_KEY`, `PLENARY_MAX_CONNS_PER_USER`, `LOG_LEVEL` |

The rig waits for `GET /health` 200 on **every** node, host-only nodes included. After p4-wire, a host-only node must
still serve `/health`; the compose file already asks engine to keep that.

**Already proven without p4-wire:** I ran the same test body in the scratchpad against a one-node rig
(`gateways: 1, hosts: 0`) with the real main.js, through Caddy. Every step passed:
- **Board:** `POST /boards` → 201, `board` is an object, so `.id` is the id.
- **Hellos:** `rig-admin` was welcomed as owner. `viewer-1` was welcomed as viewer, which shows that domain
  `rig.test` plus `memberRole: "viewer"` admits the rig's tokens.
- **Op:** ack `{t:"ack",id:"a:1",seq:1}`, then B got `entries[0]` `{seq:1, by:"dev:rig-admin"}`.
- **Teardown:** `down` left 0 processes alive.

Only the cross-gateway hop (B on gw-2) waits on p4-wire.

**To enable the test:** change `test.skip` to `test` in test/deploy/cluster-rig.test.js. It is a plain skip, not
auto-detection, so it can't switch itself on unrun.

## Not verified

- **Podman fallback:** not implemented. Native Postgres, NATS and Caddy are all installed here. With a binary
  missing, `up` refuses with `missing binaries: … (brew install …)` and the tests skip with the same reason.
- **Startup timeout:** the "not ready after the timeout" error path has no test. The node-exit, abort and SIGKILL
  paths do.
- **`--node-cmd`:** it splits on whitespace, so a path with spaces breaks. `opts.nodeCmd` (an array) does not have
  this problem.
- **Load at scale:** no test went beyond a handful of connections through Caddy. The rig does not raise
  `ulimit -n`; children inherit the shell's limit. Caddy holds about 2 fds per proxied WebSocket, so 10k clients
  need about 20k fds in Caddy, plus fds in each gateway. p8-load should check `ulimit -n` (or the rig could raise it
  in a later job).
- **Port probe race:** ports are probed free, then bound by the child, so there is a small window. A lost race shows
  up as a clear "not ready / exited (log: …)" error with full teardown. There is no automatic retry.
- **Linux:** untested. `ps -o lstart=` and `/opt/homebrew` fallbacks are macOS-first; `Bun.which` covers PATH
  elsewhere.
- **Test runner crash:** if the test runner itself crashes, `afterAll` doesn't run. Rigs in temp dirs then stay up
  until `bun scripts/cluster-rig.js down --dir <dir>`.
- **Compose:** only `podman compose config` was run (via docker-compose 5.1.3 as provider, dummy secrets inline;
  exit 0). It was not brought `up`. `caddy validate` on deploy/cluster/Caddyfile exited 0.
- **Design skill:** I did not apply the distributed-systems-design skill. This job is local test tooling, not a
  design-bearing change to the system, and it adds no protocol, port or adapter.

## Risks

- **Superuser Postgres:** nodes connect as superuser (`postgres`, trust auth on 127.0.0.1 only). That is fine for a
  local rig, but it won't catch least-privilege problems the way p5-pgpriv's setup does.
- **Lost Postgres data:** `up` wipes a stopped rig's dir (only when it has a `rig.json` and no live processes), so
  Postgres data does not survive `down` then `up`.

## Needs from others / questions for the manager

0. **Stray process:** stop nats-server PID 62656 (see "Mistake" above).
1. **test/architecture.test.js (owner: whoever owns the arch test):** add to `COMPOSITION_ROOTS`:
   `"scripts/cluster-rig.js",   // platform: local cluster rig (p8-rig); imports no project module`. p8-load's
   `scripts/load/*.js` need the same treatment. Until then the full `bun test` is red on this test.
2. **One host by default:** the brief's default is 2 gateways + 1 host, so the takeover check has nowhere to go.
   The phase-4 check must run `up --hosts 2`; RIG.md says so. I also changed compose's app-1 from `gateway,host` to
   `gateway` to match the rig's role split. That leaves compose with one host, where it had two before. Keep it, or
   go back to a second host (or add `app-4: host`)?
3. **Blobs:** engine says blobs stay on local disk. Each node then has its own blob dir, so a blob uploaded through
   gw-1 is not on gw-2. The compose file still carries MinIO and `S3_*`, which nothing reads; the header now says
   so. Should compose drop MinIO, or is S3 coming back for M2?
4. **Dev board per node (for engine's p4-wire):** main.js mints the dev board per `PLENARY_DATA_DIR`
   (`dev-board.json`). With a shared Postgres registry, each node would mint its own dev board. The rig's e2e test
   and RIG.md therefore use `POST /boards` with the admin token, not the dev board.
5. **deploy/README.md (not mine, someone else's uncommitted edits):** its "Cluster (phase 4, not functional yet)"
   section, which the compose header points to, should mention the new role split (app-1 is now `gateway` only), the
   Caddyfile that proxies every path, and the link to deploy/cluster/RIG.md.
6. **For p8-load:** `scripts/load/run.js` `rigConfig` already reads `lb.wsUrl` and `tokensFile`, and the token shape
   `{name, role}` matches (the rig adds `domain` and `admin`). rig.json has no `board`: create one with
   `POST /boards`. A token's `role` is the role it asks for; on a board made with `POST /boards`, editors need
   `PUT /boards/:board/grants/dev%3A<name>` (unlike the single-node dev board, where main.js grants token roles).

Blocking ask: add `"scripts/cluster-rig.js"` to COMPOSITION_ROOTS in test/architecture.test.js (the full `bun test` is red until then).

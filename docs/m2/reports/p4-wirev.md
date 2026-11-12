# Report: p4-wirev (verify p4-wire rounds 1 and 2)

Verifier: p4-wirev (engine). Checked the uncommitted p4-wire diff against both briefs and the builder's report:
server/main.js, server/server.js, server/room-host.js, server/bus/port.js, PROTOCOL.md § Bus, and the four test
files. Nothing tracked was edited and nothing was committed.

Every attack and mutation ran in a scratch copy under the session scratchpad, made with
`rsync --exclude .git --exclude node_modules --exclude '.env*'`. **That copy never held a `.env`** (`find` over the
scratchpad found 0 such files), so there was nothing to delete under the addendum. The scratchpad could not be deleted (`rm` is denied); see Cleanup.

## Verdict: PASS (1 MEDIUM, 7 LOW)

- **Rules and claims:** every stated env rule, the role split, the remote-open timings, F5 with two hosts and R2-L1
  hold on realistic inputs.
- **Gates:** all green. The only failure is the known core-source drift.
- **Mutations:** every builder mutation I re-ran is caught.
- **The MEDIUM** is in the NATS adapter, outside this job's files: NATS credentials in `NATS_URL` are ignored. It fails
  closed (the start is refused), so nothing leaks.
- **The LOWs:** redaction gaps shown only with fake drivers, a test that doesn't cover the sweep, and timer and edge
  behaviour.

## Findings

### MEDIUM

**M1. `user:pass@` in `NATS_URL` is ignored by the NATS client, so a password-protected NATS can't be used.**
- **Where:** server/bus/nats.js:119 passes `servers: url` to `@nats-io/transport-node` 3.4.0, and that client drops
  URL userinfo.
- **Why it matters:** the main.js header (server/main.js:27-31) says the URLs "carry passwords". Today
  deploy/cluster.compose.yml:77 uses an auth-less `nats://nats:4222`, so nothing breaks yet.
- **Repro:** run nats-server with `authorization { user: plen, password: "X" }` and connect with
  `{ servers: "nats://plen:X@127.0.0.1:<port>" }`. The result is `Authorization Violation`. The same server with
  `{ servers: "127.0.0.1:<port>", user: "plen", pass: "X" }` connects. Through main.js, `start()` with that URL is
  refused: `could not open the NATS bus (NATS_URL): Authorization Violation` (redacted, no leak).
- **Fix (owner: the bus adapter, not p4-wire):** parse userinfo out of each server URL and pass `user`/`pass` (or
  `token`) as options, or document NATS_USER/NATS_PASSWORD.
- **Side effect on this review:** NATS authentication errors could not be tested for redaction with real drivers.

### LOW

**L1. `redact()` misses three URL forms** (server/main.js:122-136). With fake drivers whose error quotes only the
secret, through the real `start(env, { adapters })` path, each secret reaches the thrown message:
- `postgres://u@h/db?password=S`: a query-string password.
- `nats://S@h:4222`: a bare token in the userinfo.
- `nats://a:p@h1,nats://b:S@h2`: a comma list, which `new URL` can't parse, so only the whole string is replaced.

Real drivers don't trigger this today. In my probes Bun SQL's errors ("Failed to connect", "password authentication
failed for user \"plen\"", "Invalid URL") quote no URL. Repro: test/attack/cheap.test.js "C3" (scratch; recipe below).

**L2. Errors after the start are never redacted, and the bus `onError` line logs `code` raw.**
- **onError:** server/main.js:315 redacts `err.message` but logs `code: err.code` as is. A fake `onError` with
  `code: "CODE_<pw>"` prints the password in the `bus error` line.
- **After start:** redaction wraps only `openCluster`. With a fake Postgres store whose `acquire` throws an error
  quoting the URL, room-host's `remote open failed here; no reply` line (server/room-host.js:619) logs the full URL
  and password in `err.message`, `err.code` and `err.stack`.
- **Severity:** fake drivers only.
- **Repro:** cheap.test.js "C1+C2".

**L3. The R2-L1 test doesn't exercise the sweep path, despite its name.**
- **The gap:** reverting only the sweep's `drop` (server/room-host.js:515 back to `slot.conns.delete(ck)`) passes
  room-host-lease, roles and room-host tests (27 pass, 0 fail). The listing already drops those connections, so the
  sweep never removes one in that test.
- **Why it matters:** the path is real. `Room.sweep()` (packages/protocol/room.js:275-279) disconnects every
  connection of a gateway silent for 30 s, so a dead gateway node regrows `welcomed`. The code is correct today.
- **Test to add:** a gateway that falls silent past 30 s (injected `now`), then `peek()` shows
  `welcomed === conns`.

**L4. A `watching` reply in the last grace window before the ttl ends in `unavailable`.**
- **Where:** server/room-host.js:659 and 674. The ttl timer isn't cleared or extended when the grace arms.
- **Repro:** ttl 800 ms (grace 200 ms) with a fake host that answers `watching` at 750 ms. The open rejects
  `unavailable` at 800 ms, with the message "no room host answered the open". The r2 brief says "at the end of the
  grace, resolve".
- **Impact:** a host has to take more than ttl − grace to answer. The message is then misleading, and the client
  retries.

**L5. A stale publish rejection settles by board key, so it can reject a newer request for the same board.**
- **Where:** server/room-host.js:677-680.
- **Repro, fake bus:** request 1 resolves `held` while its publish promise is still pending. Request 2 starts, then
  request 1's publish rejects, and request 2 is rejected `unavailable` although its own reply was coming.
- **Why it can't happen today:** the real NATS and memory buses settle `publish` at once (server/bus/nats.js:196-221).
- **Fix:** compare `inflight.get(key) === r` in the catch. Repro: cheap.test.js "C6".

**L6. `PLENARY_NODE_ID` values of only dashes pass validation, but the holder doesn't name the node.** `"-"` and
`"---"` match `/^[a-z0-9-]{1,32}$/` (server/main.js:80), but `newHolder` strips leading and trailing dashes and falls
back to `host` (server/room-host.js:73). The holder becomes `host-<pid>-<rand>`, while the brief says holders read
`<node>-…`. Leases still work, because holders stay unique. Fix: require an alphanumeric first and last character.

**L7. Empty `DATABASE_URL` and `NATS_URL` start a single node silently** (server/main.js:93, a truthiness check). An
unset compose interpolation yields exactly that. The compose sets `PLENARY_ROLES` on every app node, so the
single-node rule refuses those (checked: `""`/`""` with `PLENARY_ROLES=gateway` is refused). A node without
PLENARY_ROLES would run alone on SQLite. Consider treating a present but empty value as set, so it is refused.

**Not a finding:** removing the reply's board check (`r?.board !== m.board`) survives every test, but `n` is unique
per requester, so this mutant is close to equivalent.

## Attack results by brief item

| # | Item | Result |
|---|---|---|
| 1 | **Env refusals** | Every rule holds. Probed: `PLENARY_NODE_ID` `"-"`, `"0"`, 32 × `x`, `a-`. TTL `" 3000"`, `"\t3000\n"`, `"0003000"` are accepted; `"3_000"`, `"+3000"`, Arabic-Indic digits are refused. ROLES `"ＨＯＳＴ"` and `"host\0"` are refused, `"\thost\n"` is accepted. `" "`/`""` URLs are handled. |
| 1 | **Redaction, real drivers** | Probed: Postgres URLs with `%40`, raw `#`, `?password=`, host only and a unicode password; a bad Postgres password against a live scram Postgres. Nothing leaks in the message, `String(err)`, the stack or any log line. A real NATS outage under a running node logs `bus error: the NATS connection is down…` with no URL. |
| 1 | **Redaction, fake drivers** | Gaps L1 and L2. |
| 1 | **Close what opened** | After a real NATS failure, real Postgres connections are closed: `pg_stat_activity` showed 0 before and 0 after 5 refused starts. |
| 2 | **Host-only node** | Serves only /health, by test and code: `if (!gw) return 404` comes before every route (server/server.js:49). |
| 2 | **Gateway-only node** | Never touches a lease. A spy store on a gateway-only `createServer` with two writers saw only `epoch`, `getCheckpoint` and `read`, never `acquire`/`renew`/`release`/`lease`. `/health` roles match `!!gw` and `roles.host`. |
| 3 | **Remote open and grace** | `held` at the grace boundary (200 ms) resolves `held` at 203 ms. A reply naming another board, or the wrong `n`, is ignored. Three dedup waiters all reject `unavailable` at the ttl. Late and garbage replies (`null`, `5`, `{n:"1"}`, …) do no harm, and `opening` returns to 0. The next open sends a new request (`n` 3). Tenant A `held` with tenant B unanswered for the same board id: A resolves, B rejects. Exceptions: L4, L5. |
| 3 | **Ttl beyond the gateway's hello timer** | ttl 1500 ms, `helloTimeoutMs` 500 ms, no host. Each socket gets exactly one `unavailable` and one 1013, and there is no unhandled rejection. The late `hello failed: room` is logged after the close; that is harmless. |
| 4 | **F5, in process** | Gateway-only plus two hosts, 15 cold boards × 3 concurrent writers: 45 welcomed first try, 0 duplicate welcomes, 0 duplicate acks, 0 errors. After the holder stops, all 15 boards welcome a new writer exactly once. |
| 4 | **F5, real children (PG + NATS)** | One gateway and two host `bun server/main.js` children, ttl 3000, 20 cold boards × 2 writers, run twice. 40 of 40 welcomed first try, 0 duplicate welcomes, 0 duplicate acks, 0 errors. The hosts split 17/3. After kill -9 of the busier host, all 20 boards welcomed a new writer exactly once within 3,032 and 3,065 ms (limit ttl + 3 s = 6,000). The password was absent from every child's output. |
| 5 | **R2-L1** | The builder's test reproduces, and the `r2l1-undone` mutation fails it. Every path that removes a connection goes through `drop` or clears both sets (server/room-host.js:115, 446, 460, 477, 484, 504, 508, 515). Gap: L3. |

## Mutations (scratch copies, never the shared tree)

| Mutation | Origin | Result |
|---|---|---|
| both-urls (both URL checks skipped) | builder, round 1 | caught: 2 fail |
| gw-local-host (gateway-only builds a local room host) | builder, round 1 | caught: 7 fail (all of roles.test) |
| r2l1-undone | builder, round 1 | caught: 1 fail |
| grace-skipped (first reply wins) | builder, round 2 | caught: 2 fail |
| no-redact-open (both redacts in `openCluster` removed) | builder, round 2 | caught: 2 fail |
| mine-no-decode (decoded password not redacted) | mine | caught: 1 fail (the `redact` unit test only) |
| mine-sweep-only (sweep's `drop` reverted) | mine | **survives**: 27 pass (L3) |
| mine-no-board-check | mine | survives; close to equivalent (see above) |

## Gates

| Gate | Result |
|---|---|
| `bun test test/server` ×10, no PG/NATS | 10 of 10 runs: 257 pass, 0 fail |
| `bun test`, once, no PG/NATS | 1469 pass, 155 skip, **1 fail: test/core-source** (the known herdr-draw drift). test/deploy/cluster-rig did not fail. |
| test/architecture.test.js | 16 pass, 0 fail |
| `bun test test/server` with DATABASE_URL + NATS_URL | 379 pass, 11 skip, 0 fail. Postgres used scram auth with a fake password in the URL, so main-cluster's "URL absent from child stdout" check ran with a password. Output was teed and grepped: 0 occurrences of the password. |

## Servers, processes and cleanup

- **Postgres 17.** PID 71581, 127.0.0.1:54121, TCP only, scram auth, fake password, data dir in the scratchpad.
  - Stopped with `pg_ctl stop -m fast`.
  - No `plen_%` database was left behind.
  - `ipcs -m` showed 30 segments before the start, 31 while it ran and 30 after. No segment was removed.
- **nats-server PID 71592** (with auth). Stopped by PID after M1 was found.
- **nats-server PID 75407** (no auth, `max_payload: 2MB`, port 54122). Used for the gates and stopped by PID.
- **Private nats-servers 72268 and 76160** (short probes). Both stopped by PID.
- **Check:** all five PIDs were confirmed gone. pkill, killall and ipcrm were never used.
- **Scratchpad: NOT deleted, because `rm` is denied in this session.** Left behind: the tree copy (`tree/`, no `.env`, `node_modules` a symlink), the attack tests in `tree/test/attack/`, `pg/` (the stopped Postgres data dir, fake password only), `logs/`, `tmp/`, two small `.mjs` probes, two NATS confs and `pgpw` (the fake password). Mutation copies were removed by the runner as it went. Nothing secret is in there; deleting it is the manager's call.
- **Repro recipe for the scratch tests:** copy the repo as above, then the tests are still in the scratchpad at `tree/test/attack/` (cheap, roles-attack, f5-pg, live-redact, redact, holder).
- **One slip:** one helper step briefly wrote a file in `/tmp` (not the scratchpad) before moving it into the
  scratchpad. It held no secret and is gone.

# Report: p4-wire2 (p4-wire fix round: M1 and L1-L7 from p4-wirev)

Builder: p4-wire2 (engine), terminal t1km. Nothing committed. All 8 findings are fixed, each with a test that a
named mutation fails. All gates are green. The only failures were the known core-source drift and 3 timing failures
in files I don't own, and those 3 pass when re-run alone.

## What changed

| Id | File | Change |
|---|---|---|
| **M1** | server/bus/nats.js | New `natsConnectOptions(url)`: cuts the userinfo out of each server by hand (not `new URL`, so `host:4222` and `tls://` survive), percent-decodes it, and returns `{ servers, user, pass }` or `{ servers, token }` (a bare `token@`). Takes one URL, a comma list or an array. Servers carrying *different* credentials are refused (`bad-config`), because the client takes one set; no refusal echoes a value. `natsBus` passes these options instead of `servers: url`, and takes an optional `connect` (a test seam). |
| **L1** | server/main.js | New `urlSecrets(value)`, used by `redact`. It covers the whole value and each comma-list element (the whole value too, so a raw comma inside a Postgres password stays one secret), a userinfo password (raw and decoded) and `user:pass`, a bare userinfo token, and every query parameter named `*pass*`/`*token*`/`*secret*`/`*key*` (raw and decoded). A bare userinfo on `postgres:` / `postgresql:` is a user name, not a secret, so it is not blanked; the rig's `postgres://postgres@…` would otherwise blank the word "postgres" everywhere. The generic `scheme://userinfo@` rule no longer crosses `"`, `'` or `,`, so on a JSON line it can't run from a URL to a later `@`. |
| **L2** | server/main.js | New `redactingLogger(log, urls)`. `start()` builds its logger through it, and so does the CLI's logger (start refusals, uncaught errors). It redacts the message, every string field, and an Error's message, code and stack before log.js clips or JSON-escapes them (the secrets are computed once per logger, not per line), so it also covers room-host's `remote open failed here; no reply` line and every other component's lines. The bus `onError` now logs the Error itself, and that logger redacts it. With no URL set, the logger is unchanged. |
| **L3** | (test only) | The sweep path already used `drop`; test added. |
| **L4** | server/room-host.js | `remoteRooms`: a `watching` answer cancels the ttl timer when its grace starts, so it resolves at the grace's end. Worst case is now ttl + grace (JSDoc and main.js header say so). New optional `timers` (a fake clock for tests); server.js is unchanged. |
| **L5** | server/room-host.js | A publish rejection settles only if `inflight.get(key) === r`. |
| **L6** | server/main.js | `PLENARY_NODE_ID` must start and end with a letter or digit; the refusal names the variable. `defaultNodeId` drops edge dashes (fallback `node`). |
| **L7** | server/main.js | `DATABASE_URL` / `NATS_URL` set but empty or blank refuse the start: "`<NAME>` is set but empty: unset it for a single node, or give the URL for a cluster" (no value printed). |

- **PROTOCOL.md § Bus is unchanged.** It already says "no answer within the lease ttl: `unavailable`", which L4 now matches.
- **test/server/main.test.js:** one assertion updated. The `bus error` line's `err` is now a redacted Error object
  (like every other log line), so it checks `err.message`, not a string.
- **distributed-systems-design skill:** not run. These are fixes to an existing design, not new design. The one
  timing change (L4) is the bounded ttl + grace above.

## Tests added: test/server/p4-wire2.test.js (12 tests)

| Finding | Test(s) | Mutation run in a scratch copy | Result |
|---|---|---|---|
| M1 | `natsConnectOptions` unit; `natsBus` with a fake `connect` (user/pass and token reach the options, not `servers`); through `start()` with a fake connect (the credential reaches the options; the error and every line are free of it); **live**: own nats-server (port -1) with user/password, then a token, connects and round-trips; a wrong credential is refused without echo | `connect({ servers: url, …})` (old code) | caught (3 tests) |
| L1 | query secrets, bare token, comma list, a raw comma inside a Postgres password, postgres user kept, no JSON-line overreach; whatever `natsConnectOptions` sends, `urlSecrets` names | query handling off / token branch removed / no comma split / whole value not read | each caught |
| L2 | through real `start()` with fake adapters: `onError` with the password in message, `code` and `cause`, plus a remote open whose store throws the same error (room-host's line) | redacting logger removed / Error `code` not redacted | each caught |
| L3 | rooms' clock +29 s, g-1 lists (g-2 silent), +2 s more, so only g-2 is past 30 s whichever sweep runs; then `conns === welcomed === 40` | sweep's `drop` back to `slot.conns.delete(ck)` (the verifier's surviving mutant) | caught |
| L4 | fake timers: ttl 800, `watching` at 750: still pending at 800 and 949, resolved `watching` at 950; no answer still rejects at the ttl | ttl timer not cancelled | caught |
| L5 | request 1 held, request 2 sent, request 1's publish rejects late: request 2 stays pending, then resolves `held` | identity check removed | caught |
| L6 | `-`, `---`, `-a`, `a-`, `-a-` refused; `a--b`, `0`, 32 × `x` accepted; default trims | old regex | caught |
| L7 | `""`/`""`, `""` alone, `" "`, and a PG URL with empty NATS_URL each refused, naming the variable | empty check removed | caught |

## How I checked it (gates)

| Gate | Result |
|---|---|
| `bun test` once (no PG/NATS) | 1510 pass, 155 skip, 5 fail. **core-source**: the known drift. **main.test "NATS open failure after Postgres opened"**: mine (log-shape assertion); fixed, and main.test.js now passes 20/20. **3 in files I don't own** ("here: relayed…", "writer cap: 8 tabs…", "churn leaves no count behind…", in test/server/tab.test.js (p-tab's new file) and test/server/tune.test.js (tracked, unmodified, not mine); gateway.js was being edited by p-tab meanwhile). Re-run alone: tab.test.js 6/6 and tune.test.js 16/16 pass. |
| `bun test test/server` ×10 | Run twice. Before the review fixes: 10 of 10 with 0 fail. **On the final code:** 10 of 10, 276 pass, 0 fail. No v1.test.js flake seen. |
| `bun test test/server` on Postgres + NATS | Run twice, the second time **on the final code: 398 pass, 11 skip, 0 fail**. Postgres 17 used scram auth with a fake password in DATABASE_URL. **NATS required a user/password** (fake), passed only through `NATS_URL=nats://plen:…@127.0.0.1:<port>`, so the whole NATS contract ran on the M1 fix. Output grepped: 0 occurrences of either fake password. |

## Processes and cleanup

- **Postgres 17:** PID 48326 (first run) and 18526 (final run), 127.0.0.1:64401, TCP only (no Unix socket), data dir in the scratchpad. Stopped with
  `pg_ctl stop -m fast`.
- **nats-server:** PID 48406 (first run) and 18534 (final run), port from `-1` (64402, 61093), `max_payload: 2MB`, user/password auth. Killed by that PID.
  The test file's own nats-servers are stopped by the test (`child.kill()` on its own child).
- **Check:** both PIDs confirmed gone. No pkill, killall or ipcrm.
- **`ipcs -m | wc -l`:** first run 8 before, 11 during, 10 after; final run 10 before, 11 after. `ipcs -mp` shows
  no segment created by either Postgres PID (48326, 18526); the extra ones belong to other processes. Nothing removed.
- **Stray nats-servers:** `ps -axo pid,command | grep plenary-nats-auth` listed none after all test runs.
- **All 12 mutations:** re-run on the final code (fresh scratch copy); all caught.
- **Mutations:** ran only in a scratch copy (`rsync --exclude .git --exclude node_modules --exclude '.env*'`; 0
  `.env*` files in it). `.env` was never read.
- **Scratchpad: NOT deleted, because `rm` is denied in this session.** Left in the session scratchpad: `tree/` (a
  repo copy without `.git`, `node_modules` or any `.env*`), `pg/` (the stopped Postgres data dir), `nats/` (its conf
  and log), run logs, `mutate.py`, and `pgpw`/the NATS conf, which hold only the fake passwords
  (`PgFake-pw-4wire2`, `NatsFake-pw-4wire2`). Nothing real or secret is there. Deleting it is the manager's call.

## NOT verified

- **Comma lists live:** a NATS URL list with credentials against a real NATS cluster (only one server ran). The
  parser and the redaction are unit-tested for lists.
- **TLS:** a `tls://` server live (parsing only).
- **Other credential forms:** NATS nkey or JWT credentials are not handled (not in the brief).
- **Empty values in deploy:** I found none in deploy/, scripts/cluster-rig.js or test/deploy/ (grep). I did not
  look at `.env`, so whether a local `.env` sets `DATABASE_URL=` or `NATS_URL=` to empty is unknown; after L7 such a
  node refuses to start.
- **The CLI logger's wrapper:** the `import.meta.main` path (uncaught-exception and start-refused lines) has no
  test of its own; it is the same `redactingLogger` call as start()'s.
- **Real drivers after the start:** only fake drivers produce the post-start leak (L2); real ones were checked by
  the verifier.

## Risks and notes for the manager

- **deploy/cluster/RIG.md is now stale (platform's file).** Lines 11-12 say empty URLs give a single node (now
  refused). Lines 14-15 say the bus drops `user:pass` from `NATS_URL` (M1 is fixed, so the rig's NATS could use
  auth now).
- **A raw comma in a NATS password** is read as a list separator: it must be percent-encoded (`%2C`) in NATS_URL.
  The redaction still covers it, because the whole value is read too.
- **Log shape:** the `bus error` line's `err` is now an Error object (`{name, message, code, stack}`) instead of a
  string. Anything parsing that line needs to read `err.message`.
- **Over-redaction:** a one- or two-character password would blank every occurrence of those characters in cluster
  log lines. This is safe, but noisy.
- **Cost:** each cluster log line now does a few string splits. That's cheap, but it is in every line.
- **L4 timing:** an open can now take ttl + min(1000, ttl/4) when a host answers `watching` late. The gateway's
  hello timer was already shown to handle a long open (p4-wirev, item 3).

# Brief: p4-wire2 (p4-wire fix round: the verifier's MEDIUM and 7 LOWs)

Read docs/m2/BRIEF-BASE.md first; its rules apply. Tab: `worker p4-wire2 (engine) · <id>: p4-wire fixes`.
Manager: `manager engine`, terminal `t18m`. Report to t18m only (one short `hc send` when done); never message the proxy
(t1bx). Don't commit. Report: docs/m2/reports/p4-wire2.md (what changed, tests added, how checked, NOT verified, risks).

## Context

p4-wire (commit 7bf171b) wired a cluster in server/main.js. Its verifier (docs/m2/reports/p4-wirev.md) passed it with the
findings below. Attack tests the verifier wrote may be in another session's scratchpad (`tree/test/attack/`); read them
for ideas if you find them, don't copy that scratchpad.

## Owned files (only these)

server/main.js, server/room-host.js, server/bus/nats.js; test/server/main.test.js, test/server/main-cluster.test.js,
test/server/roles.test.js, test/server/room-host-lease.test.js, test/server/nats-bus.test.js; one new test file
test/server/p4-wire2.test.js if you need it. PROTOCOL.md § Bus only if a behaviour there changes (say so in the report).
Another builder (p-tab) is editing PROTOCOL.md § hello, packages/protocol and server/gateway.js at the same time: if
`bun test` fails in a file you don't own, name it and re-run it alone before you call it theirs.

## Do

| Id | Where | Fix |
|---|---|---|
| **M1** | server/bus/nats.js:119 passes `servers: url`; the NATS client drops userinfo, so a password in NATS_URL is ignored | Parse user/pass (and a bare token, `nats://TOKEN@host`) out of the URL into the client's options; pass the host without userinfo. Test with a fake credential; assert it reaches the options and is absent from every error and captured log line. |
| **L1** | `redact()` main.js:122-136 | Also redact a query-string secret (`?password=`, `?token=`, any `pass`/`token`/`secret`/`key` param), a bare-token userinfo (`nats://S@h`), and comma-separated URL lists (each element). |
| **L2** | main.js:315 bus `onError` logs `code` raw; room-host.js:619 logs an unredacted err | Redact both; a test where the thrown error carries the fake password in message, `code` and `cause`. |
| **L3** | R2-L1 test | Add sweep-path coverage (room-host.js:515): a gateway silent past 30 s on an injected clock, then `welcomed === live welcomed conns`. |
| **L4** | room-host.js:659/674 | A `watching` reply late in the grace must not reject at the ttl: clear the ttl timer when the grace starts (or resolve at grace end regardless). Test on an injected clock. |
| **L5** | room-host.js:677-680 | A stale publish rejection settles by key: settle only if `inflight.get(key) === r`. Test: a late rejection for an old request leaves the new one pending. |
| **L6** | node id `"-"` passes (main.js:80, room-host.js:73) | Require an alphanumeric first and last character; refuse with a message naming PLENARY_NODE_ID. |
| **L7** | empty DATABASE_URL/NATS_URL count as unset (main.js:93) | Present but empty refuses to start, naming the variable (no value printed). Check deploy/, scripts/cluster-rig.js and test/deploy/ (platform's, read only) for an empty value they set; if one exists, don't break it: report it to t18m instead. |

Each fix gets a test that fails without it (say which mutation you ran).

## Gates

- `bun test` once (name every failure; test/core-source is known drift).
- `bun test test/server` 10x, 0 failures (a known pacing flake in test/server/v1.test.js: re-run it alone, report it).
- Once on Postgres + NATS (brew postgresql@17, nats-server, port 0 or free ports, scratch data dirs): `bun test test/server`
  with DATABASE_URL and NATS_URL set. Record PIDs; stop Postgres with `pg_ctl stop` only, NATS by recorded PID.
  `ipcs -m | wc -l` before and after; never `ipcrm`.

## Rules

- Never pkill/killall; kill by recorded PID only. Port 0 where you can.
- Never read, print or log `.env` or a real secret; tests use fakes. Any scratch copy of the repo excludes `.env`
  (`git worktree add` or `rsync --exclude .env`); no folder holding `.env` goes to a review tool (codex, grok, agy ...).
- Read big files in ranges (≤ 200 lines); filter test output. Delete your scratch at the end.

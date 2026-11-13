# Brief: p4-wire2v (verify the p4-wire fix round)

You are the p4-wire2 verifier, a CHECKER: try to break it, don't fix it. Don't edit any tracked file and don't commit.
Tab: `verifier p4-wire2 (engine) · <id>: verify p4-wire fixes`. Manager: `manager engine`, terminal `t18m`. Report to
t18m only; never message the proxy (t1bx) or the builder (t1km).
Report: docs/m2/reports/p4-wire2v.md: verdict PASS / FAIL first, then findings ranked HIGH / MEDIUM / LOW, each with a
repro (a command or a scratch test) and the file:line. Then one short `hc send` to t18m and stop.

## What is under test

- **Findings being fixed:** docs/m2/reports/p4-wirev.md (M1, L1-L7).
- **Builder's report:** docs/m2/reports/p4-wire2.md. Treat each claim as unproven until you reproduce it.
- **The diff:** uncommitted changes in server/main.js, server/room-host.js, server/bus/nats.js,
  test/server/main.test.js and the new test/server/p4-wire2.test.js. Other changed files (gateway.js, envelope.js,
  replica.js, PROTOCOL.md, tab.test.js, test/load/*, deploy/*, scripts/*) belong to other jobs: ignore them.

## Attack

1. **M1 NATS credentials:** `natsConnectOptions` with odd inputs: percent-encoded `@`/`:` in user or password, IPv6
   hosts, `tls://`, comma lists with mixed/identical credentials, a bare token, empty user or password. Can any value
   reach `servers`, an error message, or a refusal?
2. **L1/L2 redaction:** find a log line, refusal, `String(err)`, stack, `err.code`/`err.cause` or CLI output that still
   carries a fake password or token. Try nested causes, an Error whose message is not a string, a secret split across
   fields, and the postgres bare-user exemption (`postgres://secretword@host` — is a password-less userinfo ever a
   secret elsewhere?). Check over-redaction can't blank structural JSON and break the log line.
3. **L4/L5 timers:** a `watching` reply right at the ttl, `held` after `watching`, late replies after settle, publish
   rejection while a dedup waiter is attached. Worst case must be ttl + grace, never unbounded.
4. **L6/L7 env:** node-id and empty-URL edges; no refusal prints a value.
5. **L3 sweep:** `slot.welcomed` equals live welcomed conns after the sweep.
6. **Mutations:** re-run at least three of the builder's (include M1 and L4) plus one of your own, **only in a scratch
   copy of the working tree** made with `rsync -a --exclude .git --exclude node_modules --exclude '.env*'` (a git
   worktree would lack the uncommitted diff). Never mutate /Users/r/repos/plenary.
7. **Gates:** `bun test test/server` 5x (0 failures); `bun test` once (name every failure; test/core-source is known
   drift; tab.test.js / tune.test.js timing failures under full-suite load: re-run alone and say whether they pass);
   test/architecture.test.js green.
8. **Once on Postgres + NATS with auth:** `bun test test/server` with DATABASE_URL and NATS_URL carrying fake
   credentials (brew postgresql@17 and nats-server on free ports, scratch data dirs). Run `ipcs -m | wc -l` before and
   after. Stop Postgres only with `pg_ctl stop`; never kill -9, never `ipcrm`. Record PIDs; stop only those. If
   Postgres can't start for lack of a shared-memory segment, record it and skip this gate.

Process: never pkill/killall; port 0 where you can; never read or print `.env` or a real secret (tests use fakes); no
folder holding `.env` goes to any review tool; read big files in ranges (≤ 200 lines) and filter test output; delete
your scratch at the end.

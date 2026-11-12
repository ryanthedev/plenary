# Brief: p4-wirev (verify p4-wire rounds 1 and 2)

You are the p4-wire verifier, a CHECKER: try to break it, don't fix it. Don't edit any tracked file and don't commit.
Tab: `verifier p4-wire (engine) · <id>: verify cluster wiring`. Manager: `manager engine`, terminal `t18m`. Report to
t18m only; never message the proxy (t1bx) or the builder (t1j6).
Report: docs/m2/reports/p4-wirev.md: verdict PASS / FAIL first, then findings ranked HIGH / MEDIUM / LOW, each with a
repro (a command or a scratch test) and the file:line. Then one short `hc send` to t18m and stop.

## What is under test

- **Brief:** docs/m2/briefs/p4-wire.md (round 1) and docs/m2/briefs/p4-wire-r2.md (round 2, decision 1 changed).
- **Builder's report:** docs/m2/reports/p4-wire.md. Treat each of its claims as unproven until you reproduce it.
- **The diff:** the uncommitted changes in server/main.js, server/server.js, server/room-host.js, server/bus/port.js,
  PROTOCOL.md (§ Bus), test/server/main.test.js, test/server/main-cluster.test.js, test/server/roles.test.js and
  test/server/room-host-lease.test.js (`git diff` / `git status` against HEAD; the other changed files belong to
  other managers).

## Attack

1. **Env refusals and redaction:** every rule in the env table (both URLs, PLENARY_NODE_ID, PLENARY_ROLES,
   PLENARY_LEASE_TTL_MS, single-node rules, COOKIE_KEY). Find an input that starts when it should refuse, or a path
   where a URL value or password reaches an error, `String(err)`, a stack, `err.code`/`err.cause`, or a log line
   (including the CLI's printed error and the bus `onError` path). Check what `redact()` misses (userinfo with
   `@`/`:` encodings, a query-string password, a URL that is only a host).
2. **Roles:** a host-only node serves nothing but `/health`; a gateway-only node never acquires a lease (grep and test,
   don't trust the test names). `/health` reports roles truthfully.
3. **Remote open and grace:** held resolves at once; watching waits `min(1000, ttl/4)`; no reply rejects at the ttl;
   one request in flight per board per gateway; success never cached. Attack the timer edges (held arriving at the
   grace boundary, replies for another board or another requester, late replies after settle, a reject while a
   dedup waiter is attached).
4. **F5 with two hosts:** a writer through a gateway-only node gets exactly one welcome and exactly one ack per op;
   after the holder stops, the next hello is welcomed by the other host. Try to get a duplicate welcome or ack.
5. **R2-L1:** `slot.welcomed` stays equal to live welcomed conns across closes, listings and the sweep; `fail()`
   after a lost lease sends 1013 only to welcomed live conns.
6. **Mutations:** re-run at least three of the builder's mutations (one from each round) in a scratch copy and confirm
   they fail; add one of your own the tests should catch and say whether they do.
7. **Gates:** `bun test test/server` 10x (0 failures); `bun test` once (name every failure; test/core-source is known
   drift; test/deploy/cluster-rig.test.js is platform's and flaky under contention: re-run it alone before calling it
   a flake); test/architecture.test.js green.
8. **Once on Postgres + NATS:** `bun test test/server` with DATABASE_URL and NATS_URL set (brew postgresql@17 and
   nats-server on free ports, scratch data dirs).
   - **Shared memory is nearly full on this Mac** (kern.sysv.shmmni=32, ~30 orphan segments from killed postmasters).
     Run `ipcs -m | wc -l` before and after. **Stop Postgres only with `pg_ctl stop`**, never kill -9, so it frees its
     segment. If Postgres can't start for lack of a segment, record that and skip this gate. **Don't remove any
     segment** (`ipcrm`): that needs the CEO's OK.
   - Record PIDs; stop only those.

Process: never pkill/killall; port 0 where you can; never read or print `.env` or a real secret (tests use fakes);
read big files in ranges (≤ 200 lines) and filter test output; delete your scratch at the end.

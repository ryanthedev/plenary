# Brief: p2-tunev (verify p2-tune: revocation at scale, `here`, feed and test fixes)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture", the sdd
helpers), CLAUDE.md, PROTOCOL.md (v1.1 plus p2-tune's edits to § Auth, § Bus, § Presence), then the job's brief
docs/m2/briefs/p2-tune.md.

- **Your tab:** `verifier p2-tunev (engine) · <your id>: revocation at scale + here`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the job is uncommitted in the shared tree /Users/r/repos/plenary (main). Its files: server/gateway.js,
  server/feed.js, PROTOCOL.md (§ Auth, § Bus, § Presence only), test/server/rig.js, test/server/v1.test.js, and the
  new test/server/tune.test.js, test/server/harness.test.js. Other sessions are editing other files in that tree
  right now (server/server.js, server/main.js, server/registry/**, server/admin/**, web/**): ignore those.
  **Change nothing in /Users/r/repos/plenary** except your report. Run attacks, mutations and repeated runs in a
  copy in your scratchpad (`rsync -a --exclude .git --exclude node_modules --exclude .env`; never copy `.env`).
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p2-tunev.md: PASS or FAIL, findings HIGH/MEDIUM/LOW, each
  with a repro. Then stop, idle.
- Do **not** read the builder's report (docs/m2/reports/p2-tune.md) except its "Not verified", "Risks" and
  "Proposals" sections, copied below. Test against the code and the spec, not claims.

## Goal (from the brief)

R1 re-check passes never stall the gateway (coalesced per board, per user, yielding); R2 a Registry blip on the
timed pass never closes everyone, while a grants-triggered pass still fails closed (M1); R3 the revocation window
measured for 2,000 connections; R4 a foreign-board entry at seq + 1 refuses joins; R5 the timed pass and error rule
in PROTOCOL.md; R6 the flaky convergence test fixed by event-driven waits; `here` built to the spec, never logged,
bounded for 100k viewers.

## Done when (the job's)

- `bun test` green; also with DATABASE_URL and NATS_URL (local brew postgresql@17 and nats-server, started by you on
  free ports with recorded PIDs, stopped after). test/server 10x in a row, 0 failures, including R6's test.
- Tests exist and are real: coalescing (N grants during a pass give at most 2 passes); timed-pass error keeps then
  closes after the bound; grants-triggered error fails closed; foreign entry at seq + 1 refuses joins; `here`
  relayed between two clients, never in the log, bounded with many viewers.
- Each new test fails when its fix is undone.

## The builder's "Not verified", "Risks" and "Proposals" (verbatim)

- **Postgres cost of a pass:** a pass is users ÷ 8 sequential round trips; not measured against a real Registry
  under load (2,000 users at 2 ms ≈ 0.5 s, fine; 100k users ≈ 25 s, longer than one would like).
- **100k scale:** only 2,000 sockets were measured; the `here` pacing for 100k is an estimate (4 KB × 100k per send).
- **`here` over real NATS between processes:** tested with two gateways on one in-memory bus only.
- **`breather.js` yields per async chain** (not mine): N concurrent chains through `breathe()` hold the loop
  ~N × 8 ms (measured: 8 chains ≈ 65 ms). The gateway's per-connection pumps use it too.
- **A grants pass during a Registry outage closes everyone on the board** (fail closed, as M1 requires). Clients
  reconnect and are refused at hello until the Registry is back. This is the deliberate trade.
- **`viewers` counts connections, not people**; writers are counted by user.
- **`.here` subject is derived from `subjects.presence`** in the gateway; `server/bus/port.js` should get a
  `subjects.here`.
- **Closing one user's many tabs is a non-yielding loop** (bounded by `maxConnsPerUser`).
- Proposals: timed-pass error budget 3 retries at 2/4/8 s, then close; stop a timed pass after 3 errors in a row.
  `here` bounds: 50 writers per message, 15 s TTL per gateway, 1/s on change, every 5 s on boards over 1,000
  connections.

Note: the report's "Verification" section still reads `RUNS_PLACEHOLDER`; treat the builder's run claims as absent.

## How to check (minimum)

1. **systems-design skill, CHECKER mode** (/Users/r/repos/systems-design.skill) on the re-check path and `here`
   against the NFRs (2k annotators + 100k viewers per board, editors < 150 ms, a gateway never stalls, M1: a
   revoked user must not keep writing). Is fail-open on the timed pass bounded and safe? Can a grants message be
   lost or downgraded by coalescing (strictness retry < timed < grants)? Report what it found.
2. **Spec conformance:** the new PROTOCOL.md text vs the code, both ways. Every deviation is a finding.
3. **Attack it:** reproduce the stall measurement yourself (2,000 sockets, 20 grants; event-loop probe); revoke a
   writer during a timed-pass retry window and check it is closed by the grants pass; a Registry that errors on
   some users only; grants storms across many boards at once; `here` with thousands of viewers churning (bytes and
   sends per second per gateway); `here` or presence leaking into the Store log; the R4 path with a real foreign
   entry; the breather N × 8 ms risk: does any new code create N concurrent chains on one gateway?
4. **Mutation checks:** redo at least the coalescing, the grants-fails-closed, R4 and the `here` bound mutations
   yourself in the copy.
5. **Hexagonal:** gateway.js and feed.js import ports only; test/architecture.test.js green.
6. **sdd ensemble** of the job's diff (`git diff -- server/gateway.js server/feed.js PROTOCOL.md test/server/rig.js
   test/server/v1.test.js` plus the two new test files): codex + every harness that passes check_adapter; confirm
   or refute each two-harness finding.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete your scratch data at the end.

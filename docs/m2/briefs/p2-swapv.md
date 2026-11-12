# Brief: p2-swapv (verify p2-swap: the server on protocol v1.1)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture", the sdd
helpers), CLAUDE.md, PROTOCOL.md (v1.1, in the worktree), then the job's brief docs/m2/briefs/p2-swap.md.

- **Your tab:** `verifier p2-swapv (engine) · <your id>: server on v1.1`. Manager: `manager engine`, terminal `t18m`.
  Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the git worktree **/Users/r/repos/plenary-p2** (branch `p2-land`). The job is uncommitted there:
  `git -C /Users/r/repos/plenary-p2 status` and `git diff` (plus the untracked server/bus/port.js, server/feed.js,
  test/server/architecture.test.js, test/server/v1.test.js). **Change nothing in the worktree**; write extra tests
  and attack scripts in your scratchpad (a copy of the worktree is fine).
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p2-swapv.md: PASS or FAIL, findings HIGH/MEDIUM/LOW, each
  with a repro. Then stop, idle.
- Do **not** read the builder's report (docs/m2/reports/p2-swap.md) except its "Not verified" and "Risks" sections,
  copied below. Test against the code and the spec, not claims.

## Goal (from the brief)

The server runs protocol v1.1: room host on `Room.rebuild` / `room.receive` / the Store log adapter; gateway with
`v: 1` hellos, per-connection numbering, presence relayed by the gateway and never logged; catch-up read from the
Store, never over the bus; bus messages under 2 MB; Store epoch (`openEpoch`) in welcome.room and heartbeats; writer
cap 8 per (user, board, gateway) counting live sockets; op bucket per connection; `too-large` carries the op id;
Postgres Store works for a least-privilege role; platform's HTTP routes mounted with Google OIDC from env (null and
503 when absent; COOKIE_KEY rules); `start(env)` reads only its argument; a live connection's queue has a byte cap;
revocation (grants change re-checks live connections; token expiry closes); hexagonal (core imports ports only).

## Done when (the job's)

- `bun test test/*.test.js test/server test/auth` green in the worktree, except test/auth/google-live.test.js's 2
  known failures (fixed on main by d8fc084, which p2-land predates). Run it also with DATABASE_URL and NATS_URL set
  (local brew postgresql@17 / nats-server, started by you with recorded PIDs, port 0 or free ports, stopped after).
- No `SEAM(p2)` left in server/.
- Tests exist and are real: presence relayed and never logged; a resend after a restart gets the same seq; an op
  from a connection the rebuilt room never welcomed gets `unavailable`.
- Every scaffold gate still holds on v1: restart and kill -9 through main.js (run it 20+ times, also under load),
  depth limit, bad frames, auth before hello, slow reader, the outbound budgets.

## The builder's "Not verified" and "Risks" (verbatim)

- Load: nothing measured at 10k clients (M2 gate is a separate job). Bun's ping cadence vs the spec's 10 s.
- Postgres and NATS ran against local temporary servers, not CI's.
- `here` (spec item) not built. Cluster adapters are not wired in main.js; cluster mode only gates COOKIE_KEY.
- The feed can lag the host's checkpoint by up to one heartbeat (2 s) after a fold.
- Byte-triggered checkpoint (`tailFoldBytes`, 8 MB default, 2x bound) extends § Recovery "When": a spec ask.
- Queue overflow answers `unavailable` (PROTOCOL.md § Pacing), where the brief said "close with `limit`".
- Viewers never reach the room (rule 8): a viewer-only board gets its epoch from the Store / heartbeat.
- Registry mutations announce `grants` via a wrapper in main.js; session `verify()` doesn't return `exp` yet
  (expiry close tested with a fake).

## How to check (minimum)

1. **systems-design skill, CHECKER mode** (/Users/r/repos/systems-design.skill, skills/distributed-systems-design)
   against the room host, gateway, feed and Store epoch vs the NFRs in CLAUDE.md (one sequencer per board, an
   acknowledged op is never lost, presence may drop). Report what it found.
2. **Spec conformance:** read the diff against PROTOCOL.md v1.1 (§ Recovery, § Pacing, § Bus, § Settings, room
   identity / epoch, rule list). Every place the server deviates is a finding unless the spec allows it.
3. **Attack it:** acked-op loss across kill -9 and Store failures; two room hosts / epochs; resend dedupe across
   restart; presence leaking into the log; a revoked user keeping write access; a token past expiry; catch-up or
   entries frames over 2 MB on a small-cap bus; a flood on a live socket; env leakage (run main.js tests in a
   checkout with and without a .env-like environment; nothing from env logged).
4. **Hexagonal:** core (server.js, gateway.js, room-host.js, feed.js) imports ports only; only main.js picks
   adapters. Is test/server/architecture.test.js's hand-kept list complete?
5. **sdd ensemble** of the diff (codex + every harness that passes check_adapter); confirm or refute each
   two-harness finding.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete your scratch data at the end.

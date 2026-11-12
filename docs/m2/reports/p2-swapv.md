# Verifier report: p2-swapv (the server on protocol v1.1)

**FAIL**: 1 HIGH, 3 MEDIUM, 6 LOW. Every finding is about revocation or spec gaps; none touches durability.
The HIGH is the revocation goal: a user whose grant is removed while their hello waits on the room can still be
welcomed and write, and keeps writing. Everything else in the done-when holds: the suite is green (also on Postgres
and NATS), the acked-op durability gate passes 20 kill -9 rounds through main.js, there is no `SEAM(p2)` left, and
the three required tests exist and are real (each goes red when its behaviour is broken).

Verifier: t1fn (`plenary-p2-swapv`), 2026-11-12. Worktree /Users/r/repos/plenary-p2 (`p2-land`), uncommitted job
diff plus the 4 untracked files. Nothing in the worktree was changed. Attack tests:
`docs/m2/reports/p2-swapv.attack.js.txt` (named so `bun test` never picks it up; copy it to
`test/server/zz-attack.test.js` in a copy of the worktree to run). It prints what it observed: A1, A2, A7 and A8
show bugs, and so does M3 (at the end); the others (and S1) are attacks that passed. All 11 run green as written,
because they print what they saw rather than assert the bugs.

## Findings

| # | Sev | What | Where |
|---|---|---|---|
| H1 | HIGH | Revocation race: grants removed while a hello is between `auth.role` and going live are never re-checked; the connection is welcomed and writes | server/gateway.js:562-587, :461-471 |
| M1 | MEDIUM | Revocation fails open: a `grants` re-check whose `auth.role` throws keeps the connection with its old role, and nothing retries | server/gateway.js:466 |
| M2 | MEDIUM | Token expiry never closes a real session's connection: `authPort.verify` (session.js) returns no `exp` | server/auth/session.js:39 (platform), gateway.js:589 |
| M3 | MEDIUM | A share link's or invite's `expiresAt` passing never re-checks live connections: the user keeps writing | server/main.js:54-75, gateway.js:461 |
| L1 | LOW | `here` (§ Presence, § Bus `.here`) not built | gateway.js |
| L2 | LOW | A gap in the Store log is served silently: a viewer is welcomed at the seq before the gap, never gets later entries, and nothing is logged | server/feed.js:52-77 |
| L3 | LOW | Byte-triggered checkpoint (`tailFoldBytes`) checkpoints before 1,000 entries: § Recovery "When" says every 1,000 entries **or later** | server/room-host.js:54-58, :106-111 |
| L4 | LOW | Architecture test's core list is hand-kept, and adapter → adapter imports aren't checked at all (two exist) | test/server/architecture.test.js:9 |
| L5 | LOW | `grants` subject and the `{ gateway, conns }` list are used but `grants` isn't in PROTOCOL.md § Bus; `.gw.<gateway>` isn't per board (SEAM(p4)) | server/bus/port.js:38-41 |
| L6 | LOW | An `exp` more than 24.8 days out closes the connection at 24.8 days with "your sign-in expired" (setTimeout cap; exp not re-checked) | server/gateway.js:590-591 |

### H1 (HIGH): revoked during the hello, the user still writes

`hello()` checks the role (gateway.js:562), then awaits `joinBoard` (feed ready: Store reads) and `rooms.open`
(a full rebuild for a cold board: seconds on a big log). The connection joins `b.conns` only at :585. A `grants`
message in that window runs `recheck(b)` over `b.conns`, which doesn't hold this socket yet, so it is skipped. For
the first connection on a board the `grants` subscription doesn't even exist until `joinBoard`, so the message is
simply lost. After the awaits only the caps are re-checked, not the role. The connection goes live with the old
role and keeps it until some later grant change on that board.

Repro (attack test A1): a rig whose `store.openEpoch` waits on a gate; editor sends hello; once `auth.role` ran,
`registry.setGrant(board, "dev:editor", null)` and publish `subjects.grants(...)`; open the gate. Observed:
`welcome {role:"editor"}`, then `op editor:1` → `{"t":"ack","seq":1}`, and the log holds `editor:1 by dev:editor`.

Why HIGH and not MEDIUM: the user can't open the window on demand (an admin's change must land inside it), and on
a warm board it is short. On a cold board it lasts the whole rebuild (seconds on a long log), and the first
connection on a board has no `grants` subscription at all until `joinBoard`. What makes it HIGH is that the outcome
is permanent: the connection keeps the removed role until some later grant change on that board, and the brief's
revocation goal is exactly this case. The manager may weigh it differently.

Fix idea: a per-board grants generation counter (bumped by every `grants` message, subscribed before the role
check), compared after the last await; on change, re-run `auth.role` before going live. Or add the socket to
`b.conns` before the awaits and let `recheck` handle sockets in `auth` state.

### M1 (MEDIUM): a failed re-check keeps the old role

`recheck` does `catch → log.warn("role re-check failed; connection kept") → continue` (gateway.js:466). If the
Registry is briefly down when the `grants` message lands, a revoked connection keeps writing indefinitely. Hello
treats the same outage as `unavailable` (fail closed); the re-check should too (close with `unavailable`, so the
client reconnects and its hello does the check), or retry. Found by codex in the ensemble; confirmed.

Repro (A7): welcome as editor; `setGrant(…, null)`; make `auth.role` throw; publish `grants`; restore `auth.role`.
Observed: socket still open, then `op editor:1` → `ack seq 1`.

### M2 (MEDIUM): token expiry is a dead path for real users

The gateway arms `expTimer` only if `identity.exp` is finite. `sessions.verify` (server/auth/session.js:39) returns
`{ user, name, email, domain }`, never `exp`; `authPort.verify` passes that through. So a live socket opened with a
12 h session token stays open and writing past expiry. v1.test.js:176 passes only because it injects `exp` with a
fake verify. The builder disclosed this; it still leaves the brief's "token expiry closes" undone end to end.

Repro (A2): `sessions({ ttlSec: 1 })`, issue a token for `dev:editor`, use the real `verify`; hello, wait 2.5 s.
Observed: `exp` absent from the identity, socket not closed, `op sx:1` → `ack seq 1`.

**Platform must change** (server/auth/ is theirs): return `exp` from `sessions.verify` (and keep it through
`authPort.verify`). The gateway side is ready. The p2-swap brief allowed a port-level hook plus a fake plus a note
to platform, and the builder did exactly that, so **M2 does not gate this job**: it is a platform follow-up, listed
here because "token expiry closes" is false in production until it lands.

### M3 (MEDIUM): an expiring link or invite keeps working on a live socket

`tenancy.role` counts a link or invite only while `t < expiresAt`, but it is read only at hello and on a `grants`
message. `announcingRegistry` (main.js:54) announces the six mutating calls; time passing is not a call, so nothing
re-checks. (`addTenantAdmin` isn't wrapped either, but it only raises roles; board `memberRole` and tenant domain
have no setters today.)

Repro (attack file, test M3): `createLink({ board, role: "editor", expiresAt: now + 800 })`, `addLinkUse(link, "dev:stranger")`;
stranger says hello → `welcome role editor`; wait 1.5 s. A new hello is refused `auth`, but the live socket is
still open and `op stranger:1` → `{"t":"ack","seq":1}`.

Fix idea (engine): re-run `auth.role` for every live connection on a slow timer (say every 60 s) as well as on
`grants`; or have `role()` return the time its answer stops being true (platform) and arm a timer like `expTimer`.

### L1–L6 (each with its repro)

- **L1 `here`:** spec message and `.here` subject not built (builder disclosed). Repro by reading: no `here` or
  `.here` anywhere in server/ (`grep -rn 'here' server/bus/port.js server/gateway.js`); no test covers it.
- **L2 log gap:** A8 inserts seq 3 after seq 1 straight into SQLite. A viewer gets `welcome seq 1` + `entries:1`, no
  error logged, and the 5 s poll stops at the gap forever. § Recovery calls a gap corruption (the room refuses to
  start, and does), but a viewer-only board never opens a room. Log an error at least. Found by codex; confirmed.
- **L3:** extends § Recovery "When"; harmless (it only checkpoints earlier) but a spec change: write it in
  PROTOCOL.md or drop it. Repro by reading room-host.js:106-111: `foldIfDue` calls `room.checkpoint()` once the
  tail reaches 8 MB and half the state, at any entry count.
- **L4:** `CORE` covers every non-main file in server/ today, but a new core file is unchecked until someone adds
  it. A list of "every server/*.js except main.js" would close that. Not checked at all: adapters importing adapters.
  Two already do: `server/blobs/s3.js → ./disk.js` (engine's, pre-existing) and
  `server/registry/postgres.js → ../store/postgres.js` (platform's, pre-existing).
- **L5:** document `plen.<t>.<b>.grants` and its message in § Bus. Repro by reading: bus/port.js:38 defines it;
  `grep -n grants PROTOCOL.md` finds no subject.
- **L6:** re-check `identity.exp` when the timer fires and re-arm if it is still in the future. Repro by reading
  gateway.js:590-591: `ms = min(2^31-1, exp*1000 - now)`, and the callback closes without looking at `exp`.

## Done-when, checked

| Gate | Result | How |
|---|---|---|
| `bun test test/*.test.js test/server test/auth` | **green** (427 pass, 80 skip, 2 known google-live fails) | in the worktree, no DATABASE_URL/NATS_URL |
| …with DATABASE_URL and NATS_URL | **green** (486 pass, 19 skip, same 2 fails) | local postgresql@17 (initdb in scratch, port from the OS) and nats-server (max_payload 2 MB), PIDs 38519 and 38520, stopped after |
| Postgres least privilege | **pass**: the non-owner-role test ran (no skip warning) | pg-store.test.js:105 against the scratch cluster |
| No `SEAM(p2)` in server/ | **pass** (`grep -rn 'SEAM(p2)' server/ test/server` empty; SEAM(p3)/(p4) remain, by design) | grep |
| Presence relayed, never logged | **real test** (v1.test.js:15). Mutation: gateway also forwards presence to `.inbox` → test **fails** | scratch copy |
| Resend after restart → same seq | **real test** (v1.test.js:61). Mutation: rebuild ignores the log after the checkpoint → test **fails**. Also A3/A4 and 20-round kill -9 | scratch copy |
| Op from a connection the rebuilt room never welcomed → `unavailable` | **real test** (v1.test.js:82). Mutation: room host connects any unknown conn → test **fails** | scratch copy |
| kill -9 through main.js, 20+ times under load | **pass**: main.test.js's kill -9 test with 20 rounds instead of 3. Load = one writer streaming ops continuously (up to 200 unacked in flight at each kill, both directions busy), ≥ 3,000 acks in all. Every acked op in the log at its acked seq, no gap, no op twice, every resend landed once. Not tested: many writers at once through main.js | scratch copy, 90 s |
| Depth limit, bad frames, auth before hello, slow reader, outbound budgets | **pass**: their tests are in the green run. The job's test diffs were read for deleted or loosened tests: one removed ("slow auth: a hello and an op in one tick… the op is acked") is replaced by rule 11's v1 behaviour (an op before `welcome` gets `auth`, new test); changed assertions follow v1 (viewers never reach the room, so they aren't closed by a room failure; ops carry `sentAt`; entries are `{from,to,items}`); outbound.test.js:463 forces a checkpoint because its subject is the shared-text bound, not the fold trigger. No new `.skip`. With Postgres and NATS on, the 19 skips are the S3 tests (no S3_ENDPOINT) and the live-Google tests: none of this job's | git diff test/server |
| Flood on a live socket | **pass**: v1.test.js:226 (past 8 MB of unread live frames → `unavailable`, close) and :158 (op queue cap) are in the green run; not re-attacked separately | suite |
| § Settings through the gateway | **pass** (attack file, test S1): `appBase` rides inside `op`, which the gateway passes whole (gateway.js:652). Base 0 → `ack seq 1`; a second op on base 0 → `stale-setting` "grid changed since your copy (appSeq 1, your base 0)" | scratch copy |
| `start(env)` reads only its argument | **pass**: `grep -rn 'process.env\|Bun.env' server/` finds only main.js:168 (the entry point) and a comment in blobs/s3.js | grep |

## Attacks (what else was tried)

| Attack | Result |
|---|---|
| A3: append durable but answered after the 4 s timeout | `unavailable` + close; rebuilt room (epoch 2) welcomes with `high: 1`; resend → `ack seq 1`; logged once. **Pass** |
| A4: the write itself lands after the timeout | late append gets `conflict`; resend → `ack seq 1`; log `[1:editor:1]`. **Pass** |
| A5: two room hosts (two servers, own buses) on one SQLite Store, 60 ops each | 120 entries, seqs 1..120, no op twice, all 120 acks match the log; the losing host fails over with `unavailable` and clients reconnect. **Pass** (the conditional append is the fence, rule 9) |
| A6: 9 parallel writer hellos, then close one | 8 welcomes + 1 `limit`; a closed slot frees at once. **Pass** |
| A9: bus capped at 64 KB, 60 ops of ~25 KB, then a viewer from 0 | no publish refused (largest bus message 51.8 KB, `.entries` split); catch-up of ~1.5 MB came from the feed, not the bus. **Pass** |
| Env leakage | main.test.js with fake GOOGLE_*/COOKIE_KEY/LOG_LEVEL=error in process.env: 10/10 pass (same as without). main.js run with fake secret values: 4 log lines, none holds a value (`sign-in`, `dev tokens are ON`, `server listening`, `server stopped`). **Pass** |
| Hexagonal | server.js, gateway.js, room-host.js, feed.js import only packages/protocol, `./bus/port.js`, ids/log/breather. **Pass** (see L4 for the test's gaps) |

## Systems-design CHECKER (distributed-systems-design skill, against CLAUDE.md's NFRs)

- **One sequencer per board:** holds. Fence = `append(…, expectSeq)` checked in one transaction (sqlite, postgres);
  epochs number incarnations but don't fence (as § Recovery says). A5 shows two hosts can't both log a seq.
- **An acknowledged op is never lost:** holds for host crash (20 × kill -9), slow and late Store writes (A3, A4).
  Ack strictly after `store.append` resolves (room-host.js:92) and only through the Room's held answers.
- **Presence may drop, never saved:** holds; presence goes gateway → `.presence` → coalescer, never `.inbox`.
- **Eventually consistent delivery:** holds; feed repairs gaps from the Store, polls after 5 s of silence. Gap in
  the Store itself: L2.
- **Failure per component:** Store slow/failing → `unavailable` + rebuild (good). Bus loss → Store poll (good).
  **Registry outage during a re-check → fails open (M1).** **Time-based loss of access (link/invite expiry,
  token expiry) → not enforced on live sockets (M3, M2).** Gateway crash → clients reconnect (rule 12).
- **Rate limiting:** per-connection op bucket and per-connection byte caps in every state (c.q 8 MB live, opq
  500/8 MB, out 16 MB). Not process-wide once live (`queuedTotal` cap applies only before live, gateway.js:748);
  one user may hold 64 sockets. Not a finding at M2 scale, worth a look at the load test.
- **SPOF / scale:** single node by design; cluster adapters (Postgres, NATS) pass their contracts but main.js
  doesn't wire them (builder disclosed; M2 cluster wiring is a separate job). Viewers never reach the room (rule 8):
  the 100k-viewer path is gateway + feed + Store only. Nothing measured at load (M2 gate job).

## sdd ensemble

- `check_adapter`: codex **ok**, grok **ok**; agy **failed** (quota, resets in ~61 h), kimi **failed** (no model
  configured), mistral **failed** (no MISTRAL_API_KEY); qwen not installed.
- codex (effort high), 5 findings; grok: "Clean, no findings". **No finding had two harnesses agreeing**, so no
  HIGH candidate came from the ensemble. grok's "clean" carries no weight: it cites `room-host.js:1-1260+` for a
  282-line file and a `test/v11.test.js` that doesn't exist, so it did not read what it claims. Each codex finding,
  checked:
  - recheck fails open → **confirmed** (M1, A7). codex called it HIGH; MEDIUM here because it needs a Registry
    outage at the moment of the change.
  - cached presence rebroadcast forever → **refuted**: `presenceCoalescer.flush()` empties it (presence.js:92);
    expiry is the receiver's job (§ Presence).
  - Store log gap served as a short catch-up → **confirmed**, LOW (L2): corruption-only.
  - `blob` refused as unknown → **out of scope** (SEAM(p3), not this job).
  - no `here` → **confirmed**, LOW (L1).
- H1 was found by reading, not by the ensemble, and confirmed by A1.

## Not verified

- Bun's ping cadence vs § Pacing's 10 s ping / 30 s close (v1.test.js:244 covers the close, not the 10 s ping).
- Load at 10k clients; NATS/Postgres as wired by a cluster main (not wired yet).
- Real Google sign-in (no `.env` here, by rule).

## What must change to PASS

1. H1 in server/gateway.js (engine): this alone gates.
2. M1 and M3 in server/gateway.js (engine): fix in the same round, since both are cheap and on the same path.
3. For platform, not gating this job: M2 (`sessions.verify` returns `exp`).

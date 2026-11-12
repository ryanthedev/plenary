# Report: p3-scaffoldv2 (re-verify the single-node server scaffold, round 2)

**Verdict: FAIL.** One HIGH: an annotator, with about 280 legal ops, makes a board unjoinable for every newcomer, and
it survives a restart. The same flaw lets a viewer pin about one board's worth of server memory per socket. Two
MEDIUM, five LOW.

- **Round 1:** its H1 (deep nesting) is **closed, measured**, and so are its five MEDIUMs. Of its LOWs, all are closed
  except L6, which is reduced.
- **kill -9 and restart through main.js:** both held under my own attack.
- **The flaky convergence test** (manager's add-on) is **a timing assumption in the test, not a server bug**: L5,
  with evidence.
- **Housekeeping:** I did not read docs/m2/reports/p3-scaffold.md. I changed nothing in the repo except this file and
  committed nothing.

## What I checked, and how

| Check | Result |
|---|---|
| `bun test` (whole repo) | 261 pass, 0 fail at the start; 263 pass, 0 fail later (other sessions added tests); then 15 more full runs, 15 × 0 fail. `test/server/main.test.js` alone 3×: 5 pass each time |
| Read in full | server/{gateway,server,room-host,main,log,ids}.js, bus/memory.js, blobs/disk.js, store/sqlite.js; test/server/{main,store,ports}.test.js, rig.js, helpers.js. **gateway.test.js only in parts:** the bad-frame cases, the append-failure modes, H1, catch-up per `since`, M1/M4, M2, M5, L5, L7 and convergence. Checked against PROTOCOL.md (committed 7e834d2): § Limits, Messages, Rules, Recovery, Ports, plus packages/protocol/room.js and envelope.js |
| Done-when coverage | store.test.js (10 tests) asserts the § Store contract as named: the pragmas read back (WAL, FULL, fullfsync), conflict when behind, taken or ahead, atomic batches, ascending limited reads, per-board/tenant logs, bad ids, highest-seq checkpoint, `beforeSeq`, reopen, and two handles fenced. ports.test.js asserts Blobs (round trip, mismatch, 10 MB edge, tenant isolation, a traversal list, image types, torn temp files, 8 concurrent puts), Bus (subjects, order, at-most-once, throwing subscribers, re-entrancy) and logs (redaction, one line). Gateway over a real socket: present |
| Scratch tests | In a `mktemp -d` dir under my session scratchpad (outside the repo), importing the repo's code by absolute path. Port 0 everywhere. Every child server was killed by its recorded PID. `git status --short --ignored` shows nothing new from me, and there is no `data/`. **Not cleaned:** the `p3v2-*` temp dirs my child scripts made in the OS temp dir (the delete was refused by the permission prompt) |
| sdd review | codex only, effort high: **single harness**, so its findings are leads. The hash of server/, test/, packages/ changed during the run, but only test/web/ui-session.test.js changed (another track's session); none of this job's files changed |

## Round 1's findings: what became of each

| # | Status | How I know |
|---|---|---|
| H1 deep nesting | **Closed, measured** | **Over real sockets:** 100 ops 30,000 deep from one annotator are refused (`bad-op`, struck out after 8), nothing is stored, and later joins take **5–7 ms** with `/health` under 1 ms. Same after a restart and with `compactEvery: 2` (round 1: 2.1 s per join, 15.5 s after a restart). **The depth scan:** it agreed with real `JSON.parse` depth on 56,174 fuzzed cases at bounds d−1, d and d+1. Those cases mixed strings holding `[ ] { } \" \\`, `[`, lone surrogates, and pretty-printed whitespace. Exactly 64 levels pass and 65 are refused. A 4–5 MB flat or bracket-heavy frame scans in 4–8 ms. **Encode once:** with a 30,000-deep entry put straight into the Store (legacy data), the first join after a restart takes 1.04 s (the rebuild) and later joins 6–9 ms |
| M1 pre-auth memory | **Closed per connection, measured.** Process-wide: L1 | 200 sockets behind a 6 s `verify`, each a hello plus 2 MB: 2.4 MB per socket, as bounded. All got `auth` once `verify` answered |
| M2 slow sign-in told `auth` | **Closed** (reading :225; repo test M2 read) | |
| M3 `version` code | **Closed** (reading :122; the test asserts the code per case, gateway.test.js:124) | |
| M4 > 1,023 unsent ops | **Closed** for small ops (repo test: 1,500 ops behind a 30 ms sign-in, all acked). Over 2 MiB gets `unavailable`, marked SEAM(p2) at :237 | |
| M5 unmarked v1 gaps | **Closed** (reading plus repo tests) | Viewers: SEAM(p4) at :144. `n` gap check: done (room-host.js:149, with a test). `transient`: refused (:181, test). Blob quota: SEAM(p3). Presence before hello: dropped (:173, test). The rest of this class is in M2 |
| L1 `ws.send` 0 / backpressureLimit | **Closed** | Reading :103, :214. Live slow reader re-run on raw TCP: 1013, and the 37 entries before the close were seq 1..37, gapless |
| L2 blob race / dir fsync | **Closed** (reading; repo test: 8 concurrent puts) | |
| L3 checkpoints | Marked SEAM(p2) (store/sqlite.js:39) | |
| L4 late append test | **Closed** (repo test "times out and then lands late" read) | |
| L5 hello throw | **Closed** (room-host.js:169; repo test read) | |
| L6 rebuild page size | **Reduced, not closed** | Pages are still counted in entries: now 100 entries of up to 1,000,000 chars each (about 100 MB of text), not 1,000 |
| L7 strikes never reset | **Closed** (:114; repo test read) | |

## HIGH

**H1. An oversized catch-up is sent as one frame and judged against a byte bound right after sending. An annotator can
make a board unjoinable, and a viewer can pin a board's worth of memory per socket.**
- Where: server/gateway.js:94-104 (`maxCatchUpBytes`, new in round 2, 256 MB) and server/room-host.js:106-121, 194.
  The whole tail goes out as one `entries` frame, and the tail is folded only at 1,000 entries.

**Board made unjoinable: measured on `bun server/main.js` with dev tokens, from a separate process.**
- **The attack:** an annotator rewrote its own note 280 times at 990 KB each. All were legal and acked. The note stays
  about 1 MB, but the kept tail is 277 MB.
- **Before the restart:** three viewers joined with `since: 0`. Each got `welcome` and was closed (the client saw
  1006; the server logged "slow reader closed" 3 times). None got any catch-up.
- **After a SIGTERM restart on the same data:** the same, 3 out of 3. The rebuilt tail is still under 1,000 entries,
  so it isn't folded.
- **Same in the in-process rig.** At reduced limits (bound 2 MB, tail 2.7 MB), even a fast reader was closed 3 out of
  3 times (1013), so reading speed doesn't matter.
- **It heals only when 1,000 entries are reached** and the tail folds into a snapshot, so another ~720 ops are needed.

**Inferred, not measured:**
- Writers are locked out too: rule 5's resync after any refusal reconnects with `since: 0`.
- Each failed join buffers about 277 MB for a moment, so honest viewers retrying at once multiply memory.
- Round 1's 16 MB bound would have broken a board after about 17 such ops. Round 2 raised that threshold to about 270
  rather than introducing the flaw.

**Memory pinned by non-readers: measured on `bun server/main.js` with dev tokens.**
- The board held 20 MB (40 × 500 KB ops).
- 40 viewer sockets from a Python client that never reads held about 20 MB each: an 868 MB process footprint
  (`top` MEM; RSS looks lower because macOS compresses the pages).
- Silent sockets were reaped by `idleTimeout` at about 120 s. Sockets that **send a presence frame every 10 s were
  not**: they held 868 MB until the client quit at 170 s.
- There is no per-user connection cap and no process-wide budget for buffered bytes. Measured growth was linear: 20
  sockets 0.4 GB and 60 sockets 1.2 GB in-process; 40 sockets 0.87 GB on main.js.
- That one viewer account can take the process down for every tenant this way is an extrapolation, not measured.
  Per socket, the ceiling is the catch-up size, up to 256 MB.

**Builder's lists:**
- "16 MB slow-reader close has no repo test" is related.
- The oversized-catch-up close and the presence keep-alive are on neither list.
- `maxCatchUpBytes` isn't named as a risk.

**Fix, scaffold side:**
- Send catch-up in chunks of a few MB, paced by Bun's `drain` handler. A reader then holds at most one chunk plus the
  live bound, and no frame can exceed a bound.
- Fold the in-memory tail by bytes as well as by count (for example, at 8–16 MB). This is the SEAM(p2) stand-in.
- Close a socket that has bytes buffered and has drained nothing for N s, whatever it sends.
- Optionally cap connections per user per board.
- Add tests: a tail over the bound still reaches a fast joiner; a non-reader that keeps sending is closed.

**Fix, spec side (engine):** § Recovery checkpoints by entry count ("every 1,000 entries, or later"), so the kept tail
has no byte bound. Gateway-served catch-up (p2/p4) inherits this. Add a byte trigger.

## MEDIUM

**M1. One writer's burst freezes the whole process, about 0.9 ms per op, and nothing yields between ops.**
- Where: the gateway pump (gateway.js:196-206), the bus (memory.js:32-48) and the room chain (room-host.js:76, 178)
  hand off through microtasks only. Each op is its own synchronous SQLite append with `fullfsync`.
- Measured on `bun server/main.js` with dev tokens, one editor sending a hello and N small ops in one burst:
  - **6,400 ops: `/health` took 5.6 s**;
  - **500 ops: `/health` took 0.47 s**.
- In-process, the event loop's longest gap was 4.1–4.2 s, with instant auth and with a held one.
- The 2 MiB pre-welcome queue (a named hunt item) holds about 6,400 such ops and drains as one run.
- Extrapolated: an honest v0 Replica resending 1,500 pending ops on reconnect stalls every board for about 1.3 s.
- Why MEDIUM and not HIGH: each stall is transient and ends when the burst is stored. The cause is disclosed (round 1
  risks: "every fsync runs on the event loop; no rate limit"), and its remedy is marked SEAM(p2) at gateway.js:176
  and room-host.js:57 (§ Pacing and group commit).
- Fix: yield to the macrotask queue between inbox messages (every few ms of work), so a burst costs others latency,
  not a freeze. Then land § Pacing and group commit in p2.

**M2. Divergences from PROTOCOL.md with no SEAM mark.** All are harmless on one node today.
- **Rule 11, ops before `welcome`** (codex lead, confirmed by reading).
  - Where: gateway.js:150-153 forwards frames queued behind the hello as soon as the hello is forwarded, before the
    room's `welcome` reaches the client. Rule 11 says pre-welcome ops get `auth`.
  - Safe today: the room handles the hello first (`n` order).
  - Deliberate: today's v0 Replica sends its pending ops behind the hello, and the M4 test relies on it.
  - The SEAM(p2) note at :237 covers the queue bound, not rule 11.
- **§ Bus shapes.**
  - The room → gateway subject is `plen-gw.<gw>` (memory.js:21-22), not `plen.<tenant>.<board>.gw.<gw>`.
  - The close notice is `{bye: true}` with no `n` (gateway.js:84), not `{n, closed: true}`.
  - Inbox messages carry no `name` (:157), and there is no 5 s open-connection list.
- Fix: mark each `SEAM(p2/p4)` with the rule it defers, or match the spec. (Round 1 filed this class as one MEDIUM, M5.)

## LOW

| # | Where | What | Fix |
|---|---|---|---|
| L1 | gateway.js:28, 240-243 | Pre-welcome bytes are bounded per connection only. Measured: 200 sockets with bad tokens behind a 6 s `verify` hold 487 MB (base 12 MB), unauthenticated. It needs a slow `verify`; dev auth answers at once. codex (confirmed by reading): `sizeOf` counts UTF-16 units, so non-Latin-1 text can hold up to about 2× the stated "bytes" | A process-wide budget for pre-welcome bytes, or a cap on sockets in state `auth`. Count bytes, or call it chars |
| L2 | packages/protocol/envelope.js:21 (not this job's file) | § Limits says `opProblem` checks depth too, "so replay and other transports are covered". No depth check exists in packages/protocol. Measured: an entry already in the Store 30,000 deep costs 1.04 s on the first join after a restart. Only legacy or hand-written data can reach it now. codex also notes `opProblem` checks `id` before shape, against § Limits' check order (reading) | Engine (p2): add the depth check to `opProblem` |
| L3 | main.js:59-62 | A kill between `createBoard` and the rename of dev-board.json mints a second dev board on the next start. Builder-disclosed; dev only; reading | None needed now |
| L4 | gateway.js:24, 167 | The depth bound is on the whole frame. Measured: an element field can be nested at most 60 levels (gateway.test.js:442: the frame adds 4 around `customData`). The builder says "≤ 62" for the op. That is consistent: the frame adds 2 around `op`. The spec's `opProblem` counts the op alone | Note it in § Limits, or count from `op` |
| **L5** | **test/server/rig.js:117-124 (`settled`)**: the flaky convergence test | **A timing assumption in the test, not a server bug.** Details below | `settled()` must wait for a client that is reconnecting (see below) |

## The flaky convergence test (manager's add-on): a test timing assumption, not a server bug

The report: `gateway.test.js:627` "clients converge … (seed 2)" failed in 2 of 7 full runs on the platform verifier's
machine. A client's `state()` was nearly empty after `settled()`.

- **Repo test as is:** 12/12 alone, 12/12 alone under 6 busy CPU loops, 15/15 full suites. Not reproduced, so it is
  rare on this machine right now.
- **Scratch copy of test/server (imports pointed at the repo; server code untouched), plus a log line at the failing
  assertion:** **3 failures in 25 runs**. All three show the reported signature:
  ```
  {"name":"annotator","open":false,"hasSock":false,"reconnecting":true,"resyncs":4,"applied":0,"roomSeq":142,"pending":11,
   "lastErrors":[{"code":"forbidden","message":"that note is someone else's"}, …]}
  ```
  In each failure, the annotator's random edit touched another user's note. The room refused it with `forbidden`
  (correct, by role), and the Replica started the rule 5 resync: it drops its copy and reconnects with `since: 0`.
- **The cause:** `settled()` treats any client that is not open as settled (`!c.open || …`, rig.js:122). In the
  instant between `drop()` and the new socket opening, the reconnecting client counts as done with `applied: 0`. The
  test then compares that empty state with the room's.
- **A/B on the same machine, same copy:** I changed only `settled()` to also wait while a client is reconnecting
  (`!c.reconnecting && …`, with `reconnect()` setting the flag until `connect()` returns). Result: **25/25 pass**, with
  every assertion intact (every client's full state equals the room's, the log check, and the restart). The original
  `settled()` got 22/25.
- **So:** once the refused client finishes its resync it converges. No ordering or convergence fault in the server
  showed up in 50 instrumented runs.
- **Severity: LOW** (a test defect). It does block a clean CI, so fix it before the commit.
- **Fix** (test/server/rig.js, this job's file):
  - In `client.reconnect()`, set `c.reconnecting = true` until `connect()` returns, and don't let `drop()` make a
    reconnecting client look intentionally closed.
  - In `settled()`, require `!c.reconnecting` for every client.
- I first tried widening the window with a 40 ms delay before the reconnect. That made both versions fail for
  another reason: the test's main loop also calls `connect()` on a client with no socket, so a second socket raced.
  I discarded that run. The result above is without any added delay.

## Things I tried to break that held

| Attack | Measured |
|---|---|
| **kill -9 through main.js** (my own variation: two writers, an editor on `board` and an annotator on `notes`, 5 kills at random 150–1,050 ms points, every pending op resent on each reconnect) | 3,360 ops: the log is gapless 1..3,360, every op once, all 3,360 acked, **0 acks whose seq differs from the log, 0 re-acks with a different seq, 0 errors**. The builder's kill -9 and restart tests passed 3 runs out of 3. Process crash only: power loss not tested |
| **Dev-token seeding** (new) | main.test.js read: role orders `[owner, viewer]`, `[viewer, owner]`, `[editor, owner, annotator]` for one user all give `owner`. The restart test keeps the last owner when a token demotes it, and logs that. Bad `PLENARY_DEV_TOKENS` leaves dev tokens off. All passed 3/3 runs. main.js:66-79 read: one grant per user, highest first, only `last-owner` is tolerated |
| **Catch-up cache vs compaction** | `Room.compact()` installs a new `base` object (room.js:104), so a cache keyed on `base` identity and tail length can't serve a stale snapshot. The repo test (gateway.test.js:458) joins across a fold at every `since` and checks the same bytes go to every joiner |
| **Live slow reader** (round 1's attack, re-run on the rewritten code) | 1013, a "slow reader closed" log, and what arrived first was gapless |
| **Pre-auth reach** | Re-read this round: frames queue behind the hello's awaits and are dropped when `end()` runs (:83). The M2 test shows a late answer opens nothing |
| **Cross-tenant, traversal, tokens in logs** | Re-read this round: `isId`/`needId`/`isSha1` at every port; subjects built from the Registry's record. The ports.test.js traversal lists and the main.js tests (no `S3CR3T` in stdout) passed |

## codex (single harness) leads, and what became of each

| codex said | Outcome |
|---|---|
| MEDIUM: ops accepted before `welcome` (rule 11) | Confirmed by reading: part of M2 (safe today, unmarked) |
| LOW: `opProblem` checks id before shape | True by reading; packages/protocol, not this job: noted in L2 |
| LOW: queue counts UTF-16 units, not bytes | True by reading: in L1 |
| No depth-scan, durability or cross-tenant defect | Agrees with my measurements |

codex did not find H1 or M1; both came from measurement.

## The builder's round-2 not-verified list

| Item | What I found |
|---|---|
| H1 bounds only, not timings | Timed: joins 5–9 ms, `/health` < 1 ms |
| `ws.send` 0 and the 16 MB slow-reader close have no repo test | The 16 MB live close works (measured). An oversized *catch-up* close is H1 |
| M1 memory asserted by behaviour, not RSS | Measured: 2.4 MB per socket; process-wide, L1 |
| room-host mirrors `replay` and catch-up | Confirmed, marked SEAM(p2). Catch-up checked against `compact()` (held) |
| v0 `transient` gets an error per preview | Confirmed by the repo test; no strike, no close |
| > 2 MiB unsent + slow sign-in can't reconnect | Confirmed by reading; marked |
| Gateway counts depth on the whole frame | See L4 (60 levels inside an element field, measured by the repo test; 62 for the op, by arithmetic) |
| Second dev board after a mid-start kill | Confirmed by reading: L3 |
| Power loss, Linux, p95, load, idle heartbeat | Not done here. Idle: silent non-readers are reaped at about 120 s; a client that keeps sending is not (H1) |

## Not verified

- Power loss; Linux (my memory figures are macOS footprints; Linux RSS would show them directly); p95; a long soak.
- H1 memory beyond 60 sockets in-process and 40 on main.js (linear growth in both).
- Writers locked out by H1 (reading only, via rule 5).
- The flaky test on the platform verifier's machine itself: I reproduced its signature in a copy of the test files,
  not in the repo file, which passed 39 of 39 here.
- Engram had no notes for this job.
- server/auth, server/admin and server/registry were out of scope and only read where main.js and the gateway call them.

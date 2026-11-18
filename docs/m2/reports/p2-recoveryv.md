# p2-recoveryv: verify phase 2 (room recovery in packages/protocol)

**Verdict: PASS.** No HIGH and no MEDIUM findings; four LOW. Every done-when item holds, and I checked each one
by running it, and by reading its test where noted below. The builder's report (p2-recovery.md) was not read.

Job: branch `p2-land` in /Users/r/repos/plenary-p2. The commit was 359c50d; the manager rebased it to **b8bf648**
on f1886d5. I diffed both job commits over `packages/protocol` and `test`: they are byte-identical.

## Gates

| Check | Result |
|---|---|
| `bun test` in the worktree (b8bf648) | 183 pass, 54 fail. **All 54 failures are in test/web/sync.test.js**: the client track's seam swap, expected and not a finding. Before the rebase: 167/167 pass. |
| Top-level `test/*.test.js` (protocol, recovery, purity …) | 79/79 pass |
| test/purity.test.js covers records.js and presence.js | yes: it reads every `.js` in packages/protocol (`readdirSync`), so new files are covered automatically; it passes |
| test/auth (4 files), test/server/registry.test.js | pass. These come from earlier commits, not this job; with the 10 top-level files they make the 15 files and 167 tests seen before the rebase. The shared tree's other test/server files are not in the worktree |
| Convergence with restarts, scratch, **6,000 runs** | all pass: seeds 1–2000 at the shipped restart points (120, checkpoint 200, 300); 2000 with random restart and checkpoint rounds (half the rebuilds checkpoint first); 2000 with random rounds **and** a deterministic, seeded `Math.random` (nonces). Each run checks that every replica equals the room, nothing is pending, seqs are 1..n, no `(by, id)` is logged twice, and a rebuild of the final room equals it |
| Recovery with records, scratch, **800 runs** | all pass: recovery.test.js's `busy(seed)` for seeds 1–400 × {no checkpoint, checkpoint}, plus 40 random steps of replies, reactions (on and off), resolve and reopen, notes and board ops, with two rebuilds mid-run (one with a checkpoint, one without). Each run checks that a rebuild deep-equals the room's `state()`, that every replica equals the room in `state()` **and** `recordsState()` = `room.records.toJSON()`, that nothing is pending, that no `(by, id)` repeats, and that seqs run 1..n. Nonces random |
| Resend after resync, scratch, 5 tests | pass. An op written to the socket but **not delivered** (or delivered with its ack lost), then a refusal of another op (reset, since 0), then a peer moves the same element 3 versions on (with and without a checkpointed rebuild in between), then the op is resent: it is logged **exactly once**, the refused op never is, and every copy converges. A sent op keeps its bytes on resend (logged op equals the first send) |
| codex (**single harness**: the only one available today), high effort, read-only scratch clone | one lead (L1 below), confirmed; it found no loosened assertion in the four old test files |

## The loosened assertion

**`test/replica.test.js:264`**: `expect(stamped === 5 || stamped === 4).toBe(true)`, in "an unsent edit that a peer
overtakes is stamped past the peer's before it goes".

- **Why it was loosened:** the expected version depends on a random `versionNonce`. `randomInt()` (core) uses
  `Math.random`, not the Replica's injected `random`. If b's pending element ties a's entry at version 2 or 4 and
  b's nonce is lower, b's copy still leads, so `restamp` leaves it alone (the "my edits lead already" branch). It
  then goes out at 4 and wins the tie at the room. Otherwise it is restamped to 5. I ran the test 150 times: 55
  runs gave 4, 95 gave 5, and none failed.
- **Does it hide a bug? No.** In both cases the room ends with `{x: 7, version: stamped}` and a sees x = 7. The
  test still asserts both. A tie won on the nonce is the merge rule working, not an "acked dead" edit.
- The other loosening is in **`test/world.js` `settle`**: its step cap went from 200,000 to 400,000, and the
  reconnect recursion is now capped at depth 50. I measured 2,000 random-restart seeds: at most **407 steps**,
  recursion depth 0. The cap change is harmless and hides nothing.

- **A weak check, not a loosening:** `recovery.test.js:47` (in a new test) compares only `.board`, client
  against client, after the rebuild. My 800-run recovery fuzz makes the stronger checks (full `state()` and
  `recordsState()` against the room) and they hold. Strengthening line 47 is optional.

## Old tests edited: each traces to PROTOCOL.md

| File | Change | Traces to |
|---|---|---|
| convergence.test.js | `compact()` → `checkpoint()`; rebuilds at rounds 120 and 300; new asserts (seqs 1..n, no op logged twice, rebuild equals the room) | "Tests that change" (`compact`), test table "convergence with a restart mid-run"; the new asserts are stricter, not looser |
| convergence.test.js | "two editors … same version" compares the elements **as sent** (`sa`, `sb`) | Beyond the list, but forced by § The element op, "Normalize on send": `local()` rewrites version and nonce, so `a`/`b`'s own nonces no longer reach the room. It still asserts equal versions sent (the tie survives) and that the lower nonce wins everywhere. Justified, not loosened |
| holes.test.js | `room.receive` → `w.raw` (numbered `n`, `sentAt`) | rule 6 (`n`), `sentAt` (§ Messages), world.js row |
| holes.test.js | integer counters for the appState and prototype-key tests | "Tests that change", holes.test.js:94/107 |
| holes.test.js | hello test: the tenant comes from the gateway; it adds an unverified hello claiming `owner` → `auth` | "Tests that change" + rule 8 (stricter) |
| holes.test.js | "huge version" stays raw | as the spec says |
| protocol.test.js | integer counters (roles, pictures), `checkpoint()`, previews → presence refused by the room, no-hello / refused token at the gateway stand-in, new `v: 2` test | "Tests that change" bullets 1–5; test table "version" |
| world.js | waits for welcome, `sentAt`, `n`, rebuild helper, injected clock | "Tests that change", world.js row |

## The two late fixes: each has a test

- **Author names on catch-up by entries:** records.test.js:120. A late joiner with no checkpoint catches up by
  `entries` and its `recordsState()` deep-equals the room's records, `name` included. There is also a direct
  `name: "User 0"` check on a live peer.
- **A refused sign-in is not retried blindly:** replica.test.js:203–207. After `auth`, `needAuth` is set, and 60 s
  later `outgoing()` = [], `wait()` = null and `resync` is false (no timer turns it into a retry). The ops stay
  pending and land once after sign-in.

## Resends keep their bytes: is that safe with normalize-on-send?

**Yes.** Only a never-sent op is restamped (`restamp`: `unsent = p.msg.sentAt === undefined`; `outgoing()` stamps
it once, then sets `sentAt`). After that the op is fixed, so a resend has the same id, `sentAt` and bytes, and
rule 2's dedupe holds. Why a stale sent op is harmless:
- **Logged before:** the room answers with the stored `ack`/`seq`.
- **Never logged:** it is logged once and loses the merge to newer versions. That is a normal lost race, not a
  duplicate.
- **No jump-cap refusal:** its version was known + 1 when it was first sent, and the room's copy only grows.

Shown in scratch: a sent op, then a resync and a peer's 3 newer versions, then its resend, is logged exactly once
with its original op, and every copy converges (resend.test.js, 5 cases, with and without a rebuild).

## The usual hunt

| Item | Checked | Found |
|---|---|---|
| An op logged twice | 6,800 fuzz runs + 5 targeted resend tests, each checking that `(by, id)` is unique; code: dedupe via `recent` (speculative) before content checks | none |
| An acked op lost | an ack is sent only in `landed()` after `append` resolves; `fail()` acks nothing; a rebuild equals the original in every run | none |
| Ack/welcome/checkpoint from speculative state | welcome `seq`/`horizon` = resolved; catch-up = `base` + `tail` (resolved); `checkpoint()` replays base + tail when unresolved; the shipped group-commit tests | **L2:** `welcome.high` alone can be speculative |
| Unbounded tables | op-id table (W, H eviction), `unresolved` (deleted at n = 0), `held` (only while an append is in flight), `heard` (per gateway, swept), presence limiter (5 buckets) and coalescer (emptied on flush), records (caps), noteAuthor (bounded by the notes cap) | none new; Replica `buffer` is bounded in practice by rule 12's timeout |
| Presence saved | the room refuses presence (`bad-op`, never logged); presence.js has no path to the log; snapshots and checkpoints have no presence field | none |
| A room seeing an unauthenticated hello | `hello()` refuses without a verified `{user, role}` in meta (holes.test.js, extended); `!this.conns.has(c)` → `unavailable` | none |
| ports.js | read it: `MemoryLog.append` checks `expectSeq` and every seq before pushing (all-or-nothing, `conflict`); `getCheckpoint(beforeSeq)` returns the highest seq below it; `putCheckpoint` keeps the highest, not the last write | none |
| presence.js | read it: rates and sizes match § Presence (cursor 20, select 5/500 ids, laser 30/64 points, preview 20/50 elements/64 KB, emote 4); `deeperThan` is iterative, so a deep `preview` is cheap | none |

## Findings

### HIGH: none · MEDIUM: none

### LOW

**L1. A repeated `react` on a full board is refused `limit` instead of being a logged no-op.**
- Where: `packages/protocol/records.js:90` (`grows = op.on`).
- Failure: the records are at the 20 MB cap and a user re-sends 👍 `on: true` on a comment they already reacted
  to. The room answers `limit`. § Records says a repeated `react` is "accepted, logged and acked". Reproduced in
  scratch by setting `CAPS.records.chars` to the current size: a repeated react gets `limit`, while a repeated
  `resolve` is acked. State is unaffected: the reaction is already set, and the client only drops the op from
  its overlay.
- Fix: `grows = op.on && !(r.get(op.emoji) ?? []).includes(by)`. Add a test at the cap.
- Source: codex lead, confirmed by me. Codex rated it MEDIUM; I rate it LOW because it needs a full 20 MB board
  and changes no state.

**L2. `welcome.high` can come from speculative state.**
- Where: `packages/protocol/room.js` `hello()`: `this.clients.get(key)?.high`.
- Failure: client x has a resolved record (high 1). An unresolved append holds an eviction tick that drops x's
  record from the live (speculative) table. x reconnects before that append resolves and gets
  `{seq: 2, high: 0, horizon: 0}`, although the resolved high is 1. Reproduced in scratch with
  `rules {W:256, H:4, every:8}` and `slowLog`. § Recovery says welcome comes only from resolved state, and here
  `high` is speculative while `horizon` is resolved.
- Harm: small. The room still decides every resend correctly (`stale` by `sentAt < horizon`). The client's early
  drop could fire on `high = 0` against an older resolved horizon, dropping an op that a room whose append then
  **fails** would have taken.
- Fix: when an eviction drops a record that has no unresolved entry, remember its resolved `high` until that tick
  resolves (for example, keep it in `unresolved`). Or answer `high` from the resolved base + tail.

**L3. Nonces and client-id suffixes use `Math.random`, not the injected `random`.**
- Where: `replica.js` `local()` / `restamp()` (`randomInt()`), and the constructor's client suffix.
- Effect: a test seed does not fix the run, so tie-breaks vary run to run. That is the root of the loosened
  assertion above, and a failing convergence seed could not be replayed.
- Fix: draw nonces from `this.random`. Then make replica.test.js:264 assert the exact version for a fixed random.

**L4. `rec.recent.find` is linear in W, and restamping is linear in pending ops per `entries` message** (the
builder's own risk). Not measured; W = 256, so it is fine for M2. Note it for M4's load test.

## Not verified by me

- **Tests run but not read line by line:** replica.test.js 1–196, records.test.js 1–119, presence.test.js,
  envelope.test.js, and recovery.test.js 323–381. They all pass; I read the rest of recovery.test.js and the
  tests named in this report.
- Nothing ran in QuickJS, against SQLite, a socket, a browser or the real server; the purity check is static.
- Caps and eviction at real sizes (H = 100,000, 50 MB, 10,000 threads): only small injected values, as the
  builder said.
- A randomized fuzz of group commit (random land/fail interleavings with rebuilds). I only read and ran the
  shipped deferred-append tests plus the L2 probe.
- Replica pacing across two tabs (the builder notes one bucket per Replica): not tested.

## Scratch

All scratch tests are in
/private/tmp/claude-501/-Users-r-repos-plenary/701a095f-84aa-4ad0-8bba-0a81466cfb0e/scratchpad/stress.AL3A
(conv.test.js, conv2.test.js + world2.js, rec.test.js, resend.test.js, spec.test.js, react.test.js, rep.test.js). The codex
clone is in
/private/tmp/claude-501/-Users-r-repos-plenary/701a095f-84aa-4ad0-8bba-0a81466cfb0e/scratchpad/codex.xgzF. I
started no servers or browsers, so there are no PIDs to clean up.

## Fix round 2 (uncommitted in the worktree: replica.js, test/replica.test.js)

**Verdict: FAIL on one check: the reconnect storm (MEDIUM).** Previews per stream and the once-per-connection
counting work as asked, and there are no regressions. The waits don't always grow, which the brief requires.

| Check | Result |
|---|---|
| Previews keyed by (stream, id); `previewsOf(stream)`; a preview with no valid stream is ignored; an entry clears only its own stream's preview; `previews` still serves old callers | **PASS.** I read the diff and it is right. `dropPreview` puts the other stream's element back into `previews` when the same id is previewed in both. `leave` and `prunePreviews` iterate over a copy. Nothing outside replica.js used the removed `previewOf` (searched web/, test/, packages/, server/); web/sync.js still reads `replica.previews` and passes |
| `connectionFailed()` counts once per connection | **PASS.** A `counted` flag is reset in `connectMessages`. A timeout, `unavailable` and a close on the same connection count once. A close after a refusal-resync is not counted (scratch: `fails` stays 0), so a refusal is not treated as an outage. Pending ops and the copy are kept. With no connection ever started, nothing is counted |
| No regressions | **PASS.** Seeded convergence ×6,000 (fixed, random and deterministic-nonce restarts), recovery with records ×800, resend-after-resync ×5: all pass. Worktree `bun test`: **254 pass, 0 fail** (test/web included now). Top-level: 81/81 |
| Reconnect storm: waits must grow | **FAIL (MEDIUM), below** |

**M1. A client that is already caught up at `welcome` never backs off.**
- **Where:** `replica.js` `welcome()`: `if (this.applied >= this.target) this.fails = 0;` (`drain()` does the same).
- **Failure:** on an idle board, or a room that rebuilds and then crash-loops, `welcome.seq` equals what the client
  has already applied. The count resets the moment `welcome` arrives, so each later drop or op timeout counts as
  failure 1 again. Scratch (`random = 0`, so waits are the minimum):

  | Scenario, 6 connections in a row | Waits (ms) |
  |---|---|
  | Socket drops before `welcome` | 500, 1000, 2000, 4000, 8000, 15000 (grows) |
  | `welcome` (nothing new to catch up on), then the socket drops | 500, 500, 500, 500, 500, 500 |
  | `welcome`, then an op gets no answer for 10 s | 500, 500, 500, 500, 500, 500 |

  Every writer on that board reconnects every 250–500 ms for as long as the fault lasts. `connectionFailed`'s own
  doc comment ("a server that welcomes and then drops still meets growing waits") holds only when there was
  something to catch up on.
- **Spec note:** this follows PROTOCOL.md rule 12 to the letter ("k resets once it has applied `welcome.seq`"). It
  is not new in this round, but this round's goal (growing waits for a server that welcomes then drops) does not
  hold without a spec change.
- **Fix (PROTOCOL.md first, then code):** reset k only once the connection has proven itself, not on catch-up
  alone. Either "caught up and stayed up for 10 s (injected clock)", or "caught up and then got an `ack` or a new
  entry". Add a test with `welcome.seq == applied`, then a drop, repeated: the waits must grow.

**Not verified:** `connectionFailed` has no caller yet. web/ and drawh still need to call it from their socket's
close/error handler; until then a raw socket drop doesn't reach the count. Scratch probe: storm.test.js in the
same scratch folder.

## Fix round 3 (uncommitted in the worktree: PROTOCOL.md, replica.js, test/replica.test.js)

**Verdict: PASS.** M1 is fixed. One LOW finding (L5) is new.

| Check | Result |
|---|---|
| Rule 12 in the worktree's PROTOCOL.md | Says the same as the decision: k resets only after a connection applied `welcome.seq` and stayed connected 10 s more; being welcomed or caught up is not enough; each connection counts once; the reset is applied when the next wait is worked out. The code matches: `welcome()`/`drain()` only set `goodAt`; `proven()` runs from `failed()`, `reconnectWait()` and `connectMessages()` |
| Storm probe, 6 connections in a row (`random` = 0) | `welcome` with nothing to catch up on, then a drop: **500, 1000, 2000, 4000, 8000, 15000**. `welcome`, then a 10 s op timeout: same. `welcome`, then `unavailable` 2 s later: same. My round-2 probe (storm.test.js) now grows too |
| Stayed up 10 s, then a drop | after 5 failures: up 9.999 s then a drop gives **15000** (still growing); up 10 s then a drop gives **500** (back to the start) |
| 10 s counted from catch-up, not from `welcome` | welcomed behind, caught up 8 s later, dropped 5 s after that (13 s after `welcome`): not proven, count 3 → 4 |
| Refusal-resync close | not counted (`fails` stays 0) |
| Seeded runs | convergence ×6,000 (three configurations), recovery with records ×800, resend ×5: all pass |
| `bun test` in the worktree | **255 pass, 0 fail**; purity passes |

**L5. A timeout noticed late resets the backoff.**
- **Where:** `replica.js` `outgoing()`, `this.failed(t - CONNECT_TIMEOUT_MS)`.
- **Failure:** the code assumes the silence began exactly 10 s before `outgoing()` notices the timeout. If the
  caller polls late (a throttled background tab, a stalled event loop), the silent stretch counts as "stayed up".
  Scratch: `welcome` (caught up), an op written, `outgoing()` next called 40 s later, 6× in a row gives
  **500, 500, 500, 500, 500, 500**.
- **Spec gap:** rule 12 says the silent 10 s before a timeout don't count, but here the silence was 40 s.
- **Harm:** small. Late polling usually throttles the reconnect timer too, so the storm is damped.
- **Fix:** pass the start of the silence. Either `t + timeLeft(t) - CONNECT_TIMEOUT_MS` (the deadline minus
  10 s), or the `wrote`/`progressAt`/`helloAt` that expired. Add a late-poll case to the backoff test.

Scratch probe: storm3.test.js in the same scratch folder.

## Fix round 4 (uncommitted in the worktree: replica.js, test/replica.test.js)

**Verdict: PASS.** p6-sync2v's M3 is fixed, sent ops are never re-stamped, and there are no regressions.

**What changed (read):**
- **The skip is gone:** `tops()`/`restamp()` were replaced by one `restampAll()`, which no longer skips when "my
  edits lead already".
- **How it stamps:** per (stream, id), the base is the room's confirmed version (`confirmedVersion`, raised by
  each applied entry and loaded from snapshots, emptied on `reset()`). Each sent op raises the base to its own
  version and is only merged, never rewritten. Each never-sent op gets base + 1, base + 2, … in counter order,
  with a fresh nonce only when its version changes.
- **When it runs:** after every `entries` message (for all pending ops) and once per `outgoing()` call, before
  the first unsent op leaves.
- **Why `force: true` is safe:** the doc can only hold my own older stamp or a lower confirmed version there,
  because the base covers both the room's version and my sent ops.

| Check | Result |
|---|---|
| M3 repro (p6-sync2v's scratch `basev/k.test.js`, raised to **300 seeds** × k ∈ {1, 4, 5, 7} × peer racing or not = 2,400 runs) | **staleSent 0** (no op of the chain logged at or below the room's version), user's final position lost 0, and the final state equals the last logged op on that element in all 2,400 |
| Control: the same repro with round 3's replica.js | staleSent **1,195** of 2,400 (k=4: 155/300; k=5: 300/300 without a peer and 140/300 with one; k=7: 300/300), so the repro still catches the bug |
| Already-sent ops never re-stamped | a byte check on every resend in my seeded convergence runs: **312,454 resends, 0 differ** from the first send (stream, op, `sentAt`). Code: `if (!unsent) … continue` never writes to `el` |
| Seeded runs | convergence ×6,000 (three configurations), recovery with records ×800, resend ×5, the round-3 storm probes ×7: all pass |
| `bun test` in the worktree | **299 pass, 0 fail** |
| New tests | additions only, no assertion changed. A k = 1…12 chain over 40 seeds each, with a racing peer, the peer logged first, and a rebuild mid-run; the check is r + 1, r + 2, … in order, logged once, last op wins. Plus a "sent bytes kept, unsent go after them" test |

**Note on the repro run:** `h.js` needs the client's in-flight `web/sync.js` (p6-land, uncommitted in the
worktree), so the round-4 runs used the worktree as it stands. The control used a scratch copy of the same tree
with only `packages/protocol/replica.js` taken from HEAD (round 3). The protocol code under test is the same in
both apart from that file, and nothing in either repo was written.

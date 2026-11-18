# Report: p2-recovery (room recovery in packages/protocol)

Builder terminal `t15q`. Brief: docs/m2/briefs/p2-recovery.md. Spec built to: PROTOCOL.md at 7e834d2 (p1-seam),
plus the manager's three mid-job additions (depth 64; re-stamp across a resync; reconcile a cancelled drag).

## State: built and tested, NOT landed in the shared tree. One decision needed (manager)

- **Everything I own passes:** 79 tests in the top-level `test/*.js` (was 29), purity included, 25 runs in a row
  with no failure.
- **Landing breaks two other tracks' tests**, as the spec requires the things they call to go away. Measured with
  their files copied beside mine: full suite **162 pass, 31 fail**; all 31 are in `test/web` (14) and `test/server`
  (17: gateway 16, main 1). None is in a file I own.
- **So I did not land it.** The whole change is one patch that applies cleanly to the tree as of 508c4cf:
  `git apply docs/m2/reports/p2-recovery.patch` (2,876 lines; `git apply --check` passes). A built copy is in the
  worktree `/private/tmp/claude-501/-Users-r-repos-plenary/92763552-6070-4764-822a-d38c567e741d/scratchpad/wt`
  (detached at 1fac1b3; remove with `git worktree remove --force <that path>` once the patch is applied).
- **Decision:** apply the patch together with the seam swaps below (my suggestion), or apply it now and accept red
  `test/server` + `test/web` until those jobs run. "bun test passes" in the brief can't hold for the whole tree
  until room-host.js, web/sync.js and test/server/rig.js are moved to the v1 API.

### What the seam swaps need (files I don't own)

| File | Breaks because | Becomes |
|---|---|---|
| `server/room-host.js` | uses `room.opSeq`, `room.apply`, `room.compact()`, `auth: { check }`, `log.append(entry)` | `Room.rebuild({ checkpoint, entries, … })`; `room.receive(c, msg, { n, user, role, name })`; log adapter `{ append(entries, expectSeq) → Promise, putCheckpoint(cp) }`; `room.fail(err)` / `room.sweep()`; the Room now holds answers itself until the append resolves, so the host's own batching can go |
| `server/gateway.js` | hello may lack `v` | `v: 1` is required by the Room |
| `web/sync.js` | `local(…, { transient })`, sends what `connectMessages()`/`local()` return, `room.compact()`, `tableAuth(users, tenant)` | send `replica.outgoing()` after every receive/local/timer; previews via `replica.preview()` (presence); drop its own version stepping (the Replica normalizes); use `receive()`'s result and `reconcile()`; `Room` needs `{ user, role }` passed with the hello |
| `test/server/rig.js` | same Replica driving as sync.js | `outgoing()` loop, `wait()` timer, `reconnectWait()` |

## What changed (all in the patch)

| File | Change |
|---|---|
| `packages/protocol/envelope.js` | `ELEMENT_STREAMS` vs `STREAMS` (+`records`); writer table (commenter: records only); `PROTOCOL_VERSION`, `RULES_VERSION`, `RULES` (W 256, H 100,000, every 1,024), `CAPS`, `OP_RATE`, timeouts, backoff; `parseOpId`; `opProblem` (shape, then id and `sentAt`; `fileId` 40 hex; **depth ≤ 64 by a loop**, `deeperThan`); `recordProblem`; `canModerate`; `isSha1` (40 lowercase hex, for `fileId` and blob keys) |
| `packages/protocol/records.js` (new) | `Records`: comment threads and reactions. `check()` (room, before logging), `apply()` (room and replica, replay-safe), snapshot shape with `name`. Not in the spec's file list: both room.js and replica.js need it |
| `packages/protocol/room.js` | rewritten: `applyEntry` shared by live ops and replay; op-id table (`high`, `last`, `recent`, eviction, `horizon`, both `stale` rows); resolved vs speculative with one append in flight and group commit (sync or promise log, same path); held answers; `checkpoint()`, `Room.rebuild`, `Room.fromLog`; exported `catchUp`, `snapshotOf`; hello takes verified `{ user, role, name }`, checks `v`; `n` check; unknown connection → `unavailable`; `listed()`, `sweep()` (30 s gateway silence, 5 s append timeout, injected clock); stream and record caps; `state()` for comparing rooms |
| `packages/protocol/replica.js` | rewritten: `outgoing()` (welcome gate, catch-up gate, once per connection, token-bucket pace), `wait()`, `paceWait()`, `reconnectWait()`; normalize on send; re-stamp of unsent ops; `receive()` returns `{ entries, snapshot, reset, settled, dropped }`; `reset()` keeps pending overlaid; error table; forgotten-client drop; rules 12 and 13; records with pending overlay (`recordsState()`); `preview()`; `reconcile()`, `hasPending()`; `noteAuthor` |
| `packages/protocol/ports.js` | `MemoryLog`: conditional `append(entries, expectSeq)` (`conflict`), `read`, `putCheckpoint`/`getCheckpoint(beforeSeq)`, `end`; `tableAuth` returns `{ user, role, name? }` per board; v1 typedefs for Log, Auth, Store, Bus, Blobs |
| `packages/protocol/presence.js` (new) | `presenceProblem`, `presenceLimiter(now)`, `presenceCoalescer()` |
| `test/world.js` | gateway stand-in (token never reaches the room), `n` per connection, injected clock, pace-aware `step`, `raw`, `flush`, `rebuild`, plus `direct()`, `slowLog()` |
| `test/protocol.test.js`, `holes.test.js`, `convergence.test.js` | only what the spec lists, plus one more: "two editors … same version" now compares the nonces **as sent** (normalize on send draws fresh ones) |

## API for the client track (new or changed on Replica)

- `connectMessages(token, board)` → the hello only. `outgoing()` → ops to write now. Call it after every
  `receive()`, after `local()`, and when a timer of `wait()` ms fires. Never send what `local()` returns yourself.
- `resync` = close, wait `reconnectWait()` ms, open a new connection. `stopped === "version"`, `needAuth`,
  `unconfirmed` (ops dropped unconfirmed), `discarded` (dropped because another user signed in).
- `receive(msg)` → `{ entries, snapshot, reset, settled, dropped }`.
- `local(stream, op)` returns the message with elements **as sent** (version = known + 1, fresh nonce).
- `reconcile(stream, elements)` → the replica's copies that must replace the editor's (a version ahead with no
  pending op, e.g. a cancelled drag), or `{ id, gone: true }`. `hasPending(stream, id)`.
- `preview(stream, elements)` → a presence message. `recordsState()`, `noteAuthor`, `prunePreviews()`.

## Tests added (50 new; spec table row → test file)

| Row | Where |
|---|---|
| rebuild equals original (with and without a checkpoint); resend after restart; note ownership; no gap/reuse + `conflict`; bad checkpoint; corrupt log | `test/recovery.test.js` |
| convergence with restarts mid-run (one from the whole log, one from a checkpoint), 8 seeds | `test/convergence.test.js` |
| op-id bound: > W resends, eviction after H, eviction between welcome and resend, forgotten client | `test/recovery.test.js` |
| group commit, failed append, held refusal, auto checkpoint, connection gap, unknown connection, lists/sweep | `test/recovery.test.js` |
| records (roles, no-ops logged and acked, resend, replay, caps, overlay, refusal without reset, names) | `test/records.test.js` |
| presence units; a room refuses presence | `test/presence.test.js`, `test/protocol.test.js` |
| version; depth (30,000 deep refused in < 500 ms, 64 pass, 65 fail); id/`sentAt`; order of checks; jump cap from 0 | `test/envelope.test.js`, `test/protocol.test.js` |
| normalize (5,000-move drag, seeding), pacing (250 ops: 100 then 20/s), timeouts, backoff, user change, resync, edit during a resync, cancelled drag | `test/replica.test.js` |

## How I checked

- `bun test` on my files in the worktree: 79 pass, 0 fail; looped 25 times after the last change: 0 failing runs (ids and nonces are
  random, so one run isn't enough; two real bugs showed up only in some runs, below).
- Full suite in the worktree with server/ and web/ copied in (their state when I started, so newer tests of
  theirs aren't counted): 162 pass, 31 fail, all other tracks' (above).
- `git apply --check` of the patch against the shared tree.
- Bugs the convergence test caught in my own code, both fixed: (1) a `stale` answer followed by a dropped
  connection left the dropped op on screen with no resync; (2) an op settled by its entry before its ack arrived
  never triggered the "resync once after stale".
- Two more found by review, not by my tests, both fixed with a test each: a replica that caught up by entries
  lost comment authors' names (the test users had no names; they do now); after `auth` the 10 s timers still set
  `resync`, a blind retry with a refused token (`outgoing()` and `wait()` are now inert until the next hello).

## Readings and conflicts (spec vs brief; safest reading taken)

- **Resends keep their bytes.** Manager addition (1) says ops pending across a reset are re-normalized "before they
  are (re)sent". I re-stamp only ops **never sent**. An op already sent may already be logged under its id; rule 2
  says a resend is the same op, and it was stamped against a caught-up copy when it first went. Re-stamping one
  that is already logged would also leave the replica showing a version the room never logged. Say if you want
  resends re-stamped anyway.
- **Re-stamp goes further than asked:** an unsent op is also re-stamped when a peer's entry overtakes it (waiting
  on the pace or on catch-up), not only after a reset. Same reason: never send a version that is already dead.
- **`reconnectWait()` follows rule 12 literally**, so even a refusal's resync waits 250–500 ms (k = 0).
- **`name` on records:** taken from the hello context (`{ user, role, name }`); null when the gateway gives none.
- **Emote set** is not listed in the spec: I picked 8 (`presence.js` `EMOTES`). Product call; easy to change.
- **Checkpoint `clients` shape** is mine: `{ horizon, list: [{ user, client, high, last, recent }] }`. `noteAuthor`
  travels as `[[id, user]…]` (pairs, so an element id like `__proto__` stays data). The spec gives no shapes.
- **"Exported pure applyEntry":** it is a Room method. A gateway that wants state without sequencing makes a Room
  with `log: null` and calls `applyEntry`/`Room.rebuild`; `catchUp(base, tail, since)` and `snapshotOf(cp)` are
  exported functions.
- **Size caps are counted my way:** elements by JSON length (exact); records by text + fixed overheads, not exact
  JSON bytes. A function of the state alone, so a rebuilt room counts the same.
- **A refused hello closes the connection in the Room** (`c.closed`); the host should close the socket.

## NOT verified

- Nothing ran against the real server, a browser, SQLite or a real socket (other tracks' files; they are red).
- Not run inside Herdr's QuickJS (the purity test passes; that is a static check).
- Caps at their real sizes (100,000 ids, 50 MB, 10,000 threads, 20 MB) and eviction at the real H = 100,000:
  tested with small injected rules and the small caps (500 comments, 20 emoji) only.
- Performance: `rec.recent.find` is linear in W; `tops()`/`restampAll` is linear in pending ops per entries
  message. Not measured at 2k annotators.
- No sdd ensemble review and no independent verifier yet (the manager starts one).
- Engram (memory service) was unreachable ("name resolver … zero addresses"): no recall, nothing written.

## Risks

- **Auto-checkpoint is on by default** (every 1,000 entries, when the log since is ≥ half the state's size) and
  calls `log.putCheckpoint`. A host that wants its own schedule passes `auto: false`.
- **A room that stops (`fail`) is finished:** the host must build a new one with `Room.rebuild`. Nothing in the
  Room retries.
- **`Room.rebuild` trusts entry content** beyond seq/board/tenant/id/rv (a logged entry was accepted). A corrupt
  body could throw inside core's merge; the host should treat any throw from rebuild as "refuse to start".
- **Replica pacing is per Replica**, the spec's rate per user per board: two tabs each get a bucket (the gateway's
  bucket is the real limit; phase 3).
- **drawh's copied protocol/** (pd-drawh) is v0 and needs a re-copy after this lands; there are now 7 files.

Question for the manager (also the last line of my pane): **apply the patch with the seam swaps, or now and accept
red server/web tests?**

## Fix round 2 (from client's p6-sync2 verifier; in worktree /Users/r/repos/plenary-p2, branch p2-land, not committed)

Files: `packages/protocol/replica.js`, `test/replica.test.js` only. Checked there: my protocol tests 15 runs in a
row with no failure; whole suite in that worktree 254 pass, 0 fail (client's uncommitted web/ work included).

| # | Finding | Change |
|---|---|---|
| 1 | Previews were stored by element id, `stream` dropped, so a notes-bound view also listed board previews | Kept per (stream, id). A preview with no valid `stream` is ignored. A final op's entry clears only its own stream's preview |
| 2 | `fails` grew only on the Replica's own timeouts and on `unavailable`; a socket that dropped before `welcome` got no growing backoff | `connectionFailed()` |

### API for the client track

- **New `previewsOf(stream)`** → the elements others are previewing on that stream, expired ones (5 s) already
  dropped. Use this in a stream-bound view instead of `prunePreviews()` + `previews.values()`.
- **`previews` (Map: element id → element) is unchanged for existing callers**: it still holds every stream's
  previews together, so web/sync.js keeps working as is, with the cross-stream listing until it moves to
  `previewsOf`. `prunePreviews()` is unchanged. The internal `previewOf` map is gone (replaced by `previewBy`);
  nothing outside replica.js used it.
- **New `connectionFailed()`**: call it when the socket closes or errors and the Replica did not ask for it
  (`resync` was not set): before `welcome`, mid catch-up, or later. It adds one to the rule-12 count, sets
  `resync`, and keeps pending ops and the copy. Then proceed as for any `resync`: wait `reconnectWait()`, reconnect.
- **Counted once per connection**, whatever combination arrives (a timeout then the close it causes, `unavailable`
  then the server's close, error then close). This also changed `unavailable`: two of them on one connection used
  to count once only because `resync` was already set; now it is explicit.
- **A close never resets the count, clean or not.** Only applying `welcome.seq` (caught up) does. So a server that
  welcomes and then drops still meets growing waits; a drop on a live, caught-up connection counts as the first
  failure (next wait 0.5–1 s).
- **Don't call it for a close the caller started** (after `resync`, or leaving the page); calling it when no
  connection was started does nothing.

Tests added (2): previews per stream (same id on both streams, expiry, leave, entry clears one stream);
drops before welcome give waits 500, 1000, 2000, 4000 ms with the jitter fixed, once per connection, reset only
on catch-up.

Not verified: web/sync.js was not changed or re-run against `previewsOf`/`connectionFailed` by me (client's files).

## Fix round 3 (from t171's check, M1; in worktree /Users/r/repos/plenary-p2, branch p2-land, not committed)

Files: `PROTOCOL.md` (rule 12 only), `packages/protocol/replica.js`, `test/replica.test.js`. Checked there: my
protocol tests 15 runs in a row with no failure; whole suite 255 pass, 0 fail.

- **Spec first, rule 12:** k resets to 0 only after a connection has proven itself: it applied `welcome.seq` and
  then stayed connected 10 s more. Being welcomed or caught up no longer resets it. The rule now also says what a
  failed attempt is (a timeout, `unavailable`, or a socket closing unasked; once per connection).
- **replica.js:** `welcome()` and `drain()` no longer reset `fails`; they note when the connection caught up
  (`goodAt`). The reset is applied when the next wait is worked out.
- **Test added (1):** `welcome.seq == applied` then a drop, six times: waits 500, 1000, 2000, 4000, 8000, 15000;
  a connection that stayed up 10 s and then drops starts at 500 again. Three older assertions that expected
  `fails === 0` right after catch-up were changed to match the new rule.

### Two things beyond the decision as worded (say if you want either undone)

- **A timeout's own silent 10 s don't count as "stayed connected".** Taken literally, the rule would never back off
  the verifier's third scenario (welcomed, then an op gets no answer for 10 s): that timeout always fires at least
  10 s after catch-up, so every such connection would look proven and wait 500 ms again. I measure the 10 s up to
  when the silence began. Tested: six such connections wait 500 … 15000; one that worked for 10 s and only then
  went silent starts at 500. Rule 12's text says so in a bracket.
- **The reset is also applied in `reconnectWait()` and `connectMessages()`**, not only when a failure is counted.
  Otherwise a refused op after an hour of healthy connection would wait on stale failures (up to 15–30 s) before
  its resync. Tested: that wait is 250 ms.

### API for the client track

- No new calls. **Changed meaning:** `fails` stays above 0 after a good reconnect until that connection has been
  up 10 s (and the next wait is asked for). Don't read `fails === 0` as "connected and healthy"; nothing in web/
  reads it today.
- Call order matters a little less now: `reconnectWait()` may be called before or after `connectMessages()`.

Not verified: nothing re-run by me against web/sync.js beyond the whole suite passing with client's uncommitted work.

## Fix round 4 (from client's p6-sync2v M3; in worktree /Users/r/repos/plenary-p2, branch p2-land, not committed)

Files: `packages/protocol/replica.js`, `test/replica.test.js` only. Checked there: my protocol tests 15 runs in a
row with no failure; whole suite 299 pass, 0 fail (client's uncommitted web/ work included).

- **The bug:** `restamp()` skipped an op when the top of my pending chain already led the copy. Ops made on an
  empty copy (mid-resync) were stamped v1…vk; once k passed the room's version only nothing, or only the top, was
  re-stamped, and the lower ones went out at versions the room had already passed.
- **The fix:** the whole never-sent chain is stamped per element. With the room's version r as this replica has
  confirmed it (0 if none), the unsent pending ops for that id get r + 1, r + 2, … in send order, with a fresh
  nonce whenever an op's version changes. Runs after a reset, after a snapshot, after entries are applied, and
  once before the first never-sent op of a send.
- **Unchanged rule:** an op already sent keeps its bytes. It does count: unsent ops are stamped past the highest of
  the room's version and my sent ones.
- **How r is known:** the Replica now keeps the room's version per element (`confirmedVersion`: from snapshots and
  applied entries, cleared on reset), since its Doc mixes confirmed and pending copies. One number per element id.
- **The comment above the stamping code** now says what it does. `restamp(p)` and `tops()` are gone
  (`restampAll()` replaces them); nothing outside replica.js called them.

### API for the client track

- **New `roomVersion(stream, id)`** → the version of the room's copy as this replica has confirmed it, pending ops
  not counted (0 if none). This is the "confirmed version per id" asked for earlier; `reconcile()` is unchanged.
- **Behaviour to know:** the message `local()` returned may have its elements' `version`/`versionNonce` changed
  later, until it is first sent (it is the same object the Replica sends). After that it never changes.

### Tests added (7)

- **The M3 repro, 6 tests:** k = 1, 2, 4, 5, 7, 12 edits on one element during a resync, room at version 4, 40
  seeds each (half with a concurrent peer edit, some with the peer logged first, some with a room restart
  mid-way). Asserted: every chain op is logged once, in order, at a version above what the replica had confirmed
  when it left, versions consecutive; with no peer the room ends at version 4 + k on the last op, on every copy.
- **Sent ops keep their bytes, 1 test:** a sent v2, two unsent edits, the room moves to v6: the resend is
  byte-identical and logged at 2; the unsent ones go out at 7 and 8 and win.
- **The tests see the bug:** with the stamping cut back to "only the top, only when it is behind", 6 of the 7 fail
  (k = 1 can't show it).

### One wording point on the decision

"No op goes out at a version ≤ the room's" can only be held against the version the replica **had confirmed when
the op left**. A peer's edit still in flight can land first at the same version; that is an ordinary race, settled
by the usual tie-break on every copy alike. The test measures it that way (my first cut measured against the log
and failed on exactly that race: seed 19, peer's v5 logged between a's catch-up and a's send).

Not verified: the verifier's own scratch repro (`basev/k.test.js`) and D5a were not run by me; my test rebuilds the
scenario from the report's description. Cost of `restampAll()` (linear in pending elements per entries message) is
not measured at scale.

# Verifier report: p1-specv (protocol v1 spec)

**Verdict: FAIL.** Two HIGH findings, both in how the spec keeps "an op is never logged twice": one in § Op ids
and one in the Store's group commit. The spec covers every required topic. `bun test` passes (29 tests).
There are 7 MEDIUM and 10 LOW findings. Most are one-paragraph fixes to PROTOCOL.md.

Checked against `git diff -- PROTOCOL.md` (v1 compared with v0 at HEAD), packages/protocol/*.js and test/*.js. I did
not read the builder's report (docs/m2/reports/p1-spec.md).

## How I checked

- **`bun test` in the repo:** 29 pass, 0 fail.
- **Model of § Op ids, in a scratch dir outside the repo**
  (`/var/folders/dy/1lbkhxw51n5fwjypm906j9xh0000gn/T/tmp.ulHJACaR9F/opid.test.js`). It is a small JS model of
  the room's op-id table (`high`, `last`, `recent`, eviction, `horizon`) and the client's rules (resend after
  welcome, the forgotten-client drop, `sentAt`). W, H and the eviction period are scaled down to 8, 200 and 16.
  - **Spec-conformant random runs:** 300 seeds of 3,000 steps each, with lost acks, refusals, reconnects and a
    moving board. No op was logged twice and no acked op went missing, **provided the resends land right after
    the welcome**.
  - **A client that resends on a live connection** (a retry timer) logged an acked op twice (`c1:21` at seq
    1112 and again at 1401). Rule 2 implies this retry is not allowed but never says so (H1).
  - **Welcome, then an eviction, then the resend:** this reproduces H1 while following the spec to the letter.
  - **One lost gateway-to-room op:** the client's resend of it gets `stale` and is never logged (M1).
  - The random test takes about 4 s, so run it with `bun test --timeout 60000`.
- **Phase-2 list against the code:** I read room.js, replica.js, envelope.js, ports.js, codec.js,
  purity.test.js, world.js, protocol.test.js and holes.test.js.

## Required coverage (from the brief and PLAN.md phase 1)

| Requirement | Where | OK? |
|---|---|---|
| Restart recovery: checkpoint + log replay | § Recovery | yes, but see H2 |
| Op-id and note-author tables in checkpoints; op-id table bounded per client | § Recovery, § Op ids | yes, but see H1 |
| Presence: cursors, selections, laser, emotes; never logged; may drop | § Presence, rule 10 | yes |
| Comments (threads anchored to an element or a point, replies, resolve) and reactions as durable records | § Records | yes |
| Tenancy | § Tenancy, § Bus | yes (L5) |
| Ports: Store, Bus, Blobs, async Auth verified before the room sees the hello | § Ports, rule 8 | yes |
| Hello for an unknown board refused; boards only via `POST /boards` | rule 7 | yes |
| Store says how one sequencer per board is fenced | § Store (conditional append) | yes, but see H2 |
| Highlighter, notes and image: how each travels | § How each tool travels, § Blobs (tenant+SHA-1, 10 MB) | yes |
| "What phase 2 changes" list | § What phase 2 changes | present, but inaccurate (M6, L1–L3, L8) |
| CLAUDE.md decisions: one sequencer, acked op never lost, presence never saved, token in hello, server never runs layout | intro, rules 1, 8–10, hello row | yes |
| Every rule says what is guaranteed and what may drop | throughout | mostly; gaps in M1, M3, M4 |

## HIGH

### H1. An acked op is logged twice when its client's record is evicted between the welcome and the resend
- **Where:** § Op ids, "A forgotten client coming back" (lines 181–188), and rule 2 (lines 100–104).
- **The gap:** the forgotten-client check runs only on the client, and only from the `high` and `horizon` that
  arrive in `welcome`. The room cannot tell that it has forgotten a client: a resent op with no record has
  `n > high = 0`, so the room logs it again.
- **Failure scenario** (reproduced in the model):
  1. A client's op 1 is logged at seq L, and its ack is lost (the socket drops, or the bus loses it).
  2. The client reconnects. `welcome.high = 1`, because the record still exists with `last` just inside H. The
     client therefore skips the `sentAt < horizon` drop and resends op 1.
  3. Before the resend reaches the room, an eviction tick passes (every 1,024 seq) and the record is dropped.
     On a busy board this takes about a second, and the cluster's gateway-to-room hop adds latency.
  4. The resend arrives with no record. The room logs it at a new seq: one op, two entries, two acks.
- **Same hole, second path:** any retry on a live connection, which rule 2 never forbids, double-logs once the
  record has aged out.
- **Fix:**
  - Move the check into the room. The `op` message carries `sentAt`. When the room has no record for
    (user, client) and `sentAt < horizon`, it answers `stale` and does not log the op.
  - The client keeps its welcome-time drop as an optimisation only.
  - Add a rule: "resend only right after a `welcome`; never retry on a live connection; on a timeout,
    reconnect."
  - A client that lies about `sentAt` can only duplicate or lose its own op, which it could do anyway with a new
    counter.
  - Phase-2 test: an eviction between the welcome and the resend gets `stale`, and nothing is logged.

### H2. Group commit doesn't say whether state and the op-id table change before or after the append resolves
- **Where:** § Store, last bullet (lines 286–287), and § Recovery, "One step", "When" and "Order of durability"
  (lines 139–145).
- **The gap:** a room may batch entries into one conditional append, and it acks only after the append
  resolves. The spec never says when `applyEntry` (state, op-id record, note author, record ids) runs for an
  entry in flight. Both readings break a guarantee.
  - **Applied before the append resolves**, which validating op k+1 against op k inside a batch requires:
    - A resend of op k on another connection hits "n in `recent`" and gets an `ack` for a seq that isn't
      durable yet. This breaks rule 1.
    - A `welcome`, `high` or snapshot sent at that moment shows that seq.
    - "Copies its state at `seq` S synchronously" can copy the in-flight entries into a checkpoint. If the
      append then fails with `conflict` because another host wrote a different entry at that seq, the stored
      checkpoint holds a phantom entry. "Highest `seq` wins" then keeps it, and every later rebuild has the
      phantom op instead of the acked one. **An acked op is lost.**
  - **Applied after the append resolves:**
    - A resend arriving while the original is in flight sees `n > high` and is logged again.
    - A batch can't check record-id uniqueness or note authorship of op k+1 against op k.
- **Why phase 2 won't catch it:** `MemoryLog` stays synchronous in phase 2. The hole shows up in phase 3
  (SQLite) and phase 4 (Postgres, takeover).
- **Fix:** state it in the spec.
  - Ops are applied at batch formation to a **speculative** state.
  - A dedupe hit on an in-flight entry waits for that append's ack. It never acks early.
  - `welcome.seq`, `high`, snapshots and checkpoints use only the **resolved** seq and state. Checkpoint from
    a copy taken with no append in flight, or keep a resolved base plus an in-flight overlay.
  - On `conflict` or a timeout, drop the speculative state (the existing "discard and rebuild").
  - Make checkpoints safe on their own as well:
    - A checkpoint whose `seq` is past the log's end is corruption at rebuild.
    - Prefer: a checkpoint stores the `at`/`id` of its entry S, and a rebuild checks it against log entry S.
      This also catches a checkpoint written by a fenced-off host.

## MEDIUM

### M1. Rule 6 (per-client order) runs over a hop the spec itself calls at-most-once
- **Where:** rule 6 (lines 112–113); § Bus (lines 295–299); § Op ids, "Why refuse" (lines 170–172).
- **Scenario** (reproduced in the model): the gateway-to-room channel runs on NATS core, which drops messages
  (for example to a slow consumer).
  - Op 5 is lost and op 6 is logged, so `high = 6`.
  - The resend of 5 then gets `stale`, and the client drops it. The user's op 5 vanishes while op 6, which
    may depend on it, lands. The "it arrived before" argument behind `stale` is false here.
  - A lost `ack` or `error` on the way back leaves the op pending on a live connection, with no rule telling
    the client what to do.
- **Fix:**
  - Say the gateway-to-room channel is reliable and ordered per connection, or make loss detectable. For
    example, the gateway numbers each connection's messages, and the room answers `unavailable` and closes the
    connection on a gap.
  - Add a client timeout rule: no answer within T means reconnect, never resend on the live connection (see H1).

### M2. Rule 5 drops ops on `unavailable`
- **Where:** rule 5 (lines 110–111) and § Recovery, "Append failure" (lines 152–154).
- **Scenario:** during a takeover or an append failure, the room answers `unavailable` with an op's `id`. Rule 5
  treats every error except `stale` as a refusal, so the client drops the op. An op that never landed is lost
  on a transient failure, for every writer, on every takeover.
- **Fix:** list the refusal codes for rule 5 (`forbidden`, `bad-op`, `no-files`, `too-large`, `limit`). On
  `unavailable` (and `auth`), keep the pending ops and reconnect.

### M3. A lost last entry on a quiet board is never repaired
- **Where:** § Bus, "At-most-once" (lines 295–297).
- **The gap:** repair only starts when a gateway sees a gap, and a gap is only visible once a later entry
  arrives. If the last entry of a burst is lost, or a gateway subscribes after the room computed `welcome.seq`,
  clients stay one entry behind until the next edit, possibly forever. The sender's pending op also never
  settles under rule 4.
- **Fix:**
  - The room publishes a periodic `{seq}` heartbeat on `.entries`, every few seconds while gateways are
    connected, and gateways repair up to it.
  - The gateway subscribes to the board's subjects before it forwards the hello.

### M4. No rate or size bound on durable writes
- **Where:** § The element op, "Caps" (lines 66–67); § Records, "Caps" (lines 243–244); § Blobs (lines
  308–310); § Recovery, "When" (line 142).
- **Gaps:**
  - **Durable ops have no rate limit.** Presence has one; durable ops don't. One of ~2k annotators can flood
    the sequencer, grow the never-pruned log, and push other clients past H.
  - **`board` has no element cap.**
  - **Notes can be huge:** 200,000 elements of up to 1 MB each.
  - **Records can be huge:** 10,000 threads × 500 comments × 10,000 characters is about 5×10¹⁰ characters, all
    in every snapshot sent to up to 100k viewers.
  - **Blobs have no quota and no garbage collection.** "Write on some stream" includes `records`, so a
    commenter, who can't place an image, can still upload 10 MB blobs.
  - **Checkpoints are large:** up to H client records plus 200k authors, rewritten every 1,000 entries.
- **Fix:**
  - A per-connection rate for durable ops (with `limit`).
  - A byte cap per board per stream, including records.
  - Uploads only for writers of `board` or `notes`, with a per-tenant blob quota.
  - Count the checkpoint's size against the 1,000-entry interval, or make it incremental.

### M5. Adding `records` to `STREAMS` breaks every loop that builds one Doc per stream
- **Where:** § What phase 2 changes, rows `envelope.js`, `room.js` and `replica.js` (lines 327–329).
- **The code:** these all build or read one element `Doc` per `STREAMS` entry:
  - room.js: the constructor and `snapshot()`;
  - replica.js: `reset()`, `snapshot()` and `state()`;
  - envelope.js: `opProblem`, which applies element-shape checks to every stream in `STREAMS`.
- **Effect:** following the list literally either crashes `snapshot` (`msg.streams.records` is undefined) or
  sends record ops through element validation.
- **Fix:** the list should say "split `ELEMENT_STREAMS` (`board`, `notes`) from `STREAMS`, and keep records out
  of the Doc loops".

### M6. Where catch-up for 100k viewers comes from is unstated
- **Where:** rule 8 and § Auth (lines 116–117, 267–268).
- **The gap:** every hello, viewers' too, is forwarded to the room, which sends welcome and catch-up. At 100k
  joins in 2 minutes, that makes the single sequencer serve snapshots.
- **Fix:** viewers' hellos never reach the room. Gateways serve viewers their welcome and catch-up from the Store
  or a shared checkpoint; viewers have no `high` to report. This is not a phase-2 blocker, but phase 3 and 4
  will build to whatever the spec says.

### M7. Reading of the builder's risk "forgotten-client drop vs. acked never lost"
- **Verdict:** this one is consistent. The drop only ever removes **unacked** ops, and the model found no acked
  op lost in 300 seeds.
- **Cost:** an unacked op from a client that was away for more than H entries is lost silently.
- **Fix:** have the spec tell the UI to surface "n changes could not be confirmed" after the resync, rather than
  dropping them quietly.
- **Why MEDIUM:** this is a product rule, not a protocol bug.

## LOW

- **L1. The "Tests that change" list is incomplete** (lines 347–354).
  - `protocol.test.js:49` also calls `compact()`.
  - `protocol.test.js:62–66` sends raw ids `c0:f`, `c0:e` and `c0:s`. These have non-integer counters and a
    client that isn't the connection's own. If the counter check runs before the `files` check, `no-files`
    becomes `bad-op` and the test fails.
  - `holes.test.js:85` uses ids `${client}:${JSON.stringify(appState)}`. These still get `bad-op`, but now for
    the id, so the test stops checking appState validation while still passing.
- **L2. Protocol version handling is missing.** `hello` gains `v: 1`, but the phase-2 list doesn't mention it
  (replica sends it, gateway or room checks it), and no rule says what an unknown `v` gets (suggest `auth` or a
  new `version` code).
- **L3. The purity test bans more than imports.** `purity.test.js` rejects the substrings `window`, `process` and
  `document` anywhere in non-comment code. A phase-2 identifier like `windowSize` (for W) or `processAppend`
  fails it. Put one line in the phase-2 brief.
- **L4. The snapshot leaves out note authors**, "for other people's ids", yet entries and records already carry
  `by`. After a snapshot, a client can't tell which notes an annotator may edit, so the phase-7 UI can't grey
  out others' notes. Include `noteAuthor` in the snapshot, or put `by` on notes elements.
- **L5. Two naming gaps in § Bus and § Tenancy:**
  - The room inbox subject is unnamed; make it `plen.<tenant>.<board>.inbox`.
  - "The server resolves the tenant from the board id" requires board ids to be globally unique. Say so.
- **L6. The gateway's behaviour before `welcome` is unstated:** ops or presence sent then, and a second `hello`
  on one connection. Suggest: drop presence, refuse ops with `auth`, one board per connection.
- **L7. Viewer emote counts across gateways:** the spec doesn't say who sums each gateway's 500 ms counts. If each
  gateway publishes its own, every gateway must add the others' counts up.
- **L8. One phase-2 row names the wrong file.** The `tableAuth` helper is in `ports.js`, not `room.js` (line 328).
- **L9. Replay assumes the rules never change.** Replay runs no checks, and the op-id table depends on W, H and the
  eviction period. Record a rules version in each checkpoint and entry, so a later version can replay old
  entries under the rules they were accepted with.
- **L10. SHA-1 as the blob key, first put wins.** A writer in the tenant who can make a chosen-prefix collision
  can plant content that another user's image later resolves to. The risk is small in practice. Note it in the
  known limits, or key blobs by SHA-256 and keep `fileId` as a lookup.

## The builder's not-verified list and risks

| Risk | Finding |
|---|---|
| The op-id argument rests on per-client order end to end | Confirmed fragile: H1 (race against eviction) and M1 (lossy hop) |
| Numbers (W, H, rates, caps, 50 ms, checkpoint every 1,000) are reasoned, not measured | Agreed; not measured here either. The caps are also incomplete (M4) |
| Forgotten-client drop vs "acked never lost" | Consistent (M7); the model found no acked op lost |
| Replica waits for `welcome` before resending | Necessary but not sufficient: also "never resend on a live connection" (H1) |
| Commenter narrowed to records only | Raised as CEO question 2; fine, though commenters can still upload blobs (M4) |
| Blob reads are tenant-wide by hash | Stated in the known limits and CEO question 3; fine |
| Replay assumes validation never changes | L9 |

## What I did NOT verify

- **Restart and rebuild:** no v1 code exists, so rebuild, restart and "rebuild equals original" are argued from
  the text only. The model covers only the op-id table, not streams, records or checkpoints.
- **Performance:** no numbers (rates, H, 50 ms batches) were measured.
- **NATS, Postgres and SQLite:** their semantics come from general knowledge, not tests.
- **Herdr:** QuickJS and signed-URL behaviour inside Herdr were not checked.
- **Memory recall:** a recall through Engram failed (the service was unreachable), so there was no prior memory
  to cross-check against.

**For the manager:** H1 and H2 send the spec back to a builder. Both fixes are text plus one phase-2 test
each. The MEDIUM findings can go in the same pass.

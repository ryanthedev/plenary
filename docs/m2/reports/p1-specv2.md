# Verifier report: p1-specv2 (protocol v1 spec, round 2)

**Verdict: PASS.** No HIGH finding. Round 1's two HIGHs (H1, H2) are closed, and a model of the new rules found
no op logged twice and no acknowledged op lost. There are **8 MEDIUM** and **17 LOW** findings, all text fixes
to PROTOCOL.md. Three MEDIUMs (M1, M2, M5) change what phase 2 builds, so fix them before or with the phase-2
brief.

- **Why PASS:** OFFICE.md's rule is that only a HIGH sends a job back, and there is none. The manager can
  overrule knowingly: the done-when clause "every rule says what is guaranteed and what may drop" is **not fully
  met**. It is short in M2 (a rebuilt room and old connections), M3 (a lost `welcome`) and M7 (the heartbeat).
- **The two closest calls**, both argued below: M6 (a blob `sha1` with no format) and codex's Postgres failover
  lead (L17).

- **Checked:** `git diff -- PROTOCOL.md` at sha1 `bb79d1f977cc487bcaace92648b81b9b3055d4c8` (uncommitted, on top
  of HEAD), against packages/protocol/*.js, test/*.js and server/auth/{registry,tenancy,port,oidc}.js.
- **Not read:** docs/m2/reports/p1-spec.md (the builder's claims), as the brief says.
- **`bun test`:** 142 pass, 0 fail, 14 files (the brief said ~65; other tracks added files since).
- **Severity scale (same as round 1):** HIGH = a spec-conformant sequence breaks a hard guarantee (op logged
  twice, acked op lost, cross-tenant read, presence saved, auth bypass). An unacked op dropped, or a missing rule
  that a later phase must guess, is MEDIUM.

## How I checked

- **Scratch model of § Op ids, § Recovery and rules 2 and 6** (outside the repo):
  `/private/tmp/claude-501/-Users-r-repos-plenary/33d9b5ac-0f67-45ce-a0d9-52f20b30aacc/scratchpad/model/opid-model.js`
  (run `bun opid-model.js 300 4000`, about 80 s). The directory is session scratch and may be cleaned up.
  - **What it models:** the op-id table (`high`, `last`, `recent`, eviction, `horizon`, the room-side `sentAt`
    check), resolved vs speculative state with one append in flight, per-connection `n`, checkpoints checked
    against entry S, and rebuild. W, H and the eviction period are scaled to 8, 200 and 16.
  - **Faults injected:** lost acks and errors, lost gateway-to-room messages, old connections whose messages
    arrive late, client timeouts and reconnects, page reloads, the board moving more than H while a client is
    away, and appends that fail without landing, fail but did land, or time out and land after the rebuild.
  - **Result, 300 seeds × 4,000 steps (3.19 million entries, 8,231 rebuilds):** no (user, id) logged twice, no
    seq gap or reuse, every ack names a durable entry with that id, nothing welcomed or checkpointed above the
    durable prefix, and every rebuild from checkpoint + tail equals a full replay.
  - **Named case (round 1's H1):** welcome with `high = 1`, then an eviction, then the resend. The room answers
    `stale` and logs nothing.
  - **Never-logged ops answered `stale`:** 31,580, when a rebuilt room answers `unavailable` to a connection it
    never welcomed. Every one had `sentAt` below `horizon` at the time, so each is the documented
    forgotten-client cost (the model forces that case often). Some were answered by row 4 (`n ≤ high`) rather
    than row 1, because the client's record had been recreated by a newer op; I traced one such case (seed 2,
    a lost `stale` reply, then a second resend). I count those as the same cost.
  - **With the other reading** (the rebuilt room accepts an unknown connection), 497 more never-logged ops were
    answered `stale` with `sentAt` at or above `horizon`: real unacked ops lost (M2).
  - **Not exercised by the model:** the bad-checkpoint fallback (0 skipped), streams, records, limits,
    presence, gateways and viewers. Those are argued from the text.
- **sdd review, single harness.** Only codex passed `check_adapter`, so this is not an ensemble and nothing is a
  HIGH candidate by agreement. I ran codex twice (default model and `gpt-5.6-sol`, both high effort) on a copy of
  the files outside the repo, so it could not edit the tree. Each lead is confirmed or refuted in "Codex leads".
  - **Files codex received:** PROTOCOL.md, v0 (`git show HEAD:PROTOCOL.md`), the diff, CLAUDE.md,
    packages/protocol/*.js, server/auth/{registry,tenancy,port}.js, and test/{purity,protocol,holes,convergence}
    .test.js with world.js. It did not get any report or brief.
  - **agy:** `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 69h44m30s`.
  - **grok:** `Not signed in`. **kimi:** `No model configured … use /login`. **mistral:** `Missing
    MISTRAL_API_KEY`. **qwen:** binary not installed.
- **Engram recall failed** (`name resolver error: produced zero addresses`), so no prior memory was used.

## Round 1 findings: closed or not

| Round 1 | Status | Where in PROTOCOL.md now |
|---|---|---|
| H1 double log after eviction between welcome and resend | **Closed.** Room-side `sentAt` check, resend only after `welcome`, test listed. Confirmed in the model. | § Op ids table row 1 (l. 217), rule 2 (l. 125–130), tests (l. 431) |
| H2 group commit order | **Closed** for acks, welcome, checkpoints and broadcasts. Refusals still come from speculative state (M4). | § Recovery "Resolved vs speculative" (l. 160–170), "Rebuild" (l. 198–202) |
| M1 lossy gateway-to-room hop | **Partly.** `n` numbering and the 10 s timeout are there. Open: a rebuilt room and unknown connections (M2); a lost hello or `welcome` (M3). | rule 6 (l. 139–142) |
| M2 rule 5 dropped ops on `unavailable` | **Closed.** | rule 5 (l. 136–138), error table (l. 114–120) |
| M3 lost last entry on a quiet board | **Partly.** Heartbeat and subscribe-before-forward are there. Open: how the room knows a gateway follows, and what happens when the room stops (M7). | § Bus (l. 373–378) |
| M4 no bounds on durable writes | **Partly.** Caps, quota and upload roles are there. The rate limit contradicts rule 2 and is per connection (M1). | § Limits (l. 69–85) |
| M5 `records` in the Doc loops | **Closed.** | phase-2 table (l. 414–416) |
| M6 viewer catch-up | **Closed** in the protocol. The pure code a gateway needs for it is missing from the phase-2 list (L1). | rule 8 (l. 145–149) |
| M7 silent drop of unconfirmed ops | **Closed.** | § Op ids "Cost" (l. 240–243) |
| L1 tests-that-change list | **Partly.** Line numbers are wrong and one test is missing (L2). | l. 438–453 |
| L2 version handling | **Closed.** | hello row (l. 93), `version` code (l. 120) |
| L3 purity test bans substrings | **Partly.** It names 3 of the 11 banned strings (L3). | l. 407–409 |
| L4 `noteAuthor` in snapshots | **Closed.** | l. 103, 184–185 |
| L5 inbox subject, globally unique board ids | **Closed.** | l. 308–310, 371–372 |
| L6 before `welcome`, second hello | **Closed.** | rule 11 (l. 152–153) |
| L7 emote sums across gateways | **Closed.** | l. 268–269 |
| L8 `tableAuth` in the wrong file | **Closed.** | l. 417 |
| L9 rules version | **Closed**, with a gap on what `rv` covers (L9). | l. 190–192 |
| L10 SHA-1 first put wins | **Closed** (known limit). | l. 398–399 |

## Required coverage (brief and PLAN.md phase 1)

| Requirement | OK? |
|---|---|
| Restart recovery: checkpoint + log replay; op-id and note-author tables in checkpoints; op-id table bounded | yes |
| Presence: cursors, selections, laser, emotes; never logged, may drop | yes |
| Comments (threads on an element or point, replies, resolve) and reactions as durable records | yes (M5, M8) |
| Tenancy; ports Store, Bus, Blobs, async Auth before the room sees a hello | yes (M6) |
| Hello for an unknown board refused; boards only by `POST /boards` | yes (rule 7) |
| Store says how one sequencer per board is fenced | yes (conditional append; leases deferred to phase 4) |
| Highlighter, notes, image: how each travels | yes |
| "What phase 2 changes" list | yes, with gaps (L1–L4) |
| CLAUDE.md decisions kept (one sequencer, acked never lost, presence never saved, token in hello, no layout) | yes |
| Every rule says what is guaranteed and what may drop | mostly; gaps are M2, M3, M7 |
| Registry port names match server/auth/registry.js | yes, all 20 calls match |
| `memberRole` rule matches server/auth/tenancy.js | yes; domain is the `hd` claim, never the email (oidc.js:143) |
| Store no longer has `board` | yes (l. 350–356) |

## Hunted and found sound

| Question from the brief | Answer | Basis |
|---|---|---|
| Seq gaps or reuse across restart | None | Conditional append on `expectSeq` (l. 354); rebuild reads to the log's end (l. 198–205); model: 8,231 rebuilds, late-landing appends included |
| Acked op resent after a rebuild gets the same ack | Yes, while it is in `recent` | l. 203–205; model |
| A resend below the table's bound logged twice | No | Rows 1 and 4 (l. 217, 220); model |
| Ack, broadcast, welcome or checkpoint from speculative state | No. Only refusals are (M4) | l. 162–167, 195–196; model asserts each against the durable prefix |
| Op-id table bound | About H + 1,024 client records and pairs (L5 on the wording) | A record needs an accepted op within H; one op per `seq` |
| Note-author table bound | ≤ 200,000 (the notes id cap) | l. 245–246, 79 |
| Records bound | 20 MB, 10,000 threads, 500 comments each | l. 80, 301–302 |
| Anything else that grows forever | The room's per-connection `n` state (M2); the log itself in M2 (L17) | |
| Presence in the log, checkpoint, snapshot or replay | Nowhere | Rule 10; the checkpoint and snapshot field lists (l. 172–185) hold none; presence never reaches the room (l. 250–252) |
| Can a viewer see an unresolved `seq` | No | Gateways serve from `.entries` (published after the append resolves), the Store, or a checkpoint of resolved state (l. 147–148, 371) |
| Can a viewer see another board's data | No, except blobs by hash inside one tenant (known limit) and M6 | One board per connection (rule 11); subjects are per tenant and board |
| Auth before a room sees a hello | Yes | Rule 8, § Auth (l. 327–330); the room gets `{user, role, client}`; unknown board and no role give the same `auth` (rule 7) |
| Cross-tenant through the Registry port | Not from the protocol: the room never calls it, and a hello names only a board | The id-only admin calls are L15 |

## MEDIUM

### M1. Rule 2's resend contradicts the rate limit, and the limit is per connection (phases 2 and 3)
- **Where:** rule 2 (l. 125–130), § Limits (l. 77, 83–85), rule 5 (l. 136–138).
- **Scenario:** a writer edits through a network stall and has 250 unacked ops. On reconnect, rule 2 says resend
  every one right after `welcome`. The gateway takes the burst and refuses the rest with `limit`. `limit` is a
  rule-5 refusal, so the client drops those ops and resyncs. The user's work is lost by two rules of the spec.
- **Ambiguous:** "queues up to the burst, then refuses" may mean 100 in all, or 100 passed plus 100 queued.
  250 fails under both readings.
- **Also:**
  - The gateway limiter sits in front of the room, so a resend of an already-accepted op can get `limit`
    instead of its ack. That contradicts "a resend is answered before limits" (l. 84–85).
  - The limit is per connection. One user with 50 connections writes 1,000 ops/s; there is no per-user or
    per-board rate and no cap on connections per user.
- **Fix:** the client paces all sends, resends included, to the published rate. Over-rate is backpressure (the
  gateway holds the socket, or answers a new non-refusal code that keeps the op pending), never a refusal. Make
  the rate per user per board.

### M2. What a rebuilt room does with a connection it never welcomed is unstated; `n` state never ends (phases 2 and 4)
- **Where:** rule 6 (l. 139–142), § Recovery "On conflict…" (l. 168–170), § Bus (l. 379–380).
- **Scenario:** a room host dies. Gateways keep their sockets and keep numbering. Ops 5 and 6 are in flight; op 5
  is lost while no host listens. The new host sees op 6 first, with `n = 57`, on a connection it has no record
  of. If it accepts, `high = 6`, and the resend of op 5 later gets `stale`: an unlogged op dropped, which is
  round 1's M1 again. The model lost 497 unacked ops with "accept" and 0 with "`unavailable`".
- **Also:** nothing tells the room a connection closed, so its per-connection `n` table grows with every writer
  connection until the room restarts.
- **Fix:** a room answers `unavailable` to any op from a connection it did not welcome in this incarnation. The
  gateway sends the room a close message, and the room drops `n` state for connections of a gateway it has not
  heard from for some time.

### M3. No timeout covers a lost hello, `welcome` or catch-up; the reply route is unnamed (phases 3 and 4)
- **Where:** rule 2 (l. 126–127), rule 3 (l. 131–132), § Bus (l. 371–380).
- **Scenario:** the bus is at-most-once. The gateway forwards a writer's hello and the room's `welcome` is lost.
  The client has sent no op, so rule 2's 10 s timeout never starts. It waits forever. The same holds for a lost
  catch-up `entries` message: new ops wait for `welcome.seq`, which never comes.
- **Also:**
  - § Bus names no subject for room-to-gateway replies (welcome, catch-up, ack, error).
  - A writer's catch-up or snapshot travels from the room over the bus. A snapshot may be over 100 MB by the
    spec's own caps, and one op may be 1,000,000 chars. NATS's default message limit is 1 MB (from memory,
    not checked here).
- **Fix:** a client timeout from hello to `welcome` and from `welcome` to "applied `welcome.seq`"; on expiry,
  reconnect with backoff and jitter (no backoff rule exists anywhere). Name the reply subject. Have the gateway
  serve writers' catch-up from the Store as it does for viewers, so the room only returns `seq`, `high` and
  `horizon`.

### M4. Refusals and `stale` are answered from speculative state (phase 3)
- **Where:** § Recovery (l. 162–170), § Records (l. 276–278).
- **Scenario:** op A (`thread` with id X) is in flight. Op B reuses id X and is refused `bad-op` at once, from
  speculative state. A's append then fails and never lands. X does not exist, but B's client already dropped B
  and resynced. The same holds for `forbidden` (note author set by an in-flight op) and for `stale` after a
  speculative eviction.
- **Also:** "speculative" is defined as entries handed to an append (l. 164). With one append in flight, ops
  accepted meanwhile are queued, not yet handed over. They must count as speculative too, and "n in flight"
  (l. 219) must cover them.
- **Fix:** an answer that depends on an unresolved entry waits for that append, as dedupe hits already do. On
  failure it becomes `unavailable`.

### M5. Ordinary races on comments force a full resync (phases 2 and 7)
- **Where:** § Records "Dead targets" and "Caps" (l. 295–296, 301–302), rule 5 (l. 136–138).
- **Scenario:** a moderator deletes a comment while 200 people react to it. Each `react` is refused `bad-op`.
  Rule 5 makes each of the 200 clients discard its copy and reconnect with `since: 0`, a full snapshot each. The
  21st distinct emoji on a comment (`limit`) does the same.
- **Also:** l. 288–290 call repeated `resolve` and `react` "a no-op" without saying whether the op is logged
  and gets a `seq`. An ack must name one.
- **Fix:** a refusal on `records` only removes that op from the client's pending overlay; no reset. Say that
  no-ops are accepted, logged and acked. Consider making dead-target actions logged no-ops.

### M6. A blob's `sha1` has no stated format (phase 3)
- **Where:** `blob` message (l. 96), § Blobs (l. 385–392), § Tenancy (l. 317–319).
- **Scenario:** a viewer sends `{ t: "blob", sha1: "../t-other/<hash>" }`. Nothing says `sha1` must be 40 hex
  characters. A local-disk adapter that joins (tenant, sha1) into a path returns another tenant's blob. Puts are
  safe (the server hashes the bytes); reads are not.
- **Why not HIGH:** the leak needs an adapter that breaks the port's own contract. Blobs are keyed
  `(tenant, sha1)` (l. 316, 385), and a put is kept only if the bytes hash to that key (l. 390), so only real
  hashes are ever stored under a tenant. An adapter that returns bytes for a key never put under that tenant
  violates `get(tenant, sha1)`. So the spec's guarantee holds for a conforming adapter; what is missing is the
  check at the edge that stops a careless one. It must be fixed before phase 3 builds blobs.
- **Fix:** `sha1` and an image's `fileId` are exactly 40 lowercase hex characters; anything else is `bad-op`
  before signing or calling Blobs.

### M7. The heartbeat has no way to know a gateway follows, and stops with the room (phase 4)
- **Where:** § Bus (l. 374–376).
- **Scenario:** the last entry of a burst is lost on the bus. The room then stops (idle, or its host dies). No
  heartbeat comes, viewers stay one entry behind for good, and viewers never touch the room so nothing restarts
  it. Round 1's M3 is only partly closed.
- **Fix:** gateways poll the Store's last `seq` for boards they serve when they have heard nothing for a few
  seconds, or the spec defines follower registration and when a room may stop.

### M8. A comment carries a user id but no way to show the author's name (phase 7)
- **Where:** § Records shape (l. 303–304), `here` (l. 107).
- **Scenario:** threads store `by` (a user id). Names come only from `here`, which lists writers present now. A
  comment by someone who left shows no name, and the phase-7 comment UI can't be built without a protocol change.
- **Fix:** store the author's display name on the entry at write time (from the verified identity), or add a
  lookup message.

## LOW

**Phase-2 list and tests**

- **L1. Pure code for gateways is missing from the phase-2 list** (l. 407–419). Rule 8 has gateways build a
  snapshot from a checkpoint plus later entries. That needs `applyEntry` without sequencing and a
  checkpoint-to-snapshot function (dropping `clients`) in packages/protocol. The list also doesn't say whether
  phase 2's Room still answers a viewer's hello, which `protocol.test.js:9` relies on.
- **L2. "Tests that change" is still inaccurate** (l. 438–453).
  - The `c0:f`, `c0:e`, `c0:s` ids are at `protocol.test.js:60, 62, 64`, not 62–66.
  - The appState ids are at `holes.test.js:94`, not `:85`; `holes.test.js:107` has the same kind of raw id.
  - `protocol.test.js:14` is missing: its ids are `client:x-board`, so under v1's check order (id before role)
    it gets `bad-op` where the test expects `forbidden`.
  - l. 442–444 say `no-files` "turns into `bad-op`" and, in the same sentence, that shape is checked first.
    With shape first it stays `no-files`.
  - l. 440 says the preview relay test "becomes `presence`", but the phase-2 room never relays presence
    (l. 435). Say it becomes the "presence sent to a room is refused" test.
- **L3. The purity note is incomplete** (l. 407–409). `test/purity.test.js:12` also bans `setTimeout`,
  `setInterval`, `structuredClone`, `Buffer`, `TextDecoder`, `TextEncoder`, `fetch(` and `require(`. So the
  replica's "10 s timeout" row (l. 416) needs an injected clock or a `tick(now)`, and a name like `ringBuffer`
  fails the test.
- **L4. Small gaps in the phase-2 rows.** The replica row doesn't list tracking `noteAuthor`. The `ports.js` row
  doesn't mention replacing the v0 `Auth` and `Log` typedefs. `MemoryLog.append(entries, expectSeq)` lacks the
  Store's `(tenant, board, …)`, so phase 3 needs an adapter, not a drop-in. `here`, `blob` and the durable-op
  rate limiter are not in the "phase 3" sentence.

**Op ids and recovery**

- **L5. `recent` wording** (l. 209–211, 232–233). "At most W" doesn't say which pair goes (the lowest counter).
  Pairs are defined by age continuously but removed every 1,024 seq; pick one. The bound is about H + 1,024
  records and pairs, not "≤ H".
- **L6. "Never logged twice" holds for honest clients.** A client that forges `sentAt` after eviction can log
  its own op id again. The spec says so (l. 236–237); state the guarantee that way in rule 2.
- **L7. Pruning rule contradicts the rebuild check** (l. 196–201). "Entries ≤ S may be pruned" removes entry S,
  which the rebuild needs to validate checkpoint S. M2 never prunes, so this is latent. Say "entries < S".
- **L8. Checkpoint check is thin.** Compare `by` as well as `id` and `at` (ids are unique per user only). A
  content hash would catch corruption of the body. Gateways building viewer snapshots (l. 148) should use the
  same check.
- **L9. `rv` doesn't cover everything replay depends on** (l. 190–192): core's merge rules (packages/core is
  re-copied from herdr-draw) and the appState key set. Also say what a client does with an entry whose `rv` it
  doesn't know.
- **L10. Snapshots must hold tombstones.** The checkpoint row says so; the snapshot (l. 103, 184) doesn't. A
  snapshot without them diverges when a later entry carries an older version of a deleted element. Core's
  `toScene()` includes them today.
- **L11. The room's append timeout is unstated** against the client's 10 s. It should be shorter, so clients get
  `unavailable` and back off instead of all timing out together (the builder's storm risk).
- **L12. Role is checked before dedupe** (l. 83). A resend after a downgrade gets `forbidden`, not its ack. The
  resync shows the truth; say so.
- **L13. Pending ops belong to a user.** After `auth`, signing in as a different user resends the old user's
  pending ops under the new one. Say the client drops pending ops when `welcome.user` changes.

**Presence, tenancy, storage**

- **L14. Presence has no expiry except previews** (l. 261, 271). A lost `leave` leaves a cursor or selection on
  screen. Give every kind a lifetime, or drop presence of anyone not in `here`. Who builds `here` across
  gateways is unstated, and a list of 2,000 writers once a second to 100k viewers is large.
- **L15. Registry and roles.**
  - Calls keyed by id alone (`invite(id)`, `revokeLink(id)`, `setGrant`) carry no tenant; say the admin API must
    check the caller's tenant.
  - `createBoard` takes no creator, so "the creator gets `owner`" is a second call that can fail in between.
  - Say where `POST /boards` gets its tenant.
  - registry.js allows `memberRole: null` (no member access); the spec doesn't mention it.
  - A grant below `memberRole` can't lower one member.
  - registry.js's header comment still says "Store has `board(id)`" (platform's file).
- **L16. Blob gaps.** No rate on `blob` requests or puts; any annotator, guests included, can fill the
  tenant's quota. Signed PUT URLs must end at our server, since a direct S3 URL can't hash or type-check.
- **L17. Missing from "Known limits":** the log grows forever in M2; durability is per node; the caps allow a
  snapshot over 100 MB, against 100k joins in 2 minutes.
  - **On durability:** l. 358 scopes "durable" to a process crash and power loss on the Store's node, and rule 1
    says "a crash of any process". Losing the node's disk, or failing over to a replica that lags, is outside
    that scope, so it is not a break of the spec as written. But the `ack` row (l. 105) says "it will never be
    lost" with no scope. Add the scope there and list it as a known limit for M7.

## Codex leads (single harness)

| Lead (run) | Verdict | Why |
|---|---|---|
| Forged `sentAt` logs an op twice (both, high/critical) | **Refuted as HIGH**, kept as L6 | Needs a lying client, which can only re-log its own op; an honest `sentAt` is always below `horizon` (model and proof in l. 234–236) |
| `expectSeq` is not a lease fence (both, high) | **Refuted** | A stale host that wins the append is still the only writer of that `seq`; the other gets `conflict` and rebuilds. Safety holds; avoiding ping-pong is phase 4 |
| A unique key alone doesn't enforce "last `seq` = `expectSeq`" (sol, same lead) | **Confirmed as LOW** (wording, l. 360) | The contract (l. 354) is right. The aside "a unique key does it" stops reuse, not a gap; a host only believes an end it read or wrote, so a gap needs a bug, but implement the contract as stated |
| Postgres failover loses acked ops (default, high) | **Refuted as HIGH**, kept as LOW (L17) | Outside the durability scope the spec states (l. 358); the `ack` row overclaims |
| Checkpoint body not validated (sol, critical) | **Confirmed as LOW** (L8) | Corruption only; checkpoints hold resolved state |
| Refusals from speculative state (sol, high) | **Confirmed**, M4 | |
| Pruning vs validation; log grows forever (both) | **Confirmed as LOW** (L7, L17) | M2 never prunes |
| Gateways skip checkpoint validation (sol, high) | **Confirmed as LOW** (L8) | |
| No reply route on the bus; lost `welcome` (sol, high) | **Confirmed**, M3 | |
| Heartbeat without follower registration (sol, high) | **Confirmed**, M7 | |
| Room `n` state unbounded (sol, high) | **Confirmed**, in M2 | |
| Limiter before dedupe (sol, medium) | **Confirmed**, M1 | |
| Role before dedupe (sol, medium) | **Confirmed as LOW** (L12) | |
| Presence expiry (both, medium) | **Confirmed as LOW** (L14) | Presence may drop by design |
| `createBoard` has no creator (sol, medium) | **Confirmed as LOW** (L15) | |
| `sha1` has no syntax (sol, medium) | **Confirmed**, M6 | |
| `tableAuth` "stays" is wrong (sol, medium) | **Mostly refuted** | The row says it changes to return `{user, role}`; see L4 for the typedefs |
| Presence test contradiction; missing fixtures; wrong lines; `no-files` claim; bound ≤ H (both) | **Confirmed as LOW** (L2, L5) | Checked against the test files |

## The builder's not-verified list and risks

| Risk | Finding |
|---|---|
| No code exercises v1 | Still true. The model covers op ids, group commit and rebuild only |
| Per-client order end to end, including the gateway-to-room hop | Holds inside one room incarnation (rule 6); breaks across a rebuild or takeover unless M2 is fixed |
| Numbers are reasoned, not measured | Agreed; none measured here. The caps conflict with the join target (L17) and the rate with rule 2 (M1) |
| Forgotten-client drop vs "acked never lost" | Consistent: only unacked ops are dropped; no acked op lost in the model |
| Replica waits for `welcome`; new ops wait for catch-up | Needed and stated. No timeout if `welcome` never comes (M3) |
| Commenter narrowed to records | Consistent across streams, presence and blobs. CEO question 2 |
| Blob reads tenant-wide by hash | Stated (known limit, CEO question 3). Format hole is M6 |
| Replay assumes validation never changes | `rv` added; see L9 |
| 10 s timeout may cause reconnect storms | Likely under a slow Store: no backoff rule (M3) and no room-side append timeout (L11) |

## What I did NOT verify

- **Anything running:** there is no v1 code. Rebuild, records, limits, presence and viewers are argued from text.
- **The bad-checkpoint path:** the model never produced a bad checkpoint.
- **Performance and numbers:** nothing measured.
- **NATS, Postgres, SQLite, S3 behaviour:** from general knowledge, marked where used.
- **Herdr:** QuickJS and signed URLs inside Herdr.
- **A real ensemble:** one harness only (codex).
- **Memory recall:** Engram was unreachable.

**For the manager:** PASS, so phase 2 need not wait. M1, M2 and M5 change replica and room behaviour.
docs/m2/briefs/p2-recovery.md already exists (I did not read it), so fix PROTOCOL.md and add the three to that
brief before the builder reaches the resend, `n` and records code. M3, M4, M6 and M7
must land before phase 3 and 4 build to them. M8 before phase 7.

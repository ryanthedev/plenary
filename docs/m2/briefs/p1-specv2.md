# Brief: p1-specv2 (re-verify the protocol v1 spec after the fix round)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work"), CLAUDE.md, PLAN.md,
then the diff. **Do not read docs/m2/reports/p1-spec.md** (the builder's claims); everything you need is here.

- **Your tab:** `verifier p1-specv2: protocol v1 spec, round 2`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p1-specv2.md only. PROTOCOL.md and everything else are read-only to you.
- **Scratch tests** go in a dir outside the repo (e.g. `mktemp -d`), never under /Users/r/repos/plenary, because
  `bun test` picks up any `*.test.js` in the tree.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings (each: where in PROTOCOL.md, failure scenario, fix).
  Then stop and leave the session idle. Don't commit.

## The job you're checking

Goal (CEO, PLAN.md phase 1): protocol v1 spec in PROTOCOL.md: restart recovery (snapshot + log replay; op-id
and note-author tables in snapshots; op-id table bounded per client), presence channel (cursors, selections,
laser, emotes; never logged, may drop), comments (threads anchored to element or point, replies, resolve) and
reactions as durable records, tenancy, ports: Store, Bus, Blobs, async Auth (verified before a room sees hello).
Spec only, no code. It must include a "what phase 2 changes in packages/protocol" list and keep CLAUDE.md's M2
decisions (one sequencer per board, acked op never lost, presence never saved, token in hello not a header,
server never runs layout). Also required: a hello for an unknown board is refused (boards only via POST /boards);
the Store port says how one-sequencer-per-board is fenced when a host is replaced (or defers it to phase 4);
how highlighter (durable vs fading presence), notes (notes stream) and image (element + blob, tenant+SHA-1,
10 MB cap) travel.

Diff: `git diff -- PROTOCOL.md` (v0 is `git show HEAD:PROTOCOL.md`).

Done when: PROTOCOL.md covers all of the above, every rule says what is guaranteed and what may drop, and
`bun test` passes (29 tests).

## Hunt for holes

- **Ordering:** seq gaps or reuse across restart; entries vs records vs snapshot ordering; catch-up races.
- **Idempotent resend across restart:** an acked op resent after the room rebuilt gets the same ack/seq; a resend
  below the op-id table's bound is never logged twice.
- **Unbounded tables:** op-id, note-author, comment/reaction tables, anything else that grows per client or forever.
- **Cross-tenant leaks:** any message, bus subject, blob key or store key that can name another tenant's data.
- **Presence never persisted:** not in log, snapshot, store, or replayed.
- **Auth before hello reaches a room:** async auth awaited at the gateway; what a room may assume.
- **Phase 2 change list vs the real code:** read packages/protocol/*.js and check each claim about room.js,
  replica.js, envelope.js, ports.js, codec.js is accurate and enough to brief phase 2.

## The builder's own not-verified list and risks (check these)

- Nothing exercises v1 yet. The op-id argument (n ≤ high ⇒ the op arrived earlier) rests on per-client
  ordering end to end, including the gateway → room hop in cluster mode.
- Numbers (W = 256, H = 100,000, rates, caps, 50 ms batches, checkpoint every 1,000) are reasoned, not measured.
- Forgotten-client rule drops sent-but-unacked ops on a client out for > H entries (unlogged op lost, never
  double-logged). Is that consistent with "an acknowledged op is never lost"?
- Replica must wait for `welcome` before resending; new ops wait for catch-up to `welcome.seq`.
- Commenter narrowed to records only (not notes) — differs from v0.
- Blob reads are tenant-wide by hash.
- Replay assumes validation never changes meaning between versions.

## Round 2: what's new since round 1

- Round 1 FAILED: read **docs/m2/reports/p1-specv.md** (the previous verifier's findings, H1, H2, M1–M7, L1–L10)
  and check each one is actually closed in the current PROTOCOL.md, not just mentioned. Re-run its scratch op-id
  model idea against the new rules (room-side `sentAt` check, "resend only right after welcome", per-connection
  `n` numbering): an eviction between welcome and resend must give `stale` and log nothing.
- Hunt for holes the fixes introduced: resolved vs speculative state (can anything ack, broadcast, welcome or
  checkpoint from speculative state?); checkpoint validation against log entry S and `getCheckpoint(…, beforeSeq)`;
  viewers served by gateways (can a viewer ever see an unresolved seq, or another board's data?); heartbeats;
  limits; `rv` rules version.
- New in this round: a **Registry** port (§ Ports) shaped after server/auth/registry.js (read-only for you), and a
  `memberRole` rule in § Tenancy (a Workspace member's role on a board includes that board's memberRole, set at
  POST /boards, default viewer). Check the port names match registry.js, nothing cross-tenant leaks through it,
  and Store no longer has `board`.
- `bun test` now has ~65 tests (other tracks added files). It must pass.
- Builder's new not-verified/risks: no code exercises any of it yet; numbers (20 ops/s, byte caps, 2 s heartbeat,
  10 s timeout, checkpoint cadence) are reasoned; the 10 s no-answer timeout may cause reconnect storms under a
  slow Store.

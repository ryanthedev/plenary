# Brief: p1-spec (protocol v1 spec)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md, CLAUDE.md, PROTOCOL.md and
packages/protocol/*.js (room.js, replica.js, envelope.js, ports.js, codec.js) first.

- **Your tab:** `worker p1-spec: protocol v1 spec`. Your manager: `manager engine`, terminal `t14j`.
- **You own:** PROTOCOL.md only. No code in phase 1. Do not edit packages/, test/, or anything else.
- **Report:** docs/m2/reports/p1-spec.md (what changed, how you checked it, what you did NOT verify, risks,
  open questions). Then stop and leave the session idle. Don't commit.

## Goal (CEO's words, PLAN.md phase 1)

Protocol v1 spec in PROTOCOL.md: restart recovery (snapshot + log replay; op-id and note-author tables in
snapshots; op-id table bounded per client), presence channel (cursors, selections, laser, emotes; never logged,
may drop), comments (threads anchored to element or point, replies, resolve) and reactions as durable records,
tenancy, ports: Store, Bus, Blobs, async Auth (verified before a room sees hello).

## What the spec must cover

Rewrite PROTOCOL.md as **v1** (keep v0's style: short, tables, numbered rules; say what changed from v0).

1. **Restart recovery.** What a snapshot holds (both streams, appState seq table, op-id table, note-author
   table, the seq it covers), when the room takes one, and how a room rebuilds: latest snapshot + replay of
   log entries after it. The rebuilt room must answer a resend of an already-acked op with the **same ack/seq**,
   still refuse an annotator changing someone else's note, and continue `seq` without gaps or reuse.
2. **Bounded op-id table.** Per (user, client) bound; state the exact rule (e.g. a client acks its own
   high-water mark, or a per-client window of the last N ids / seq floor) and what happens to a resend that
   falls below the bound (must never be logged twice: refuse or ack, say which and why). Same for the
   note-author table: bounded by what, or why it needn't be.
3. **Presence channel.** Cursors, selections, laser, emotes: message shapes, rate limits, never logged, never
   in snapshots, may drop, not sequenced. How it relates to v0's `transient` (replace or keep; say).
4. **Comments and reactions** as durable records: threads anchored to an element id or a board point, replies,
   resolve/reopen, edit/delete rules per role, reactions (on what, toggle semantics, limits). Say whether they
   are a third stream or record ops in the log; they must be sequenced, logged, acked, idempotent on resend,
   and in snapshots. Who may write each (viewers? state it).
5. **Tenancy.** Board → tenant resolved by the server; every log entry, snapshot, blob and bus subject keyed
   by tenant; no message can name another tenant's board or blob.
6. **Ports.** Store (append, read-from-seq, snapshot put/get, op-id lookup if needed; what "durable" means),
   Bus (per-board subjects, at-least-once or at-most-once, what a gateway does with gaps), Blobs (put/get
   keyed by tenant+SHA-1, size cap, verification), Auth (**async**, resolves token → {user, tenant, role per
   board} or refusal; the gateway awaits it **before** any room sees the hello). One sequencer per board.
7. **Keep the M2 decisions** in CLAUDE.md: one sequencer per board, an acked op is never lost, presence is
   never saved, the token travels in hello not a header, the server never runs layout.
8. **Phase 2 change list.** A section "What phase 2 changes in packages/protocol": per file (room.js,
   replica.js, envelope.js, ports.js, codec.js, new files), what changes, and which tests prove it (from
   PLAN.md phase 2 done-when: a room rebuilt from MemoryLog equals the original; a resend gets the same
   ack/seq; note ownership still refused; convergence with a restart mid-run). Phase 2 will be briefed from it.
9. **Open questions** for the CEO, if any, as a short list at the end (decisions only the CEO can make).

## Done when

- PROTOCOL.md is v1 and covers 1–9; every rule says what is guaranteed and what may drop.
- `bun test` still passes (29 tests at the start; you don't change code, so it must stay green).
- Report written at docs/m2/reports/p1-spec.md.

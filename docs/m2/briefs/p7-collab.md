# Brief: p7-collab (phase-7 collaboration UI) — DRAFT, starts when p2-land merges to main

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phase 7), CLAUDE.md, PROTOCOL.md v1
(§ Streams, § Presence, § Records, rules 5 and 11) first.

- **Your tab:** `worker p7-collab (client): collaboration UI`. Manager: `manager client` (t14k).
- **You own:** web/ui/** (new files for presence and records, plus edits to existing ones), web/app.js,
  web/index.html, web/style.css, test/web/ui-*.test.js, test/web/collab*.test.js, your report.
- **Owned by others:** web/sync.js and test/web/sync*.test.js (the client's sync layer; ask your manager for a
  change; it may be a separate job), packages/protocol and server/ (engine). docs/m2/design/ is the verified mock.

## Goal (PLAN.md phase 7)

"Full collaboration: live cursors with names, avatar row, others' selections, laser, draw, highlighter, emotes,
reactions, comment threads, annotations (notes stream), connection status pill." Build it to the mock
(docs/m2/design/, the phase-7 rows of its README.md) over the v1 protocol:

- **Presence** (§ Presence): `cursor`, selections, `laser`, `preview` (others' drags in flight, from the sync
  handle's per-stream previews), `emote`; never saved, may drop; send at the § Presence rates; drop a client's
  presence on `leave` or 30 s of silence.
- **`here`:** the avatar row (writers ≤ 50, `writerCount`, viewer count "N watching").
- **`emotes`:** viewers' summed counts per 500 ms; the crowd bar.
- **Records** (§ Records): comment threads anchored to an element or a point, replies, resolve/reopen, reactions on
  comments; roles per § Streams (commenter writes records only; viewers read).
- **Annotations:** the notes stream drawer, with v1 `noteAuthor` from the snapshot replacing p6-ui's localStorage
  ownership (p6-uiv L1).
- **Status pill:** connected / reconnecting / offline / read-only / stopped (new status from p6-sync2), with
  viewers never showing pending edits (p6-mockv HIGH #1).

## Done when (PLAN.md)

- All of it works across two nodes (the phase-3/4 server, when it is up; until then two tabs over the in-page room
  and the phase-3 single node), and headless tests cover comments, reactions and presence (send rates, expiry on
  `leave`/30 s, role gating of records, viewers' emotes only as counts).
- `bun test` passes; browser check at 1440 and 390 px, light and dark, every role.
- Report docs/m2/reports/p7-collab.md. Processes: never pkill/killall, PIDs only, port 0. sdd helpers allowed.

## Open before start (manager fills in)

- The sync handle's presence/records API after p2-land merges (does sync.js expose `presence`, `here`, `emotes`,
  records ops, or does a sync job add them first?).
- CEO questions still open (docs/m2/reports/p6-mock.md): do viewers see annotators' cursors (mock: presenters only);
  a "follow presenter" view; saved reactions on the board. Build the mock's default; keep each behind one flag.

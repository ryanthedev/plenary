# Handoff: p3-fix4 (single-node server scaffold, fix round 4)

Written 2026-11-11 by `worker p3-fix4` at the end of the round, in case round 5 needs a fresh builder. Nothing is
committed by me. Read "Fix round 4" in docs/m2/reports/p3-scaffold.md first; this adds only what isn't there.
docs/m2/handoff/p3-scaffold.md (round 3) still describes the outbound path; the changes below are the deltas.

## Deltas to the outbound path (server/gateway.js, server/room-host.js)

- **Every outbound size is UTF-8 bytes.** That covers `item.len`, `outBytes`, `owed` and `sharedBytes`.
  - `bytesOf` is outbound only; `sizeOf` (chars) stays for inbound.
  - The room host sends `bytes` with each shared catch-up frame; the gateway falls back to measuring.
- **`backpressureLimit` = `maxSnapshotBytes` (450 MB, from § Limits at 3 bytes/char + 25%) + `maxUserBufferedBytes`.**
- **The one new rule in `flush()`:** if the socket holds bytes and buffered + frame > limit, set `blocked` and wait
  for `drain`. Bun drops a frame only in that case; into an empty socket any size goes.
- **`warnSize()`** logs once per shared-text name: `error` when a frame is over the limit, `warn` when it is over
  `maxClientMessageBytes` (128 MiB, Bun's client cap).

## Facts measured this round (Bun 1.4.4, macOS)

- **Client cap:** Bun's WebSocket client closes 1006 on any message over 134,217,728 bytes; the server sees no
  close.
- **Server:** Bun's server sent 150 MB and 400 MB frames byte-exact with a 138 MB `backpressureLimit`. `drain`
  fires while most of a big frame is still buffered.

## Test helpers added

- **`rawSock(url, { frames: true })`** parses server frames into `s.texts`. It also no longer drops bytes that
  arrived with the 101 response.
- **`bigJoin(maxSnapshotBytes)`** in outbound.test.js: one scenario, two limits.

## Open

- **Decision for the manager:** chunked snapshot or § Limits caps in UTF-8 bytes. Until then a > 128 MiB snapshot
  can't be joined by Bun clients.
- **Not cleaned:** the scratch data dir (168 MB). The delete was refused; the report has the path.
- **Not seen:** the drawh builder's two R4-H2 failures under load (their output). Both tests were rewritten
  event-first afterwards; the loaded gate is in the report.

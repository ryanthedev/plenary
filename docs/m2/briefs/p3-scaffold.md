# Brief: p3-scaffold (single-node server scaffold)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phase 3), CLAUDE.md, PROTOCOL.md
(v1 draft, still being fixed by another session: § Ports is the contract you build to), packages/protocol/*.js,
and server/auth/port.js, server/auth/registry.js, server/auth/dev.js (read-only; platform owns them).

- **Your tab:** `worker p3-scaffold: server scaffold`. Manager: `manager engine`, terminal `t14j`.
- **You own:** server/ **except** server/auth/ and server/admin/ (platform's), and test/server/ (new). Nothing
  else: not PROTOCOL.md (another session is editing it right now), not packages/, not other test/ files.
- **Report:** docs/m2/reports/p3-scaffold.md. Then stop and leave the session idle. Don't commit.

## Goal (proxy, from PLAN.md phase 3)

The parts of the single-node server that don't depend on the protocol v1 recovery fixes still in flight:

1. **Gateway:** Bun HTTP + WebSocket server using the existing codec (packages/protocol/codec.js). One process.
2. **/health** (200 + small JSON).
3. **Structured logs** to stdout (one JSON object per line: time, level, msg, fields). No secrets, no tokens.
4. **Bad frames never kill the process:** undecodable, oversized, wrong-shape frames get an `error` and/or a close;
   a throw in a handler is caught and logged.
5. **SQLite Store adapter** (`bun:sqlite`, `PRAGMA synchronous=FULL`, WAL) for the log and checkpoints, behind
   PROTOCOL.md § Store: `append(tenant, board, entries, expectSeq)` atomic and conditional (unique
   `(tenant, board, seq)`; stale expectSeq throws `conflict`), `read(tenant, board, fromSeq, limit)` ascending,
   `putCheckpoint`/`getCheckpoint` (highest seq wins). Async API. Board lookup is **not** Store's: it belongs to
   the Registry port (server/auth/registry.js names are stable); use that interface, don't reimplement it.
6. **In-memory Bus** per § Bus: per-board subjects `plen.<tenant>.<board>.entries|presence|inbox`, at-most-once.
7. **Local-disk Blobs** per § Blobs: `put(tenant, sha1, bytes)`/`get(tenant, sha1)`, 10 MB cap, SHA-1 verified
   (refuse a mismatch), keyed by tenant+hash on disk with no path traversal (validate both ids), put idempotent.
   Signed-URL HTTP routes may wait; if you add them, no token in headers or URLs.
8. **Dev-token Auth wired** to the async shape: gateway awaits `verify(token)` then `role(identity, board)` and
   the board lookup **before** anything reaches a room; refusal answers `auth` and closes. Use platform's
   server/auth/dev.js / port.js; if you need a change there, write it in your report, don't edit it.

**Seams, not guesses.** Where a v1 detail is still moving (op-id table, resend/stale rule, group commit and
speculative vs resolved state, checkpoints' contents, viewers served by gateways), leave a clearly marked seam
(`// SEAM(p2): …` plus a list in your report) and wire the current packages/protocol Room as-is behind it.

## Done when

- `bun test` passes (all existing tests plus yours under test/server/). Tests: Store contract (atomic conditional
  append, conflict on stale expectSeq, read order, checkpoint highest-seq-wins, data survives close/reopen);
  Blobs (cap, hash mismatch refused, tenant isolation, bad ids refused); Bus delivery per subject; gateway over a
  real socket: /health, auth refused before a room sees hello, bad frames don't kill the process, two clients
  converge through the existing Room.
- Tests use temp dirs and ephemeral ports; nothing written into the repo tree.

## Process rules (OFFICE.md)

- Never `pkill`, `killall` or `pkill -f`. Start any server or browser from a script that records its PID; kill
  only that PID. Use free ports (port 0), never hard-coded ones.

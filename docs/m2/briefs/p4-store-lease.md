# Brief: p4-store-lease (phase 4, step 1: lease + epoch fence in the Store)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Architecture"), CLAUDE.md (NFRs, M2 decisions),
docs/m2/PLAN.md (phase 4), PROTOCOL.md v1.1 (§ Recovery, Room identity / epoch), then docs/m2/reports/p-audit.md
(F5, F12, F13 and § 3 "Phase-4 readiness"), server/store/*, packages/protocol/ports.js, test/server/store-contract.js,
store.test.js, pg-store.test.js, and server/room-host.js (read only: how it calls the Store today).

- **Your tab:** `worker p4-store-lease (engine) · <your id>: lease + epoch fence`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main). Don't commit.
- **You own:** server/store/* (a new server/store/port.js if useful), packages/protocol/ports.js (the Store typedef
  only), test/server/store-contract.js, test/server/store.test.js, test/server/pg-store.test.js, and new
  test/server/lease*.test.js. **Never touch:** server/gateway.js, server/feed.js, other test/server files and
  PROTOCOL.md (p2-tune owns them now), server/room-host.js and server/bus/* (p4-host, next), server/main.js and
  server/server.js (platform / p4-wire), server/auth|admin|registry/** (platform), web/** (client).
- **Spec text:** write the PROTOCOL.md wording you want (§ Recovery lease + fence) in your report as a proposal;
  I apply it after p2-tune lands.
- **Design first:** `distributed-systems-design` skill, APPLIER mode (/Users/r/repos/systems-design.skill), on the
  lease against the NFRs (one sequencer per board; an acknowledged op is never lost; takeover fast enough that
  editors notice seconds, not minutes; clock skew between hosts). Put its output briefly in your report.
- **Report:** docs/m2/reports/p4-store-lease.md (what changed, tests, mutation checks, not verified, risks,
  the spec proposal, and what p4-host must do to use it). Then stop, idle.

## Goal

1. **Lease in the Store (both adapters):** a lease record per board `(holder, epoch, expiresAt)`.
   - `acquire(tenant, board, holder, ttlMs)`: succeeds only if the lease is free or expired (or already ours);
     a new holder bumps the epoch; returns `{ epoch, expiresAt }` or null.
   - `renew(tenant, board, holder, epoch, ttlMs)`: only the current holder at that epoch; else null.
   - `release(tenant, board, holder, epoch)`: idempotent.
   - Expiry is judged on **the database's clock** (Postgres `now()` / `clock_timestamp()`; SQLite: one process,
     so its own clock is the DB clock, but inject it so tests control time). Never compare two hosts' clocks.
   - Decide what happens to `openEpoch` (keep for single-node rooms, or fold into acquire); say which and why.
2. **Epoch fence on append:** `append(tenant, board, entries, expectSeq, epoch)` rejects when `epoch` is not the
   board's current lease epoch, with a distinct error (e.g. `code: "fenced"`), atomically with the CAS: no window
   where a stale holder lands an entry after a takeover. Checkpoint writes are fenced the same way.
   Keep today's callers working until p4-host switches (e.g. epoch optional for now, with a SEAM(p4) note), or
   say why not.
3. **Contract, both adapters (F12):** run `storeContract` on sqliteStore, not only on Postgres. Add lease/fence
   cases: two holders race for one lease (exactly one wins); expiry then takeover bumps the epoch; a stale holder's
   append and checkpoint are refused after takeover; renew by a stale holder fails; release then acquire; clock
   control through the injected clock (SQLite) and a short ttl (Postgres).
4. **Typedefs (F13, Store part):** packages/protocol/ports.js declares what core really calls (read's `maxBytes`
   and its `.bytes` / `lastSeq` results) plus the lease methods.

## Done when

- `bun test` green in the shared tree; also with DATABASE_URL (start brew postgresql@17 yourself on a free port,
  record its PID, stop it after). The lease contract passes on both adapters.
- Each new test fails when its fix is undone (mutation check in a scratch copy; say which).
- test/architecture.test.js stays green (adapters import ports and the shared list only).

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.

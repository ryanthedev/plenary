# Brief: p6-sync2 (web/sync.js onto the phase-2 Replica, inside the p2-land landing)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (v1) first.

- **Your tab:** `worker p6-sync2 (client): sync onto phase-2 Replica`. Manager: `manager client` (t14k).
- **Where you work:** the git worktree **/Users/r/repos/plenary-p2** (branch `p2-land`), not /Users/r/repos/plenary.
  `cd` there first; every path below is relative to it. Don't commit; the engine track merges p2-land as ONE commit
  after both verifiers pass, so the tree must never go red.
- **You own:** web/sync.js, test/web/sync*.test.js, test/web/paint*.test.js (only if a seam change breaks them), and
  your report docs/m2/reports/p6-sync2.md (in the worktree). Nothing else: web/ui/, web/index.html, web/app.js and
  test/web/ui* belong to p6-ui on main; packages/protocol is engine's.
- **Read:** docs/m2/reports/p2-recovery.md (section "API for the client track"), packages/protocol/replica.js on
  p2-land, docs/m2/reports/p6-base.md and p6-basev.md (what sync.js guards and why).

## Goal

Phase 2 changes the Replica and removes v0 calls web/sync.js uses. Port sync.js onto the new API so p2-land lands
green, and drop the workarounds the new API makes unnecessary:

1. **Sending:** use `outgoing()` (after every `receive()`, after `local()`, and when a `wait()` timer fires); never
   send what `local()` returns yourself. `local()` now sets versions (known + 1, fresh nonce), so remove
   `stepVersions` and the Editor-version rewrite, and set the Editor's copy from what `local()` returns.
2. **Drag previews over presence:** replace v0 `transient: true` ops (the gateway now refuses them as bad-op) with
   `preview(stream, elements)` presence messages. Show peers' previews only if the new Replica exposes them;
   otherwise leave that to phase 7 and say so.
3. **Receiving:** use `receive()`'s `{ entries, snapshot, reset, settled, dropped }` instead of re-deriving applied
   ids from entries.
4. **Cancelled gestures:** use `reconcile(stream, ids/elements)` for the H2 case (a gesture ended without a commit)
   instead of sync.js's own tracking, if it covers every case the current tests cover.
5. **Resync:** close, wait `reconnectWait()`, open a new connection (`transport.reopen()`). Only never-sent pending
   ops are re-stamped after a resync; resends keep their bytes. Handle `stopped`, `needAuth`, `unconfirmed`,
   `discarded` as status the UI can show.

## Keep stable (p6-ui builds on it on main)

`bindEditor`'s signature and options, the status names (`connecting`, `catching-up`, `live`, `refused`), and the
handle's `status`, `pending`, `role`, `peek`, `diff`, `full`, `state`, `reconnect`, `cancelGesture`, `close`. If any
must change or a status is added, list it at the top of your report; your manager tells p6-ui and engine.

## Done when

- Every existing test/web/sync and paint test still passes, or is changed for a stated reason (none may be weakened:
  the strict gate, the 56-combination gesture sweep, H1 resync-window edit, M1–M5 all stay).
- New tests: previews go out as presence (never as an op), a resend after resync is byte-identical, a never-sent op
  is re-stamped, `stopped`/`needAuth` reach the handle's status.
- `bun test` passes in the worktree (all of it, not only test/web).
- Mutation check: break each new path and see a test fail.
- Report docs/m2/reports/p6-sync2.md: API changes (top), files, tests, how you checked, NOT verified, risks. Stop.

## Processes, sdd

Never pkill/killall; kill only PIDs you start; port 0. sdd helpers (OFFICE.md) allowed for test scaffolding in a
separate worktree; you own every line.

## Carried from p6-basev round 2 (docs/m2/reports/p6-basev.md)

- **M1:** time each op from its send (rule 2: no ack or error within 10 s), not "no message for 10 s"; use the new
  Replica's `wait()` if it owns the timing.
- **M2:** backoff (rule 12, growing and jittered) and the `version` (stop) and `unavailable` (keep ops, back off)
  codes; an id-less error other than `auth` must not reconnect every 10 s forever.
- **M3:** a test that held ops survive a reconnect (drop `held` in `restart()` must fail it). LOW L1's test gaps too.

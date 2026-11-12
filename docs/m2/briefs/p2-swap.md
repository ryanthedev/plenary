# Brief: p2-swap (move the server onto the phase 2 protocol)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (v1), then
docs/m2/reports/p2-recovery.md ("What the seam swaps need", "API for the client track") and the scaffold's
docs/m2/reports/p3-scaffold.md (its `SEAM(p2)` list).

- **Your tab:** `worker p2-swap (engine): server onto v1 protocol`. Manager: `manager engine`, terminal `t18m`.
- **Where you work:** the git worktree **/Users/r/repos/plenary-p2** (branch `p2-land`), NOT the shared tree.
  `cd` there for everything. Don't commit; the manager merges.
- **You own (in that worktree):** server/ except server/auth/, server/admin/, server/registry/; and test/server/
  except registry.test.js. **Client's uncommitted work (p6-land, web/collab) is in the same worktree** on web/ and test/web/: never touch those.
  packages/protocol and test/*.js are verified and frozen: if you need a change there, stop and write it in your
  report.
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p2-swap.md (in the shared tree). Then stop, idle.
- **Design first:** this job changes components, ports and failure behaviour. Before writing code, apply the
  `distributed-systems-design` skill (APPLIER mode; /Users/r/repos/systems-design.skill) to the room host, gateway
  and Store epoch, and put its output (the 4 steps, briefly) in your report. Keep it hexagonal (OFFICE.md
  Architecture): room-host and gateway depend on ports only; only server/main.js picks adapters.

## Goal

Swap every `SEAM(p2)` in the server to the phase 2 protocol (packages/protocol at p2-land), so the server runs v1:

- `server/room-host.js`: drop its mirrors of Room internals (`replay`, catch-up, its own batching); use
  `Room.rebuild({ checkpoint, entries, … })`, `room.receive(c, msg, { n, user, role, name })`, the log adapter
  `{ append(entries, expectSeq) → Promise, putCheckpoint(cp) }` over the SQLite Store, `room.fail(err)` (then rebuild),
  `room.sweep()` on a timer; the Room holds answers until the append resolves.
- `server/gateway.js`: hellos carry `v: 1`; per-connection `n` numbering to the room; close notices; presence
  relayed by the gateway (never reaches the room or the log), with `presenceProblem`/limiter/coalescer from
  packages/protocol/presence.js; v0 `transient` stays refused.
- `test/server/rig.js` and the other test/server files: drive the Replica the v1 way (`outgoing()` loop, `wait()`
  timers, `reconnectWait()`).
- Keep every gate the scaffold already passes (restart and kill -9 through main.js, depth limit, bad frames, auth
  before hello, slow reader), now on v1.

## Also: wire platform's HTTP routes (committed 4fad32a)

- In server/main.js: `import { httpRoutes } from "./auth/http.js"` and pass
  `http: httpRoutes({ registry, sessions, oidc, tenancy, now, config, dev })` to `createServer` (engine routes stay
  first). Config keys: docs/m2/reports/p5-http.md. `oidc` may be null until the Google client exists (the /auth
  routes then answer 503); `dev` only when dev tokens are enabled. Test: POST /boards with a dev Bearer token creates
  a board a socket client can then join; /health and /ws are still the engine's.

- **Google sign-in (proxy, 2026-11-11):** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are in `.env` (gitignored;
  Bun loads it). When both are set, main.js builds `googleOidc({ clientId, clientSecret, redirectUri, fetch })` from
  server/auth/oidc.js, with `redirectUri` from env `OIDC_REDIRECT_URI`, default `http://localhost:8080/auth/callback`.
  When either is missing, `oidc` is null and the /auth routes keep answering 503. `config.cookieKey` comes from env
  `COOKIE_KEY` (>= 32 bytes); if it is missing on a single node, generate a random one per process and log a warning
  (sign-ins then don't survive a restart); in cluster mode a missing key refuses to start. Never read, print or log
  the secret values; tests use fake values and a stub fetch, never the real client. `.env` lives only in the shared tree, not your worktree: don't copy it; a real sign-in
  is checked after the merge.
- **Env isolation (proxy/platform, 2026-11-11):** Bun auto-loads `.env`, so runs in the shared tree carry the Google
  vars and COOKIE_KEY while CI and your worktree don't. `start(env)` must read **only** its `env` argument (today
  main.js:93 still reads `process.env.LOG_LEVEL`: move it to `env`). Every main.js test passes an explicit env object,
  never `process.env`, including one with no Google vars (oidc null, /auth 503) and one with fake ones. Tests must
  behave the same in every checkout. Never log env or any value from it beyond names.

## Also: keep every bus message under 2 MB (from p4-natss3)

- NATS refuses publishes over 2 MB. room-host publishes catch-up snapshots as one frame and group-commit `.entries`
  batches with no byte bound. Per § Bus, catch-up and snapshots go gateway → client read from the Store, not over the
  bus; and `.entries` batches are split under the bus cap. Test with a bus whose cap is small.

## Also: the v1.1 server half (PROTOCOL.md v1.1 on p2-land; packages/protocol already has the client/Room half)

- **Store epoch:** `Store.openEpoch()` / `epoch` in server/store/sqlite.js and server/store/postgres.js (the epoch
  lives in the lease record; add it to the store contract test). The room host passes it to the Room, so
  `welcome.room {board, epoch}` and heartbeats `{seq, epoch}` carry it.
- **Gateway:** at most 8 writer connections per (user, board, gateway), counting only live sockets; the op-rate
  bucket is per connection; a `too-large` refusal carries the op's `id`.
- **Bus:** catch-up never travels on the bus (gateway reads the Store); `.entries` batches split below 2 MB.
- **Postgres least privilege** (p4-pgv MEDIUM): the app role must work without owning the tables: skip DDL when the
  schema already exists, or a separate migrate step. Test it with a non-owner role.

## Also: two gateway gaps from the security review of 7b6a5dd (both MEDIUM)

- **Live queue cap:** gateway.js caps a connection's queued bytes only before it is `live`. Apply a per-connection
  byte cap to `c.q` (and to whatever queues ops toward the room) in every state; past it, stop reading or close with
  `limit`. Together with the per-connection op bucket above.
- **Revocation:** a connection keeps the role it had at hello. When a grant, invite or link changes (Registry
  mutation), the board's live connections must be re-checked: publish a per-board "grants changed" message, and the
  gateway re-runs `auth.role` for its connections on that board and closes or downgrades the ones that no longer
  qualify. Also close a connection when its token's expiry passes (keep `exp` from verify). If the Registry side
  needs platform code (server/auth/, server/registry/ are theirs), put a port-level hook in the gateway, test it
  with a fake, and write in your report what platform must call.

## Done when

- In the worktree: `bun test test/*.test.js test/server test/auth` all green (test/web is client's, in progress);
  no `SEAM(p2)` left in your files, or each remaining one explained in the report.
- New tests: presence relayed between two clients and never logged; a resend after a server restart gets the same
  seq; an op from a connection the rebuilt room never welcomed gets `unavailable`.

## Process rules

- Never `pkill`/`killall`; port 0; record PIDs, kill only those. sdd helpers per BRIEF-BASE (optional).

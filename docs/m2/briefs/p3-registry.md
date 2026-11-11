# Brief: p3-registry (durable SQLite Registry)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md § Tenancy and § Registry,
server/auth/registry.js (the contract: method names and typedefs are stable; read-only, platform owns it),
server/auth/tenancy.js, and server/store/sqlite.js (read-only; reuse its style: `bun:sqlite`, WAL,
`synchronous=FULL`).

- **Your tab:** `worker p3-registry (engine): SQLite registry`. Manager: `manager engine`, terminal `t14j`.
- **You own:** server/registry/ (new) and test/server/registry*.test.js (new). Nothing else. Another builder
  (p3-scaffold fix) is editing the rest of server/ and test/server/ right now; don't touch those files, including
  server/main.js. Platform owns server/auth/, server/admin/, test/auth/.
- **Report:** docs/m2/reports/p3-registry.md. Then stop, idle. Don't commit.

## Goal (proxy decision: engine owns the durable Registry)

A SQLite Registry adapter, `createSqliteRegistry({ path })` (or a matching factory), implementing every method of
the Registry contract in server/auth/registry.js with the same semantics as platform's in-memory one, so the
phase-3 restart gate through main.js works (boards, grants, invites, links survive a restart). Postgres is phase 4;
keep SQL plain so it ports.

- Ids server-minted over `[a-z0-9-]` like the in-memory one (reuse its helper if exported; else match its format).
- **`setGrant` keeps at least one owner per board, atomically:** removing or downgrading the last owner fails and
  changes nothing; the check and the change are one transaction (or a conditional statement), so two concurrent
  calls can't both pass. Test it with two connections/handles on one file.
- Durable = writes survive close/reopen (test it), `synchronous=FULL`.
- **Platform's contract test:** platform is adding a test in test/auth/ that takes a Registry factory. If it exists
  when you finish, run it against your adapter (from your own test file, importing it) and make it pass; if it
  doesn't exist yet, say so in your report and test the contract yourself method by method.
- Wiring into server/main.js is **not** yours: write the exact change (a few lines) in your report; the manager
  hands it to the session that owns main.js.

## Done when

- Every Registry method implemented and tested (incl. last-owner atomicity across two handles, close/reopen).
- Platform's contract test passes against your adapter, or its absence is reported.
- `bun test` passes. Temp dirs only, nothing written into the repo tree.

## Process rules

- Never `pkill`/`killall`; port 0 for anything you start; record PIDs and kill only those.
- sdd helpers per BRIEF-BASE (optional).

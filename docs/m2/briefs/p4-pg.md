# Brief: p4-pg (Postgres Store and Registry adapters)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PLAN.md phase 4, PROTOCOL.md § Ports
(§ Store, § Registry) and § Tenancy, then the SQLite adapters you mirror: server/store/sqlite.js,
server/registry/sqlite.js (read-only), server/auth/registry.js and test/auth/registry-contract.js (platform's,
read-only), test/server/store.test.js (read-only; another builder owns it).

- **Your tab:** `worker p4-pg (engine): Postgres store + registry`. Manager: `manager engine`, terminal `t14j`.
- **You own (new files only):** server/store/postgres.js, server/registry/postgres.js, test/server/store-contract.js
  (a Store contract factory you write from § Store and store.test.js), test/server/pg-store.test.js,
  test/server/pg-registry.test.js. Nothing else; another builder is editing the rest of server/ and test/server/.
- **Report:** docs/m2/reports/p4-pg.md. Then stop, idle. Don't commit.

## Goal (PLAN.md phase 4, adapters only; leases and takeover come later)

- **Postgres Store** behind § Store, same contract as the SQLite one: async; `append(tenant, board, entries,
  expectSeq)` atomic and conditional (unique `(tenant, board, seq)`, stale expectSeq → `conflict`), `read` ascending,
  `putCheckpoint`/`getCheckpoint(…, beforeSeq?)` highest seq wins; durable = commit with `synchronous_commit=on`.
- **Postgres Registry** implementing server/auth/registry.js's contract, passing `registryContract(name, make)`;
  `setGrant`'s last-owner check atomic under concurrency (`SELECT … FOR UPDATE` on the board row, or SERIALIZABLE
  with retry), tested with two concurrent connections; timestamps from the injected `now()`, never SQL's clock.
- Use Bun's built-in Postgres client (`Bun.sql` / `SQL`), no new dependency. Schema created idempotently on start
  (CREATE TABLE IF NOT EXISTS), plain SQL; each test uses its own schema or table prefix and drops it after.
- Connection from `DATABASE_URL` (passed in by the caller; adapters take a URL or client, never read env themselves).

## Tests and where they run

- Tests **skip** (bun:test `skipIf`) when `DATABASE_URL` is unset, so the shared `bun test` stays green locally; CI's
  `test-cluster-services` job sets it (Postgres 17 service).
- Locally there is no Postgres yet. You may install it: `brew install postgresql@17` (no `brew services`), then run a
  throwaway server from a temp data dir on a free port (`initdb`, `pg_ctl -o "-p <port>" start`), record its PID,
  stop it by `pg_ctl stop` / that PID when done. Never pkill. Report exactly what you installed.
- Done when: the Store contract and registryContract both pass against Postgres locally (say how) with
  `DATABASE_URL` set, and skip cleanly without it; `bun test` green.

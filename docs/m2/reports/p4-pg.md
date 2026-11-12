# Report: p4-pg (Postgres Store and Registry adapters)

**Status: done.** Both adapters pass their contracts against a local Postgres 17 with `DATABASE_URL` set, and skip
cleanly without it. `bun test` is green both ways. Not committed (the manager commits).

## What changed (new files only)

| File | What |
|---|---|
| `server/store/postgres.js` | `postgresStore({ url \| sql, max?, schema?, keepCheckpoints? })`, an **async** factory. Same contract as `sqliteStore`: `append` / `read` (with the `maxBytes` / `bytes` extension) / `lastSeq` / `putCheckpoint` / `getCheckpoint` / `close`, plus `settings()` (reads `synchronous_commit` and `fsync`). Also exports `needSchema`. |
| `server/registry/postgres.js` | `postgresRegistry({ url \| sql, max?, schema?, now? })`, an async factory. Implements the full Registry typedef; `settings()`; `close()`. |
| `test/server/store-contract.js` | `storeContract(name, make)`: a Store contract factory built from § Store and `store.test.js` (11 tests). `make()` returns `{ store, another, cleanup? }`; `another()` opens a second handle on the same data (reopen and two hosts). |
| `test/server/pg-store.test.js` | The contract on Postgres, plus 6 Postgres-only tests. |
| `test/server/pg-registry.test.js` | `registryContract("postgres", …)`, plus 7 Postgres-only tests. |

## How it works

- **Driver:** Bun's built-in `SQL` from `"bun"`. No new dependency. The adapters never read the environment: the caller passes `url` (the adapter owns that pool and closes it) or `sql` (a client the caller owns; `close()` leaves it open).
- **Schema:** created on start with `CREATE TABLE … IF NOT EXISTS`; the schema itself only if `pg_namespace` lacks it (Postgres checks CREATE on the database *before* `IF NOT EXISTS`, so a least-privilege role failed on a schema an operator made for it: reproduced, fixed in `ensureSchema`, re-checked). All of it runs in one transaction behind `pg_advisory_xact_lock`, so several processes starting at once don't race on the catalog (tested with 10 concurrent starts). `schema` names the Postgres schema and is checked against `^[a-z_][a-z0-9_]{0,62}$` before it is spliced into SQL. Tables are `pl_entries`, `pl_checkpoints`, and `reg_*` (the same layout as SQLite).
- **Durable:** every write transaction goes through one `write` helper per adapter that runs `SET LOCAL synchronous_commit = on`. It is set per transaction, not per session, because the client is a pool and a session setting would stick to one connection only.
- **Conditional append:** one transaction reads `max(seq)`, checks it equals `expectSeq` (otherwise `conflict`), and inserts the batch with one `INSERT … SELECT FROM unnest($3::int8[], $4::text[])`.
  - Under READ COMMITTED a writer only ever sees committed rows, so no gap is possible.
  - Two writers at one seq meet at the primary key `(tenant, board, seq)`: the second blocks until the first commits, then gets `23505`, mapped to `conflict`.
  - If the first rolls back instead, the waiting append goes through (tested).
- **Entry data is TEXT, not JSONB.** That keeps exact round-trips (JSONB rejects `\u0000` inside strings) and keeps the same `length(data)` meaning for `maxBytes` as SQLite.
- **`setGrant` last owner:** `SELECT id … FOR UPDATE` on the board row first. The current role and the owner count are read in later statements of the same transaction, so each sees the other writer's commit, and then it writes. A refusal throws code `last-owner` and changes nothing.
- **Timestamps** come from the injected `now()` (tested with `now: () => 42`), never SQL's clock.
- **Garbage ids:** lookups resolve to null / [] / false for non-strings and for strings holding NUL, which Postgres refuses as text. Without that guard, a NUL would throw, and a throw means `unavailable`.
- **A domain raced by two `createTenant`s:** the unique key's `23505` is mapped to the same `"registry: domain already has a tenant"` error as the pre-check.

## Tests added (all skip when `DATABASE_URL` is unset: `describe.skipIf(!url)`, no client is opened)

- **Store contract (11 tests):**
  - conditional append (behind, taken, ahead)
  - atomic batch refusal
  - read order and limits
  - exact round-trip of quotes, backslashes, unicode, emoji, NUL and U+2028
  - `maxBytes` / `bytes`
  - separate boards and tenants
  - bad ids
  - checkpoint highest-wins, `beforeSeq` and pruning to 3
  - close and reopen, `closed`
  - two hosts racing 20 rounds with different batch sizes (no gap, no mixed batch, the fenced host stays fenced)
- **Postgres store:**
  - `synchronous_commit=on` and `fsync=on`
  - **deterministic row race:** another connection holds seq 2 uncommitted; the append is asserted still pending after 200 ms, then gets `conflict` on COMMIT
  - the same race with ROLLBACK, where the append then succeeds
  - 10 stores on separate pools racing at one seq for 10 rounds, exactly one winner each round, plus concurrent schema creation
  - pool ownership on `close()`
  - bad schema names
- **Postgres registry:**
  - `registryContract` (18 tests; its concurrent cases run on separate pooled connections)
  - `synchronous_commit=on`
  - `now()` timestamps
  - **two separate pools** racing to demote the only two owners, 40 rounds
  - **deterministic lock test:** another connection holds the board row `FOR UPDATE` and removes owner x; `setGrant(y, editor)` is asserted pending, then gets `last-owner` on COMMIT
  - 6 pools racing `createTenant` for one domain
  - same answers as the in-memory adapter (the sqlite parity script, plus NUL ids and `grant(B, bad)` / `revokeInvite(bad)`)
  - durable across close and a fresh pool

## How I checked it

- **Locally against Postgres 17.11:** a throwaway server (below), with `DATABASE_URL=postgres://plenary@127.0.0.1:<port>/plenary`.
  - `bun test test/server/pg-store.test.js test/server/pg-registry.test.js`: **42 pass, 0 fail**.
  - Full `bun test` with the URL set: **357 pass, 25 skip, 0 fail**.
  - Full `bun test` without it: **315 pass, 69 skip, 0 fail**.
  - The pg files alone without the URL: 0 pass, 44 skip.
- **Mutation check:** with `FOR UPDATE` removed from `setGrant`, 3 tests fail (the contract's concurrent removals, the two-pool race and the lock test). Restored afterwards.
- **Store contract against `sqliteStore`:** 11/11 pass, from a temporary test file that I deleted afterwards. The contract isn't Postgres-shaped. `store.test.js` (another builder's) could switch to it later.
- **Cleanup:** no `pl_test_*` schemas are left after a run (checked with psql).

## Installed, and the local server

- **`brew install postgresql@17`** (17.11) is the only new formula: its dependencies (ca-certificates, gettext, icu4c@79, json-c, krb5, libunistring, openssl@4, readline, xz, zstd) were all already installed, as their Cellar dates show (all before today). nats-server in the Cellar is from 18:58, another session's, not mine.
- **Homebrew's post-install also ran `initdb`** on a default cluster at `/opt/homebrew/var/postgresql@17`. It was never started. No `brew services`.
- **The throwaway server** used data dir `$SCRATCHPAD/pg/data`, port 54459 (picked free), TCP only. `unix_socket_directories=''` was needed because the scratchpad path is longer than the 103-byte socket path limit. PID 63248.
  - Stopped with `pg_ctl -D <that dir> stop -m fast`; `ps -p 63248` confirms it is gone. The data dir stays in the session scratchpad.

## Not verified

- **CI's `test-cluster-services` job:** not run. It should pick these files up from `DATABASE_URL` as-is; it runs Postgres 17 and its URL has a password, which `new SQL(url)` handles. The TODO at `.github/workflows/ci.yml:147` belongs to whoever owns CI.
- **Power-loss durability:** not tested, only that `synchronous_commit=on` and `fsync=on` are in effect.
- **Synchronous replicas / HA failover:** not tested.
- **Performance:** unmeasured. Each append is one transaction of 5 round trips (BEGIN, SET LOCAL, SELECT max(seq), INSERT, COMMIT).
- **Wiring into `server/main.js`:** not done (not mine).
- **`settings()` tests** show the setting a `write` transaction gets; they would not catch a future write path that skips the `write` helper (today every write goes through it, by reading).
- **Least-privilege roles:** checked by hand in psql (a role with no CREATE on the database starts fine twice on a schema it owns; on a missing schema it fails with "permission denied"), not as a committed test.

## Risks and notes for the manager

- **Async factories.** `sqliteStore` / `sqliteRegistry` are synchronous; the Postgres ones must be awaited. `main.js` needs `await postgresStore({ url: env.DATABASE_URL, max })` when it wires the cluster mode.
- **Pool sizing.** Bun's SQL pool opens up to its `max` (default 10) connections under concurrent load. 10 default pools exhausted the default `max_connections=100` during my first run. Pass `max` per process and size it against the server's limit. The store and the registry can share one client (`sql:`) to halve this.
- **Memory vs SQL divergence (platform's file, not mine):** `memoryRegistry.createTenant` keeps duplicate entries in `admins` (`[...admins]`), while SQLite and Postgres de-duplicate them. Neither contract covers it. It only matters if a caller passes duplicates.
- **`needSchema` / `ensureSchema`** are exported from the store file; fine to move to a shared module later.
- **CI:** the `test-cluster-services` job already sets `DATABASE_URL` and runs `bun test`, so these tests run there with no workflow change. Its TODO comment at `ci.yml:147` can be deleted by the CI owner. The store test asserts `fsync=on`, which is the default in the `postgres:17.11-alpine` image.
- **Checkpoint pruning** runs on every `putCheckpoint` (a `NOT IN` subquery over the board's few rows), the same as SQLite.

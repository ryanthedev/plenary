# Report: p5-pgpriv (Registry on Postgres runs with least privilege)

**Done.** The Postgres Registry now creates only missing tables and indexes at start-up, so it runs as a role with
USAGE plus SELECT/INSERT/UPDATE/DELETE. Tested against real Postgres 17.11 on Podman. Also (t187's
addition) the SQLite registry no longer fails "database is locked" when several processes open a new `registry.db`
at once; see its own section. Full `bun test` passes with and without `DATABASE_URL`. Not committed.

## What changed

| File | Change |
|---|---|
| `server/registry/postgres.js` | The blanket `CREATE TABLE/INDEX IF NOT EXISTS` (which Postgres privilege-checks before IF NOT EXISTS) is replaced by `migrate(tx, s, registryTables(s))` from `server/pg/schema.js`, plus the same `to_regclass` look-up for the two indexes (`REGISTRY_INDEXES`), still under the per-schema advisory lock. DDL unchanged, now in `REGISTRY_TABLE_DDL` (foreign-key order). A `42501` (permission denied) at start-up is rethrown as `postgres registry: start-up in schema "<s>" was refused for lack of a privilege (<pg message>). If tables are missing, run the migrate step as the schema owner; otherwise grant this role USAGE on the schema and SELECT, INSERT, UPDATE, DELETE on its tables (deploy/README.md, Postgres roles)`, with the original as `cause`. (Earlier wording claimed the cause was always a missing table; a role without USAGE gets the same 42501, checked, so the message names both fixes.) Nothing ALTERs, DROPs or GRANTs. Header documents it. Imports: the port, `auth/util.js`, `pg/schema.js` only (engine's tightened rules, 3a7520d: `test/architecture.test.js` passes). |
| `test/server/pg-registry.test.js` | The 18-test Registry contract run a second time as a runtime role, plus three tests (all skip without `DATABASE_URL`, like the rest of the file). One `afterAll` closes the role's pool, drops the role, then closes the shared client (two hooks could close the client first). |
| `server/registry/sqlite.js` | t187's addition, see "SQLite registry" below. |
| `test/server/sqlite-registry-open.test.js` | New: two multi-process tests, see "SQLite registry" below. |
| `deploy/README.md` | New section "Postgres roles (least privilege)": owner/runtime table, migrate one-liner, grant SQL, what the failure looks like, concurrent start-up note. Also t187's fix: "What runs today" now says `POST /boards` (and invite/link routes) and Google sign-in at `/auth/*` are mounted by main.js (503 unless both Google vars set); "does not serve `web/`" kept. |

## Tests added

- **Contract as the runtime role.** The owner migrates a fresh schema per test; role `pl_test_regrt_<pid>` (USAGE plus
  SELECT/INSERT/UPDATE/DELETE only) runs all 18 Registry contract tests. If the `DATABASE_URL` role can't create
  roles, it warns and runs as the owner instead.
- **Least privilege.** The owner starts the registry (creates tables and indexes); a fresh role gets only USAGE and
  row grants (`has_schema_privilege(…, 'CREATE')` checked false). As that role the registry starts and runs every
  write kind: tenant + admins, board, grants incl. the last-owner refusal, invite + revoke, link + link use (so the
  identity columns need no sequence grant). Then, on a schema nobody migrated, start-up fails with the message above
  (`cause.errno` 42501) and creates no table; a direct `CREATE TABLE` as the role is refused. Skips with a warning if
  the `DATABASE_URL` role can't create roles (same as the Store's test).
- **Exact catalog.** Start-up creates every declared table and index; a second start leaves `pg_class` identical.
- **Concurrent start-up.** Eight nodes (separate pools, `max: 1`) start at once on an empty schema: all succeed, one
  set of tables, and they read each other's writes.

## How I checked it

- **Real Postgres.** `postgres:17.11-alpine3.23` (CI's image) on Podman, random free port, random password, its id
  recorded in the scratchpad; removed by that id afterwards (`podman rm -f`, confirmed gone).
- **The test proves something.** With the old adapter swapped back in, the least-privilege test fails
  (`permission denied for schema …`); with the new one it passes. Restored and diffed after.
- **pg files:** `pg-registry` + `pg-store`: 65 pass, 0 fail; no `pl_test_regrt_*` role left behind.
- **Full suite (final run, after the SQLite fix):** with `DATABASE_URL`: 1116 pass, 34 skip, 0 fail. Without:
  1046 pass, 101 skip, 0 fail.
- **One flake seen once, not mine:** an earlier full run with `DATABASE_URL` had 1 fail in `test/server/v1.test.js`
  ("a board feed picks up the host's checkpoint…"). It passed 5/5 alone and in the final run; that test and
  `server/feed.js` are other sessions' uncommitted edits.
  (An earlier plain run had 2 fails in `test/architecture.test.js` and `test/auth/architecture.test.js` about
  `scripts/admin-bootstrap.js`, `server/admin/tenants.js` and an s3/disk allowlist entry: other sessions' in-flight
  files, not mine; both passed on the re-run after engine's 3a7520d landed.)
- **README steps run verbatim with two real roles** (neither superuser; database `plenary_rt`): before migrate, the
  app role got the clear error; the owner's migrate one-liner created all 10 tables (`pl_*`, `reg_*`); after step 3's
  grants the app role started both Registry and Store and wrote; a table the owner added later was covered by the
  default privileges; the app role has no CREATE on `public`.
- **Finding (documented, not fixed):** on Postgres 15+ `public`, a runtime role that has *no* table grants still
  starts, because the tables exist (nothing to create) and USAGE on `public` is granted to everyone. It fails at its
  first query with Postgres's `permission denied for table …`. Start-up checks it can create what is missing, not
  that it can use what exists; a `has_table_privilege` check at start-up would catch it if wanted.

## Systems design (APPLIER, short): N nodes start against an empty schema at once

- **Scope.** N nodes (dev: 1; compose: 3; later tens) share one Postgres and one schema; start-up must neither fail
  nor create twice; a runtime role may lack CREATE. Latency: start-up only, once per process; not on any hot path.
- **Estimate.** Per start: 1 lock + 9 look-ups + at most 9 DDL statements, milliseconds. 100 nodes in a rolling
  start serialise on one lock for well under a second. No sizing concern.
- **Design.** One transaction per node: `pg_advisory_xact_lock(hashtext('plenary-schema:<s>'))`, then look-up-then-create
  per object. The lock serialises the N migrations; the first creates everything and commits (releasing the lock);
  each later node runs its look-ups after acquiring the lock, in READ COMMITTED, so it sees the committed catalog and
  creates nothing. Store and Registry take the **same** lock key per schema, so they also never race each other.
- **Deep dive: why not just IF NOT EXISTS.** (1) Privilege: Postgres checks CREATE before IF NOT EXISTS, so a
  runtime role fails even when the table exists. (2) Races: two concurrent `CREATE TABLE IF NOT EXISTS` can still
  collide on the catalog's unique index (`pg_type` / `pg_class`, 23505); the lock removes that.
- **Deep dive: mixed roles.** Owner node and runtime nodes starting together: if a runtime node takes the lock first
  on an empty schema it fails loudly (correct: it has nothing to run on) and the owner node then migrates; a restart
  of the runtime node succeeds. Advisory locks need no grant, so runtime roles can take it.
- **Wrap-up / risks.** (a) `hashtext` collisions with another app's advisory lock on the same database would only
  add waiting, never wrong results. (b) A schema change to an *existing* table is not handled (look-up sees it exists):
  needs a real versioned migration step (phase 4's `plenary migrate`). (c) Index look-up uses the index name in the
  schema; a same-named object of another kind would be taken as present.

## What I did NOT verify

- Docker (not installed); only Podman. CI's `test-cluster-services` job will run these tests on its Postgres; its
  role is the image superuser, so the least-privilege test runs there rather than skipping.
- `main.js` does not wire Postgres yet, so no end-to-end server start as the runtime role; adapters only.
- Postgres older than 17. The README's `REVOKE CREATE ON SCHEMA public FROM PUBLIC` note for 14 and older is from
  Postgres's documented default change in 15, not run.

## SQLite registry: several processes opening a new `registry.db` (t187's addition)

- **Reproduced first.** 12 processes opening one new file at once, old code: 20/240 and 30/240 opens failed with
  `database is locked`, all at `server/registry/sqlite.js:38`, the `PRAGMA journal_mode=WAL` line. `busy_timeout`
  was already set on line 37, as engine said. The race is machine and timing dependent (in a fresh temp directory the same repro gave 0 failures).
- **A deterministic trigger.** Another process holding a write lock (`BEGIN IMMEDIATE`) on the new file while it is
  still in rollback-journal mode makes the old WAL switch fail at once: 5/5, in about 11 ms, so the 5 s busy handler
  is not waited on. This is a stand-in for a concurrent opener, not the exact production sequence: holders in WAL
  mode (`journal_mode=WAL` then `BEGIN IMMEDIATE`, or a read) and a `BEGIN EXCLUSIVE` holder all gave `ok` on the
  old code. Likely mechanism (inferred, not traced in SQLite's source): the switch holds a read lock and wants an
  exclusive one while another connection holds the reserved lock, and SQLite returns BUSY rather than wait into a
  deadlock. Even reading `PRAGMA journal_mode` can return BUSY in the race.
- **Chosen fix, both of engine's suggestions together.** After `busy_timeout`:
  1. Skip the switch when `PRAGMA journal_mode` already reads `wal` (the common case for every opener after the first).
  2. `onBusyRetry(deadline, f)`: retry the read-and-switch, and the first schema transaction (now `.immediate()`),
     while the error code is `SQLITE_BUSY*` or `SQLITE_LOCKED*`; backoff 5 ms doubling to 100 ms with jitter,
     `Bun.sleepSync`, all within the same `busyTimeoutMs` budget (default 5000 ms), then the last error is thrown.
- **Why.** Skipping alone does not help the race (the read itself can be BUSY, and the first openers all see
  `delete`); retry alone works but needlessly takes the switch path every open. The budget reuses `busy_timeout`, so a
  truly stuck file still fails after the same time as before, with SQLite's own error. Sync sleep keeps the factory
  synchronous, as its callers expect. **Engine can copy `onBusyRetry` and the three lines around it into
  `server/store/sqlite.js`**, which has the same open sequence.
- **Tests** (`test/server/sqlite-registry-open.test.js`): (1) a child process holds the new file's write lock for
  300 ms while the test opens the registry: it waits, writes, and the file ends in WAL; (2) 12 `Bun.spawn` processes
  × 3 rounds open the same new file at the same instant and each creates a tenant: all print ok, the mode is `wal`,
  12 tenants. With the old code swapped in, test 1 fails every time (`database is locked`, plus the 5/5 probe) and
  is the regression guard; test 2 failed in that run but passed 3/3 on the old code earlier, so it catches the bug
  only sometimes. With the fix both pass; the file was restored and compared after. Load: 40 rounds × 16 processes, 0/640 failures with the fix.
- **Not verified:** Linux (macOS only), network filesystems (SQLite locking there is unreliable anyway).

## For others (not my files)

- **Engine, `server/pg/schema.js`:** `migrate()` handles tables only; I look indexes up in the Registry adapter. If
  you'd rather own it, an `indexes` argument to `migrate()` would let both adapters share it. No change needed now.
- **Store's error:** a runtime role on an unmigrated schema gets Postgres's bare `permission denied for schema …`;
  the Registry's message names the fix. Engine may want the same wrapper in `server/store/postgres.js`.
- **Engine, `server/store/sqlite.js`:** same open sequence as the old registry; copy the fix above.
- **deploy/README.md stale line (not fixed, t187 said "nothing else"):** "Boards live in an in-memory registry, so the
  board id changes on every restart" is stale: main.js keeps the Registry in `<data>/registry.db` and reuses the dev
  board id from `<data>/dev-board.json`.

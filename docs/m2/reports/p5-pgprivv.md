# Report: p5-pgprivv (verify p5-pgpriv)

**PASS.** No HIGH or MEDIUM findings; five LOW. Everything in the brief's check list was run against real
Postgres 17.11 (Podman, CI's image) and real multi-process SQLite. Tree unchanged (only this report written).

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | LOW | SQLite `onBusyRetry` budget overruns `busy_timeout` (measured ~2×; bounded, start-up only) | reproduced; codex said MEDIUM |
| 2 | LOW | PG15+ runtime role with no table grants starts, then every call fails 42501 | reproduced; probe recommended |
| 3 | LOW | No `lock_timeout` on the start-up advisory lock: a stuck holder blocks every start-up | reproduced; shared with the Store |
| 4 | LOW | pg-registry tests leak pools/schemas/roles on their failure paths | confirmed by reading |
| 5 | LOW | deploy/README.md lines 25–26 still stale (in-memory registry) | confirmed; builder flagged, told not to fix |

## Checks run

### Postgres, for real

- **Setup.** `postgres:17.11-alpine3.23` in Podman on a random free port, superuser `postgres`, random password,
  `log_statement=all`, `log_line_prefix='[%u] '`. A second fresh container for the README run (below). Both ids were
  recorded in the scratchpad and removed by id at the end.
- **pg tests:** `pg-registry` + `pg-store`: 65 pass, 0 fail. No `pl_test_*` roles or schemas left afterwards.
- **Statements watched in the server log, per role.** Over a full `pg-registry` run, the runtime roles
  (`pl_test_regrt_*`, `pl_test_regapp_*`) ran only BEGIN/COMMIT/ROLLBACK, `SET LOCAL`, SELECT, INSERT, UPDATE,
  DELETE, `to_regclass` lookups and `pg_advisory_xact_lock`. They ran exactly two DDL statements, and Postgres refused
  both on purpose: the start-up on the unmigrated `bare` schema (`CREATE TABLE … reg_tenants`, 42501) and the test's
  direct `CREATE TABLE … reg_extra` probe. No ALTER, DROP, GRANT or REVOKE from any runtime role.
- **Code read.** The only DDL left in `server/registry/postgres.js` is `CREATE INDEX` behind a `to_regclass` null
  check (line 90); tables come from `migrate()` (`server/pg/schema.js`, also behind look-ups). The factory never
  ALTERs, DROPs, GRANTs or owns anything.
- **Missing table, no CREATE right:** fails with
  `postgres registry: start-up in schema "…" was refused for lack of a privilege (permission denied for schema …)`.
  `cause.errno` is 42501 and no table is created (the test asserts both; I also saw it live in the README run).

### Concurrent start-up (separate OS processes, not just pools)

- **Run.** 3 rounds × 16 `bun` processes against a fresh, empty **database** each round, released at one instant:
  8 started `postgresRegistry` and 8 started `postgresStore` (each `max: 1`).
- **Result.** 48/48 started. Each database had exactly 10 tables (7 `reg_*` + 3 `pl_*`) and 8 tenants.
- **Why it works.** The Store and Registry take the same lock key (`plenary-schema:<s>`, `server/store/postgres.js:80`
  and `server/registry/postgres.js:86`), so they also never race each other.

### The builder's PG15+ finding (judged, not fixed)

- **Reproduced.** Role `plenary_nogrant` (LOGIN only, no grants) on a migrated PG17 `public`: the Registry
  **starts**, then the first read and the first write both throw `42501 permission denied for table reg_tenants`.
- **Judgement: LOW today; start-up should probe.** It fails closed: lookups throw, which § Auth maps to
  `unavailable`, not to a wrong answer. But the node comes up "healthy" and then refuses every request. Once cluster
  mode wires Postgres (main.js doesn't yet), a load balancer would keep routing to it, so it becomes MEDIUM then.
- **Suggested fix.** One query at start-up, after the migrate step:
  `has_table_privilege(<table>, 'SELECT,INSERT,UPDATE,DELETE')` for each declared table, failing with the same "grant
  this role …" message. It costs one round trip. The Store has the same gap.

### SQLite open fix

- **The new test fails on the old code.** I ran it in a scratch copy (`git show HEAD:server/registry/sqlite.js` plus
  the two imports it needs), never the tree. Old code, 3 runs: test 1 failed 3/3 (`database is locked` in ~10 ms) and
  the 12-process race failed 2/3. New code: 2/2 pass, 5/5 runs.
- **A bigger race.** 12 rounds × 12 processes opening one new file at the same instant, each creating a tenant. Old
  code: **30/144 failed** with `SQLITE_BUSY`. New code: **144/144 ok**.
- **Mechanism matches the builder's account.** The holder took its lock with `busy_timeout` 5000 and held it for
  400 ms. The old code failed only one case, a RESERVED (`BEGIN IMMEDIATE`) holder on a rollback-mode file, and it
  failed in 1 ms. It waited correctly for the other three cases (an IMMEDIATE holder in WAL mode, and EXCLUSIVE
  holders in either mode). The new code waited and opened in all four, in about 360 ms.
- **Bounded.** I held a lock past the budget (8 s, `busyTimeoutMs` 1000), in all four lock and mode combinations.
  The new code threw `SQLITE_BUSY database is locked` after 1002–1067 ms. It has no unbounded wait, and it rethrows
  SQLite's own error.
- **Non-BUSY errors are not swallowed.** A file that is not a database threw `SQLITE_NOTADB` in 2 ms, with no retry.
  The retry checks `err.code` against the `SQLITE_BUSY*` and `SQLITE_LOCKED*` prefixes only.
- **A harness note, for whoever re-runs this.** My first holder script let its `Database` be garbage-collected while
  it slept (`d` was not used after the sleep). The lock was silently released, and the opener "succeeded" against a
  lock it believed was held. The fix is to keep the handle referenced, as the builder's test does by committing after
  the sleep.

### deploy/README.md

- **The SQL works pasted verbatim** (fresh container, PG17), run step by step:
  - *Step 1, as superuser:* creates the two roles and the database.
  - *Before the migrate:* `plenary_app` gets the clear Registry message.
  - *Step 2 (the `bun -e` one-liner, as `plenary_owner`):* prints `migrated public` and creates 10 tables, all owned
    by `plenary_owner`.
  - *Step 3 (`psql` as owner):* the GRANT and ALTER DEFAULT PRIVILEGES run cleanly.
  - *Result:* `plenary_app` then starts both Registry and Store and writes a tenant, a board, a link and a link use.
    It has no CREATE on `public` or on the database.
  - *Default privileges:* a table the owner adds later is covered.
  - *Logged DDL:* the only DDL logged for `plenary_app` is the one refused pre-migrate CREATE.
- **Line 21 is fixed and correct.** `server/main.js` mounts `httpRoutes` (`POST /boards`, invite and link routes,
  `/auth`). It answers 503 unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (main.js:120–122).
- **Not checked:** PG ≤ 14 and its `REVOKE CREATE ON SCHEMA public` note (same as the builder).

### Hexagonal and full suite

- **Imports.** `server/registry/postgres.js` imports the port, `auth/util.js` and `pg/schema.js`.
  `server/registry/sqlite.js` imports the port and `auth/util.js`. Both architecture tests pass
  (`test/architecture.test.js`, `test/auth/architecture.test.js`: 27 pass).
- **Full `bun test` without `DATABASE_URL`:** 1063 pass, 112 skip, 0 fail. `.env` holds no `DATABASE_URL` (I
  checked key names only), so Bun's automatic `.env` loading did not turn the pg tests on.
- **Full `bun test` with `DATABASE_URL`** (my container): 1144 pass, 34 skip, 0 fail.

## Findings

1. **LOW: SQLite retry budget is not a hard cap** (`server/registry/sqlite.js:34–42, 61–69`).
   - *The gap.* `onBusyRetry` checks the deadline only after an attempt fails, and each attempt's statements can
     themselves wait up to `busy_timeout` in SQLite's busy handler. Examples: the `PRAGMA journal_mode` read needs a
     shared lock, and `BEGIN IMMEDIATE` needs a reserved lock.
   - *How it overruns.* After a backoff sleep the loop attempts again without rechecking the deadline. The schema
     transaction's first attempt always runs with a full `busy_timeout`, however much of the budget the WAL phase
     already used.
   - *Measured.* One holder process takes `BEGIN IMMEDIATE` on the new rollback-mode file for 900–950 ms. In the same
     process it then commits, switches to WAL and takes `BEGIN IMMEDIATE` again, holding it for 6 s. With
     `busyTimeoutMs` 1000 the open threw `SQLITE_BUSY` after **1945–2014 ms** (4 runs), so about **2× the budget**
     (about 10 s at the default 5 s). A lock held throughout throws at about 1.0×.
   - *Theoretical bound.* Up to about 3× is possible, if the last WAL-phase attempt also waits in the busy handler. I
     did not hit that case.
   - *Rating.* Codex rated it MEDIUM; Grok did not report it. I rate it LOW: it is bounded, start-up only, and fails
     loudly with SQLite's error. The comment's claim "within the same busy_timeout budget" is the inexact part.
   - *Fix, either one.* Set `PRAGMA busy_timeout` to the remaining budget before each attempt, or reword the comment.
2. **LOW: a PG15+ role with no table grants starts.** Covered under "The builder's PG15+ finding" above: a start-up
   `has_table_privilege` probe is recommended. It becomes MEDIUM when cluster mode goes live.
3. **LOW: no timeout on the start-up advisory lock** (`server/registry/postgres.js:86`; the Store has the same at
   `server/store/postgres.js:80`).
   - *Reproduced.* A `psql` session held `pg_advisory_xact_lock(hashtext('plenary-schema:stuck_s'))` for 12 s. The
     Registry was still waiting at 8 s and started at 11.0 s, only when the holder committed.
   - *Impact.* A wedged migrator, or a hung node holding the transaction open, blocks every node's start-up until
     Postgres drops that session. It is not a correctness bug.
   - *Fix.* `SET LOCAL lock_timeout = '<n>s'` before the lock, with a clear message. This belongs to engine
     (`schema.js`/Store) and platform together.
4. **LOW: test cleanup on failure paths** (`test/server/pg-registry.test.js`). Codex found these; I confirmed them by
   reading. They only matter when a test already fails:
   - In the eight-node test (about line 285), `Promise.all` rejecting leaves `hs` unassigned. The `finally` then has
     nothing to close, so the successful pools stay open and the schema is not dropped.
   - The least-privilege test (about line 229) creates its role and schemas before its `try`, so a failed grant
     leaks them.
   - The file's `afterAll` `DROP ROLE` fails if any schema granted to `pl_test_regrt_*` survived a failed cleanup.
5. **LOW: deploy/README.md lines 25–26 are still stale.** They say "Boards live in an in-memory registry, so the
   board id changes on every restart". In fact `server/main.js` keeps the Registry in `<data>/registry.db`
   (main.js:114) and reuses the dev board from `<data>/dev-board.json` (main.js:129). The builder reported this and
   says t187 told them to leave it.

## Ensemble review (sdd)

- **Adapters.** codex (effort high) and grok, each in its own scratch git worktree holding exactly this job's diff
  (no `.env`). agy is out of quota (429, resets in ~55 h). kimi is not logged in and mistral has no API key; both
  failed `check_adapter`. qwen is not installed.
- **codex: FAIL.** One MEDIUM (finding 1; I re-rated it LOW, see above) and two LOW (finding 4, confirmed).
- **grok: PASS**, no findings.
- **Agreement.** No finding was reported by two harnesses, so none qualified as a HIGH candidate.

## Systems design (CHECKER, systems-design v0.1.0): concurrent start-up

| Check | Verdict |
|---|---|
| Correctness under concurrency | **OK.** Per-schema `pg_advisory_xact_lock`, then look-up-then-create, in READ COMMITTED. Later nodes see the first node's committed catalog. Store and Registry share the key. Verified with 48 processes. |
| Failure: node dies mid-migrate | **OK.** DDL is transactional in Postgres, so it rolls back, and the xact lock is released with the session. |
| Failure: lock holder hangs | **Gap (finding 3).** There is no `lock_timeout`, so every start-up waits on the holder. |
| Failure: mixed owner and runtime nodes on an empty schema | **OK.** The runtime node fails loudly; the owner migrates; a restart of the runtime node succeeds. This is the builder's analysis, consistent with my README run. |
| Failure: misgranted runtime role | **Gap (finding 2).** It starts healthy and fails per request. |
| Rolling upgrade that adds a table | **OK.** A runtime node on the new version fails loudly until the owner migrates. DEFAULT PRIVILEGES covers the new table (verified). Column changes to existing tables are not handled; that needs phase 4's versioned migrate, as the builder says. |
| Scale ×10 (tens to hundreds of nodes) | **OK.** One lock, then ~10 catalog look-ups, in milliseconds. A rolling start serialises in well under a second. |
| Single point of failure | **None new.** Postgres itself is the SPOF, as before, outside this job. |
| SQLite multi-process open | **OK, single machine only** (POSIX locks). Bounded by finding 1. Network filesystems are unsupported, as the builder notes. |

## Noise (other sessions' files, not judged)

- **server/server.js and the untracked server/static.js (another session, uncommitted).** They make the server serve
  `web/` by default. When they land, README line 22's "the server does not serve `web/`" becomes stale. That line is
  true at HEAD.
- **server/main.js has uncommitted edits by another session.** I checked README line 21 against the working tree.

## What I did NOT verify

- Linux SQLite locking (macOS only). PG ≤ 14. Docker (Podman only).
- The 3× theoretical worst case in finding 1 (the 2× case was measured).
- An end-to-end server start as the runtime role, because main.js doesn't wire Postgres.

## Clean-up

- **Leftovers.** Checked after every run, including the full `DATABASE_URL` suite: no `pl_test_*` roles or schemas
  remained.
- **Containers.** Both Podman containers were removed by their recorded ids, and `podman ps -a` shows neither.
- **Worktrees.** The two scratch worktrees were removed (`git worktree remove --force`). `git worktree list` shows
  only the main tree and the pre-existing `plenary-p2`, which is not mine.
- **Tree.** The judged files are unchanged (still 244 insertions and 35 deletions); the only new path is this report.
- **Scratch files** are in the session scratchpad only.

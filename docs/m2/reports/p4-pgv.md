# Report: p4-pgv (verify the Postgres Store and Registry adapters)

**PASS.** No HIGH findings. One MEDIUM finding (start-up needs the app role to own its tables, so a
migration-style deployment fails) and three LOWs. Both contracts pass against real Postgres 17.11. The two races the brief named (conditional append and
last owner) hold across separate OS processes. The test files skip cleanly without `DATABASE_URL`.

Verifier: p4-pgv (engine), 2026-11-11. I did not read the builder's report (docs/m2/reports/p4-pg.md).

## How I checked

- **Throwaway Postgres 17.11:** `initdb` in my session scratchpad, `pg_ctl` on a free port, TCP only (`-k ''`,
  because the scratchpad path is longer than the 103-byte limit on a Unix socket path). I started it twice, as PID
  6865 and then PID 1108. Each time I stopped it with `pg_ctl stop` and confirmed the PID had exited. I did not use pkill, brew services or
  /opt/homebrew/var.
- **Repo tests:**

  | Run | Result |
  |---|---|
  | `bun test`, no `DATABASE_URL` | 315 pass, 69 skip, 0 fail. The pg files skip cleanly. |
  | Only `pg-store.test.js` and `pg-registry.test.js`, with `DATABASE_URL` | 42 pass, 0 fail |
  | Full `bun test` with `DATABASE_URL`, 11 runs | 10 runs clean (357 pass, 25 skip, 382 tests). 1 run had **1 fail** (see L3). |
  | The two pg files, 2 loops × 50 runs, side by side on one database | **100/100 clean.** Afterwards there were 0 leftover `pl_test_%` schemas and no stray connections. |

- **Scratch tests** (in the scratchpad, not the repo):
  - `sqlite-contract.test.js`: `test/server/store-contract.js` run against `server/store/sqlite.js`, reopened on
    a temp file. **11/11 pass**, so the shared contract matches the real reference store.
  - `race.js` + `w-store.js`: 6 separate `bun` processes, each with its own pool, appended batches of 1–3 to one
    board, 300 attempts each.
    - 306 batches won and 1,494 got `conflict`. No other error appeared (no deadlock and no serialization failure).
    - The log held 607 rows, contiguous from seq 1.
    - Every batch was whole and in order (0 broken), so there were no gaps and no duplicates.
  - `race.js` + `w-reg.js`: 5 separate processes, each looping "grant myself owner, then demote or remove myself",
    200 times each. Meanwhile the main process removed both seed owners concurrently, and a sampler counted the
    board's owners in SQL **10,913 times**.
    - The owner count never went below 1, and the board ended with exactly 1 owner.
    - Refusals were 34, all with code `last-owner`.
    - No connections leaked: afterwards only the sampler's connections were open.
  - `edge.js` and `lp2.js`:
    - Least-privilege start-up, in three role setups (finding M1).
    - Seqs above int32: I inserted a row at 3,000,000,000 directly. `lastSeq`, an `append` at that expectSeq and
      `read` all handled it correctly.
    - A checkpoint at seq 2^53−1 (finding L2).
    - Odd Registry inputs compared with the memory adapter (finding L1).
    - With the database default set to `synchronous_commit = off`, `settings()` still reports `on`, so the
      `SET LOCAL` overrides it.
  - `cp.js`: 8 stores putting checkpoints concurrently, 20 rounds (finding L4).
- **Code reading** (against PROTOCOL.md § Store, § Registry and § Tenancy):
  - **SQL injection:** every value is a bound parameter. The schema name is the only spliced identifier, and it
    is gated by `/^[a-z_][a-z0-9_]{0,62}$/` and quoted.
  - **Durability:** every write path, in both adapters, goes through the `write()` helper (`SET LOCAL
    synchronous_commit = on`).
  - **Tenant keys:** Store keys are `(tenant, board, seq)`, and both ids pass `needId`.
  - **Last-owner lock:** `setGrant` locks the board row (`FOR UPDATE`) before it reads the role or counts owners.
  - **Clock:** timestamps come from the injected `now()`. The URL or client comes from the caller, and the
    adapters never read env.
- **Codex review (sdd, single harness, effort high):** run on a scratch copy of the repo, so it couldn't edit the
  real tree. It returned one finding, which I confirmed (L4). With only one harness there was no agreement between
  reviewers, so nothing became a HIGH candidate.

## Findings

### MEDIUM

- **M1. Start-up needs the app role to own its tables (or create them itself)**
  - **Where:** `server/store/postgres.js:66-71` and `server/registry/postgres.js:53-75`.
  - **What happens:** every start runs `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. Postgres
    checks the CREATE privilege on the schema **before** it looks at `IF NOT EXISTS`. `CREATE INDEX IF NOT EXISTS`
    on an index that already exists still requires ownership of the table (I checked this with the real name,
    `reg_invites_board`).
  - **Reproduced** with a role that has no CREATE on the database:

    | Setup | Store | Registry |
    |---|---|---|
    | A: operator makes the schema; app has USAGE+CREATE on it and creates its own tables | starts | starts |
    | B: operator also makes the tables; app has schema USAGE+CREATE plus read/write | starts | **fails**: `must be owner of table reg_invites` |
    | C: operator makes everything; app has schema USAGE plus read/write only | **fails**: `permission denied for schema` | **fails**: same |

  - **What this means:** the case `ensureSchema`'s comment describes (A) works. A migration-style deployment fails:
    an operator role creates the tables and a narrower app role only reads and writes (B and C).
  - **Impact:** no data is lost and no contract is broken. It is a deployment constraint, and today nothing
    documents it.
  - **Fix options (for a builder or the manager):**
    - **Code:** check `to_regclass` for each table and index and create only what's missing, as `ensureSchema`
      does for the schema. Add a test that starts both adapters as a role with USAGE plus read/write only.
    - **Docs:** state that the app role must own its tables.

### LOW

- **L1. Registry edge inputs differ from the memory adapter**
  - **NUL in a user or email:** `setGrant(board, "u\0x", …)` and `createInvite({ email: "a\0@b" })` make the
    Postgres server throw `invalid byte sequence for encoding "UTF8"`, while the memory adapter accepts them.
    Under § Auth a throw reads as `unavailable`, not `auth`. The lookups already map NUL to null; the writes
    don't.
  - **`user: undefined`:** stored as the string `"undefined"` in Postgres; memory stores the value `undefined`.
  - **Duplicate admins:** de-duplicated in Postgres but kept by memory (the builder noted this).
  - **Impact:** callers pass verified Google subjects, so this is low. The contract could pin the behaviour down,
    or the writes could refuse a non-string or NUL-containing user with a plain error.
- **L2. A checkpoint at seq 2^53−1 is never returned**
  - **Where:** `getCheckpoint` with no `beforeSeq` uses `seq < Number.MAX_SAFE_INTEGER`, so a checkpoint stored at
    exactly that seq is invisible. Reproduced.
  - **Same in SQLite:** the SQLite store has identical code.
  - **Impact:** unreachable in practice.
- **L3. One unidentified failure in 11 full `bun test` runs with `DATABASE_URL` set**
  - **What happened:** the first full run reported 356 pass and 1 fail, with the same 382 tests as clean runs, so
    a single test failed rather than a file dying. I didn't capture that run's output, so I can't name the test.
  - **Bounded:**
    - The other 10 full runs were clean.
    - 100/100 runs of the two pg files were clean, including two loops running side by side on one database.
    - The Postgres server log for the whole session has no deadlock, serialization failure, "too many clients"
      or FATAL (only the expected unique-key conflicts and my own probes).
  - **Conclusion:** I can't attribute the failure to this job's files. Expect counts vary a lot between clean runs
    (13k–39k) because some other test files are randomized (for example `test/auth/http.test.js` and
    `test/web/paint.test.js`), which makes those files a likelier source.
  - **Note for the manager:** watch for it in CI.
- **L4. Concurrent `putCheckpoint` calls can keep more than `keepCheckpoints` rows** (codex's lead, confirmed)
  - **What happens:** under READ COMMITTED, each transaction prunes against a view that doesn't include the
    other's uncommitted insert.
  - **Reproduced:** 8 concurrent puts per round left up to 10 rows, where the limit is 3. In all 20 rounds the
    highest seq still won, and the pruning can only keep extra rows, never delete one that should stay. The next
    uncontended put trims the extra.
  - **Impact:** practically none, because one room host writes a board's checkpoints. Locking the board's rows
    first would make it exact.

## Not verified

- CI itself. Power loss, synchronous replicas and HA failover. Performance (the builder notes 5 round trips per
  append). Pool exhaustion near `max_connections`: my runs, including two test processes side by
  side, stayed under 100 and never hit "too many clients", but I didn't push them to the limit.
- The repo's pg tests don't cover `settings()` on paths other than the `write` helper. I checked by reading the
  code that every write goes through `write()`.

## For the manager

- **Changes I made:** only this file. Scratch tests are in my session's scratchpad.
- **M1 needs a decision:** have a builder fix start-up so it creates only what's missing, or document that the
  app role must own its tables.

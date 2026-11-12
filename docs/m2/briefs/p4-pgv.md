# Brief: p4-pgv (verify the Postgres Store and Registry adapters)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PROTOCOL.md § Store, § Registry, § Tenancy, server/auth/registry.js and test/auth/registry-contract.js
(contract), then the job's files. **Do not read docs/m2/reports/p4-pg.md**.

- **Your tab:** `verifier p4-pgv (engine): Postgres store + registry`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p4-pgv.md only. Everything else is read-only.
- **The job's files** (new, untracked): server/store/postgres.js, server/registry/postgres.js,
  test/server/store-contract.js, test/server/pg-store.test.js, test/server/pg-registry.test.js. Other files in
  server/ and test/server/ are other jobs'.
- **Postgres:** postgresql@17 is installed (`/opt/homebrew/opt/postgresql@17/bin`). Run a throwaway server: `initdb`
  in a scratch dir, `pg_ctl -D <dir> -o "-p <free port>" start`, record its PID, stop with `pg_ctl -D <dir> stop` and
  confirm. Never pkill, never `brew services`, never touch /opt/homebrew/var/postgresql@17. Scratch tests outside the repo.
- **sdd ensemble:** codex only today: label it "single harness"; findings are leads to confirm or refute.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings. Then stop, idle.

## The job

Goal: Postgres adapters behind the existing ports via Bun's built-in SQL client. Store: same contract as
server/store/sqlite.js (atomic conditional `append(tenant, board, entries, expectSeq)` with stale expectSeq →
`conflict`, ascending `read`, checkpoints highest-seq-wins with `beforeSeq`; durable = `synchronous_commit=on`).
Registry: every method of server/auth/registry.js, passing `registryContract`; `setGrant`'s last-owner check atomic
under concurrency (row lock or SERIALIZABLE); timestamps from the injected `now()`. URL from the caller, never env.
Tests skip cleanly without DATABASE_URL.

Done when: both contracts pass against real Postgres 17; skip cleanly without it; `bun test` green.

## Hunt for

- **Conditional append races:** two writers (two pools/processes) appending at the same expectSeq: exactly one wins,
  the other gets `conflict`, no gap or duplicate seq; a batch is all-or-nothing.
- **Last-owner race:** concurrent demotions on a two-owner board across processes never leave zero owners.
- SQL injection, cross-tenant reads, schema/prefix isolation between tests, connection leaks, pool exhaustion.
- Run test/server/store-contract.js against the SQLite store too: does the contract match the real one?

## The builder's not-verified list and risks

- CI not run. Power loss, replicas/HA failover not tested. Performance unmeasured (5 round trips per append).
- Async factories (must be awaited). Pool sizing: default max 10 per pool exhausted max_connections=100 in a run.
- memoryRegistry keeps duplicate admins while SQL de-duplicates (contract doesn't cover it).
- `settings()` tests only cover writes through the `write` helper. Least-privilege role checked by hand only.

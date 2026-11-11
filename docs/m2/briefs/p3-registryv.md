# Brief: p3-registryv (verify the durable SQLite Registry)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PROTOCOL.md § Tenancy and § Registry, server/auth/registry.js (the contract), test/auth/registry-contract.js,
then the job's files. **Do not read docs/m2/reports/p3-registry.md** (the builder's claims).

- **Your tab:** `verifier p3-registryv (engine): SQLite registry`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p3-registryv.md only. Everything else is read-only.
- **Scratch** outside the repo (`mktemp -d`). Never `pkill`/`killall`; port 0; record PIDs, kill only those.
- **sdd ensemble:** load `sdd:subagent-driven-development`, check usage, run codex over the job's files. Codex is the
  only harness today: label it "single harness"; its findings are leads to confirm or refute.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings (where, failure scenario, fix). Then stop, idle.

## The job

Files (new, untracked): **server/registry/** and **test/server/registry.test.js**. Nothing else is this job's
(other test/server files belong to another job in progress).

Goal: a SQLite Registry adapter implementing every method of server/auth/registry.js with the in-memory one's
semantics, durable across restart (`bun:sqlite`, WAL, `synchronous=FULL`), so boards, grants, invites and links
survive a restart. `setGrant` refuses to remove or downgrade a board's last owner, **atomically** (two concurrent
callers on two handles can't both pass). Timestamps come from an injectable `now()` passed in from JS, never SQL's
clock. It must pass platform's `registryContract(name, makeRegistry)`.

Done when: every method implemented and tested; last-owner atomicity across two handles; close/reopen durability;
the contract passes; `bun test` passes; temp dirs only.

## Hunt for

- Last-owner race: two handles/processes demoting different owners of a two-owner board at once; also
  `setGrant(null)` vs downgrade; a board with zero owners after any interleaving.
- SQL injection or id handling (ids `[a-z0-9-]`), cross-tenant leakage (a board/invite/link of tenant A reachable
  via tenant B's calls), revoked/expired invites and links still honoured.
- Semantics drift from memoryRegistry that tenancy.js or server/admin rely on.
- Durability: data present after close/reopen; WAL + FULL actually set.

## The builder's not-verified list and risks (check these)

- Power-loss durability not crash-tested (only close/reopen); tests run with `fullfsync: false`.
- `SQLITE_BUSY` past the 5 s busy timeout throws (gateway answers `unavailable`).
- Postgres will need `SELECT … FOR UPDATE` or SERIALIZABLE in setGrant; SQLite relies on its database-wide write lock.
- Small differences from memoryRegistry not covered by the contract: createTenant dedupes admins; missing `by`
  stored as null; non-string user via String(); NOT NULL on invite email and invite/link role.
- Roles stored as given (tenancy.js caps on read).

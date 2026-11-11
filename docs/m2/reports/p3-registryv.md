# Report: p3-registryv (verify the durable SQLite Registry)

**Verdict: PASS.** No HIGH or MEDIUM findings. Four LOW findings, none reachable through server/admin or
server/auth/tenancy.js today.

Job files reviewed: server/registry/sqlite.js, test/server/registry.test.js (against server/auth/registry.js,
test/auth/registry-contract.js, PROTOCOL.md § Tenancy / § Registry, server/auth/tenancy.js, server/admin/boards.js).
I did not read the builder's report.

## How I checked it

- **`bun test` (repo):** 245 pass, 0 fail (17 files). test/server/registry.test.js alone: 23 pass (the platform
  contract, plus the drift, reopen, two-handle and two-process race tests).
- **Scratch tests** (outside the repo, `mktemp -d`; not committed), 6 pass:
  - **Process crash:** a child process resolves 200 `setGrant`s with default pragmas, then gets SIGKILL. On reopen
    all 200 grants are there, and pragmas read back as WAL, synchronous=2 (FULL), fullfsync=1.
  - **Three-process race:** three processes run 400 mixed `setGrant`s each (owner / editor / viewer / null) on three
    users of one board. Meanwhile a fourth handle polls the owner count. The count never dropped below 1, the only
    errors were `last-owner` (163 refusals in total), and no `SQLITE_BUSY` came back with a 30 s timeout.
  - **Differential fuzz:** 30 seeds × 120 random ops (setGrant including null, createLink, addLinkUse,
    createInvite with mixed-case email, revokeInvite) on memoryRegistry and on sqliteRegistry. The output was
    identical after scrubbing ids: grants order, linkUses order, invitesFor, revoke results, and error codes.
  - **Injection:** quote/comment payloads in domain, title, user and id are stored and matched as data. `%` does not
    act as a wildcard. Every statement is a prepared `?` binding; the only interpolated SQL is the busy-timeout
    integer (`Math.floor`'d) and fixed pragma names.
  - **Isolation:** a link, invite or grant on tenant A's board can't be seen through tenant B's board
    (linkUses, invitesFor, links, grant).
  - **Clock:** every `createdAt` comes from the injected `now()`. The SQL has no `CURRENT_TIMESTAMP` or
    `strftime`.
- **Last-owner atomicity (code read):** the check and the write run in one `BEGIN IMMEDIATE` transaction
  (`setGrantTx.immediate`), so the write lock is held before the owner count is read. This is a real
  cross-process guarantee, not luck of single-threaded JS. The builder's own two-process test (40 rounds) and my
  three-process test exercise it.
- **Revoked or expired invites and links:** the registry stores `revoked` and `expiresAt` faithfully
  (0/1 is mapped to a boolean, and null stays null). Whether to honour one is decided in tenancy.js `live()`,
  which is unchanged and works the same on both adapters.
- **sdd ensemble (single harness):** codex at high effort, run in a scratch copy of the repo so it couldn't edit
  the tree. Verdict PASS, no findings. Codex was the only harness available, so nothing can be "two agree".

## Findings

| # | Sev | Where | Failure scenario | Fix |
|---|-----|-------|------------------|-----|
| 1 | LOW | server/registry/sqlite.js:22 | `SqlRegistryError` sets `name = "RegistryError"` but is not `instanceof` the RegistryError in server/auth/registry.js. Code that checks `instanceof` instead of `.code` would miss it. No caller does that today: boards.js:80 matches `err.code`. | Import and throw `RegistryError` from ../auth/registry.js, and drop the second class. |
| 2 | LOW | sqlite.js:211–222, 239–245 | Writes coerce `user` with `String()`, but reads return null for a non-string. `setGrant(b, 123, "owner")` then `grant(b, 123)` returns null on SQLite but `"owner"` on memory; `grant(b, "123")` is the reverse. Unreachable: boards.js rejects a non-string user. | Either `String()` on reads too, or refuse non-strings on writes. Pick one. |
| 3 | LOW | sqlite.js:58 (`email NOT NULL`) | `createInvite({ email: null })` throws a raw SQLite constraint error, where memory stores `email: null`. Unreachable: boards.js validates the email first. The builder also noted this. | None needed. A clear `registry: bad email` error would be nicer. |
| 4 | LOW | sqlite.js:180 (createTenant) | Duplicate admins are deduped on SQLite but kept on memory. Also, a missing `by` is stored as null rather than undefined. The contract doesn't cover either, and no caller depends on it. | Accept and document, or make memory dedupe too (platform-owned). |

## Not verified

- **Power loss:** not tested. Only close/reopen and SIGKILL were. The repo tests run with `fullfsync: false`; my
  crash test used the default (`fullfsync: true`), but a process kill doesn't exercise fsync.
- **`SQLITE_BUSY` after the 5 s busy timeout:** the error it throws was not observed here (no contention lasted
  that long). How the gateway maps it to `unavailable` is not this job's code.
- **Postgres:** the setGrant equivalent (`FOR UPDATE` or SERIALIZABLE) is phase 4.

## Out of scope (not this job's files; for the manager)

- **server/admin/boards.js:68–78:** the caller's permission check reads `current` before `registry.setGrant`
  runs, outside its atomic step. Scenario: a tenant admin promotes U to owner at the same moment a non-admin
  owner demotes U from editor. The non-admin's check saw "not an owner", so it passes, and its write can then
  demote the brand-new owner. The registry's last-owner rule still holds, so a board never ends with zero owners.
  LOW, a lead only: I did not build a test for it.

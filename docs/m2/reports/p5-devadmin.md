# Report: p5-devadmin (first-admin bootstrap; POST /boards works on a dev node)

Done. Live finding S1 is closed: on a stock single node, a dev token flagged `"admin": true` gets **201** on
`POST /boards`, and a non-admin of the same domain gets **403**. Full `bun test` on main after engine's p-arch
follow-up (3a7520d): **1044 pass, 101 skip, 0 fail**. Both architecture tests pass (27/27). Not committed.

**Decision for t187 (a deviation from brief item 3):** main.js bootstraps only domains that have at least one
`admin: true` token, not every dev token's domain.
- **Why:** engine's `test/server/main.test.js:231` creates the `acme.test` tenant itself after `start()` for a
  non-admin token. A tenant made by main.js would make that call throw ("domain already has a tenant").
- **Effect:** a domain with no admin token has no tenant, so its users get no Workspace `memberRole` and no
  `POST /boards`, exactly as before.
- **If you want every domain bootstrapped:** that one test needs to change, which is engine's file.

**Found, for engine (`server/registry/sqlite.js`, not mine):** when several processes open a brand-new
`registry.db` at the same moment, one sometimes fails in the constructor with "database is locked" (1 of 6 rounds,
6 processes each). Opening an existing file was fine in every round. It is likely the WAL switch or schema setup
racing on first creation (unverified). On a real node the server creates the file first, so the CLI rarely meets it,
and the CLI exits 1 so a re-run succeeds.

## What changed

| File | Change |
|---|---|
| `server/admin/tenants.js` (new, core) | `bootstrapTenant({ registry, domain, admins })`, `normDomain`, `normAdmin`, `BootstrapError` (code `bad-request`). Imports only `server/auth/util.js`. |
| `server/admin/boards.js` | `isTenantAdmin` also matches an `email:<addr>` admin entry (see "How an admin is named"). Header line updated. |
| `scripts/admin-bootstrap.js` (new, composition root) | The operator CLI. Location agreed with t187; engine added it to `COMPOSITION_ROOTS` (3a7520d). It validates the domain and the admin names before it opens any Registry. |
| `server/main.js` | Dev path only: bootstrap each dev domain that has an admin token. Env header documents `admin`. The stale "sign-in is not wired yet" log line (t187's addition) now says what is true: Google only (info), or no sign-in at all (warn: every hello refused). |
| `test/auth/architecture.test.js` | `server/admin/tenants.js` classified `core`. |
| `test/admin/tenants.test.js` (new) | bootstrapTenant on memory, SQLite and Postgres (when `DATABASE_URL` is set); email-admin matching. |
| `test/admin/devadmin.test.js` (new) | `start(env)` end to end (item 4), and the CLI in process. |

## bootstrapTenant

- **Creates if missing:** looks the tenant up by domain and creates it with the admins if absent.
- **Adds, never removes:** then adds each admin the tenant lacks (`addTenantAdmin` is insert-if-absent in all three
  adapters). Nothing is ever removed or demoted; tenant admins have no rank to demote.
- **Refuses bad input before touching the Registry:** an empty or null domain is refused, because null domains are not
  unique, so each run would mint a new tenant. Domains are trimmed and lower-cased.
- **Lost race:** if `createTenant` throws, it re-reads by domain. The adapters throw a plain Error with no code, so it
  does not match on the message. It rethrows only if the tenant is still missing, then adds its own admins anyway (on
  Postgres the losing transaction rolled them back).
- **Returns** `{ tenant, created, added }`.

## How an admin is named (brief item 2)

- **What the Registry supports:** `admins` is a list of opaque strings, and `addTenantAdmin(tenant, user)`
  (PROTOCOL.md § Registry). Before this job, only `admins.includes(caller.user)` counted, so only `google:<sub>` or
  `dev:<name>` could be an admin. Nobody knows their Google `sub` before first sign-in, so that alone does not close
  the production hole.
- **Decision:** an admin may also be named `email:<addr>`. The CLI takes a bare address and stores it as that.
- **Matched at sign-in?** Yes, in `server/admin/boards.js` (the place PROTOCOL.md § Tenancy says checks admins). It
  matches only when all three hold:
  - `Identity.email` equals the address. The IdP sets `email` only when it vouches for it (oidc.js).
  - The caller's Workspace domain (`hd`) is the tenant's domain.
  - The tenant has a domain.
- **Why the domain check:** a guest from another domain who holds that address never becomes admin.
- **Owner grant stays by user id:** the board's owner grant is written to the real `google:<sub>`, not to the email.
- **Not changed:** the `email:` entry is not rewritten to `google:<sub>` at first sign-in. It keeps matching by email.
  That would be a later improvement in `server/auth/http.js`, which I don't own.
- **Ask for PROTOCOL.md** (not my file): § Tenancy or § Registry could say that a tenant admin entry is a user id or
  `email:<addr>`, matched as above.

## The CLI

```
bun scripts/admin-bootstrap.js --domain acme.com --admin alice@acme.com [--admin google:<sub>] [--admin dev:ann] [--data-dir DIR]
```

- **Which Registry:** `DATABASE_URL` set means Postgres, schema `public` (the adapter's default; no cluster root wires
  `postgresRegistry` yet, so the schema must match whatever that root picks). Otherwise SQLite at
  `<--data-dir | PLENARY_DATA_DIR | ./data>/registry.db`, as main.js does.
- **Output:** one JSON line, `{ ok, registry, tenant, domain, created, added, admins }`.
- **Exit codes:** 0 on success, 2 on bad arguments (with usage), 1 on any other error.
- **No secrets printed:** no env value is printed, and a `postgres://…` URL inside a driver error is masked.
- **Testable entry:** `run(argv, env, io)` reads only its arguments, like `start(env)`.

## main.js (dev path)

- **What it does:** for each dev token with a `domain` and `admin === true` (strict), it groups by lower-cased domain
  and calls `bootstrapTenant` with those `dev:<name>` users. This runs before the server is created.
- **Domains with no admin token get no tenant.** That is deliberate. `test/server/main.test.js:231` (engine's) creates
  the `acme.test` tenant itself after `start()` for a non-admin token, and a tenant made here would break it.
- **Bad domain:** logged as an error and skipped. A Registry error fails the start, as the dev board does.
- **Additive:** dropping `admin` later removes nobody.

## Tests added

- **`test/admin/tenants.test.js`:** each case runs per adapter (memory, SQLite, and Postgres when `DATABASE_URL` is
  set). It covers:
  - create; re-run is a no-op; a new admin is added; nobody is removed;
  - a tenant made elsewhere is reused;
  - three concurrent runs with different admins end with one tenant holding the union and exactly one `created`;
  - bad domains and admin names are refused before any write.
  - Email matching: a vouched email in the tenant's domain creates a board and owns it by user id. No email, another
    domain, no domain, or a different email gets `forbidden`. An `email:` string as a user id never matches.
- **`test/admin/devadmin.test.js`:**
  - **Item 4:** `start(env)` on port 0 with a temp dir. Admin gets 201, non-admin 403. Restarting on the same dir with
    the flags swapped keeps the same tenant, now with both admins, and both get 201.
  - **No admin token:** no tenant, 403. A bad domain is skipped and the start goes on.
  - **CLI:** creates on SQLite, re-run is a no-op, `--data-dir` wins, bad arguments exit 2, an unreachable Postgres
    exits 1 without printing the password.

## How I checked it

- **Full suite:** `bun test` gives 1044 pass, 0 fail (baseline before my change: 995 pass, 0 fail; other sessions
  also changed the tree meanwhile).
  - One earlier full run failed only engine's hexagonal test in `test/architecture.test.js`. I didn't capture its
    diff. It was presumably `scripts/admin-bootstrap.js` wiring adapters before engine's `COMPOSITION_ROOTS` line
    landed. On main with 3a7520d both architecture tests pass.
- **Postgres** (temporary local Postgres 17, `DATABASE_URL` set only for these runs; server stopped afterwards):
  - `test/admin` + `test/server/pg-registry.test.js`: 52 pass, three runs in a row. `test/admin` alone gives 24
    tests, so the Postgres leg ran.
  - **Real cross-process race:** four CLI processes started at once for one domain, each with a different admin.
    Three rounds, every round: one tenant, exactly one `created: true`, all four exit 0, and all four admins present.
  - The CLI against Postgres: create, then a re-run that is a no-op.
  - **Least privilege** (a role that doesn't own the schema) is covered by the adapter's own test
    (`pg-registry.test.js:193`), which ran in those passes. The CLI uses that same adapter, but I did not run the CLI
    itself as a non-owner role.
- **SQLite cross-process race:** the same race with six CLI processes on one temp `--data-dir`, three rounds.
  - Rounds 2 and 3: one tenant, one `created`, all exit 0.
  - Round 1, a fresh file: one process failed to open (the engine adapter issue at the top), so that one admin was
    missing until a re-run.
  - Re-run with six in-process opens and bootstraps: 5 of 6 rounds clean. Every failure was at open, never in
    bootstrapTenant.

## Systems design (APPLIER, short)

- **Scope:** about one tenant row per Workspace domain, written rarely (at start or by an operator) and read on every
  admin call. Correctness, not throughput, is the point: one tenant per domain, and admins only ever accumulate.
- **Design:** read, then create, then add-missing. The single point of truth is the Registry's uniqueness on `domain`:
  - a unique key on Postgres;
  - a `BEGIN IMMEDIATE` transaction on SQLite, where every node of a single-node deployment shares one file.
- **Two nodes starting at once (cluster):**
  - Both may read "no tenant". Exactly one `createTenant` commits; the other fails on the unique key, re-reads, and
    finds the winner's tenant.
  - Both then add their admins with insert-if-absent, so the end state is the union, whatever the interleaving.
  - There is no lock to hold, no leader, and nothing to clean up on a crash. A node dying between create and
    add-admins leaves a tenant with fewer admins, and the next start (or a CLI run) adds them.
  - Verified on Postgres with four processes (above).
- **Why the CLI is safe to re-run:** every step is a convergent, monotone write.
  - "Tenant for domain D exists" and "admin A is in D's admins" are both set-if-absent. Running it N times has the
    same effect as once, and running it during live traffic only adds rights.
  - It never removes or demotes. Taking an admin away is a separate, deliberate operation (none exists yet).
- **Failure modes left:**
  - Admin removal and listing are not built.
  - A typo'd email silently names nobody (it simply never matches).
  - On Postgres the CLI must use the same schema as the servers.
- **Skill, honestly:** BRIEF-BASE asks for the `distributed-systems-design` APPLIER pass before coding.
  - I invoked the skill before coding, but its file path didn't resolve. I wrote the design above myself while
    coding (scope, design, deep dive on the race, wrap-up).
  - I read the skill file (systems-design v0.1.0, found at `~/repos/systems-design.skill`) only after the code and
    tests, and only its routing table and 4-step framework.

## Not verified

- **Real Google sign-in with an email-named admin:** not tested live. Only covered by unit tests on the Identity
  shape that oidc.js produces.
- **The CLI as a spawned child against SQLite:** tested in process only. On Postgres it ran as real processes.

## Risks

- **`email:` admin entries are a new convention** for a field PROTOCOL.md describes only as `admins`. The ask above is
  to document it.
- **An `email:` entry is never pinned to a Google `sub`:** if the Workspace later gives that address to someone else,
  that person inherits tenant admin. Rewriting the entry to `google:<sub>` at first sign-in (in http.js) would fix it.
- **Secondary domains:** a Workspace user whose email is on a secondary domain gets no vouched email from oidc.js
  (`hd` differs from the email's domain), so they can't be named by email. Name them by `google:<sub>` after their
  first sign-in.
- **Noisy test log:** `devadmin.test.js` prints one expected `"dev token domain skipped"` error line during
  `bun test` (LOG_LEVEL=error still shows errors).

# Report: p5-devadmin2 (tenant-admin hardening: the p5-devadminv LOWs)

**Done. Fixes 1-4 are in. Each has a test that fails under its mutation, on memory, SQLite and Postgres 17.11
(Podman).** Full `bun test`: 1287 pass, 1 fail. The one failure is the known `test/core-source.test.js`. Nothing
committed.

Design check: I did not load or apply the `distributed-systems-design` skill. I judged this job not design-bearing:
it adds no state, messages or nodes, only input validation and an authorization predicate over the existing
Registry port. The concurrency story is unchanged:
`bootstrapTenant`'s create race and additive `addTenantAdmin` are untouched, and validation runs before any
Registry call.

## What changed

| File | Change |
|---|---|
| `scripts/admin-bootstrap.js` | **Fix 1:** `parseArgs` throws `--admin is required (at least one)`, so the CLI exits 2 before opening a store. Re-runs stay additive. **Fix 4:** pre-validation calls `normAdmin(a, normDomain(domain))`, so a bad entry exits 2 before the store opens. Header updated. |
| `server/admin/boards.js` | **Fix 2:** in `isTenantAdmin`, the `email:` path returns false unless `caller.user` starts with `google:`. **Fix 3 guard:** the user-id path skips a caller whose user id starts with `email:`. Both guards are separate lines, so each has its own mutation. `dev:<name>` and `google:<sub>` admins match by user id as before. Doc comment updated. |
| `server/admin/tenants.js` | **Fix 4:** `normAdmin(a, domain?)` refuses an email admin whose domain is not exactly the tenant's. It also refuses any control or format character (`\p{Cc}\p{Cf}`: C0, DEL, C1, zero-width, bidi) in any form (`google:`, `dev:`, email). The error names the entry, JSON-escaped. `bootstrapTenant` passes the normalised domain (`admins.map(a => normAdmin(a, d))`, not `map(normAdmin)`, which would pass the index). Header updated. |
| `test/admin/tenants.test.js` | New per-adapter test (off-domain or control character refused, tenant not created, valid email on the domain accepted). New `normAdmin` unit asserts. New test: a dev token claiming `alice@acme.com` on `acme.com` is forbidden. **Fix 3:** the formerly vacuous test's tenant now holds `email:alice@acme.com` (asserted), plus `dev:ann`. |
| `test/admin/devadmin.test.js` | `["--domain","acme.test"]` and `["--domain=acme.test","--data-dir",dir]` added to the exit-2, touch-nothing cases. New CLI test: an off-domain email and a `\u0007` entry each exit 2, the entry is shown on stderr, and no `registry.db` is created. |

## Fix 3: the vacuous test is now real

Once its tenant held `email:alice@acme.com`, the corrected test **failed against the code as it was**. There was no
guard: `t.admins.includes("email:alice@acme.com")` was true, so the caller became an admin. Fixing the test
therefore needed the user-id guard in `boards.js`. Mutation M3 below removes that guard and shows the failure.

## Mutations (each applied alone, `bun test test/admin`, then restored; scratch script `mut.py`)

| # | Mutation | Result (memory + SQLite) | Postgres run |
|---|---|---|---|
| M1 | Drop the `--admin` required check in `parseArgs` | 1 fail: `CLI: bad arguments exit 2 with usage and touch nothing` | same |
| M2 | Drop `if (!caller.user.startsWith("google:")) return false` | 1 fail: `a dev token claiming the vouched-looking email … never matches an email entry` | same |
| M3 | User-id path back to `t.admins.includes(caller.user)` (no `email:` guard) | 1 fail: `an email entry never matches by user id, and a user-id admin still works` | same |
| M4a | Domain check disabled in `normAdmin` | 4 fail: off-domain test (memory, sqlite), `normDomain / normAdmin`, CLI off-domain test | 5 (adds postgres) |
| M4b | Control-character check disabled | 3 fail: off-domain/control test (memory, sqlite), `normDomain / normAdmin` | 4 (adds postgres) |
| M4c | CLI pre-validation calls `normAdmin(a)` without the domain | 1 fail: CLI test (exit 2 still happens, but only after `registry.db` is created) | same |
| M4d | `bootstrapTenant` calls `normAdmin(a)` without the domain | 2 fail: off-domain test (memory, sqlite) | 3 (adds postgres) |

Scratch script: `/private/tmp/claude-501/-Users-r-repos-plenary/9940cf7d-a06d-44a7-b732-08ad6bdb2263/scratchpad/mut.py`.
After the runs, no `.mutbak` files were left, `git diff --stat` on the owned files matched the pre-mutation state, and `bun test test/admin` gave
23 pass, 0 fail.

Under M4b the CLI's `\u0007` case still exits 2, because the domain check catches it first: the domain reads as
`acme.com\u0007`. The control-character guard is pinned by the core tests, whose cases include `google:` and `dev:`
entries that no domain check would catch.

## Postgres

- **Container:** Podman `docker.io/library/postgres:17` (PostgreSQL 17.11), id
  `3ab5f70d80d8359e43f8c928c51ef509cee4e5fad11b597d64156e532741a017`, trust auth, host port picked by Podman
  (127.0.0.1:46071). Removed afterwards with `podman rm -f <that id>`; no other container was touched.
- **Results:** `DATABASE_URL=… bun test test/admin` gave 29 pass, 0 fail (23 plus 6 Postgres adapter tests). The
  mutation table above was re-run with Postgres too.
- **Environment:** no `.env` in the repo sets `DATABASE_URL`, so the plain runs used memory and SQLite only.

## Full suite

Final `bun test`: 1287 pass, 1 fail. The failure is `packages/core is still herdr-draw's core`, which is known,
unrelated and was in the baseline before my edits (1274 pass, 1 fail).

- **An earlier full run** had 2 more failures, in `test/auth/signin-cause.test.js`: "an IdP adapter that refuses
  without a cause logs idp_refused…" and "a throwing logger changes no answer…".
- **They were transient:** on re-run, that file alone gave 8 pass, 0 fail, and the full suite was clean apart from
  core-source.
- **Whose file it is:** it is untracked and new since this session started, from the parallel p5-google2 session,
  which is editing `server/auth/http.js` and `oidc.js`.
- **Imports:** it does not import admin code directly. It reaches `server/admin/boards.js` only through
  `server/auth/http.js:72`, and those two tests are about IdP-refusal logging, not `isTenantAdmin`.

`test/auth/google-live-server.test.js` (also p5-google2's) bootstraps `admins: ["admin@live-check.example"]` for
domain `live-check.example`. That is on the tenant's domain and signs in through Google, so it is compatible with
fixes 2 and 4. It passes (1 pass).

`scripts/dev-google.js` shows a diff I did not make (p5-google2's). I left it alone.

## Docs

- **`server/main.js` header (lines 7-12):** checked, not stale. The dev path bootstraps `dev:<name>` only, which
  still matches by user id. Line 7 lists an optional `email` on dev tokens. One sentence would make the new rule
  explicit; the owner of `main.js` can add it if wanted:
  - **Today:** `//   PLENARY_DEV_TOKENS   JSON: { "<token>": { "name": "ann", "role": "editor", "email"?, "domain"?, "admin"? } }.`
  - **Suggested addition after line 12:** `//                        A dev token's "email" never matches an email:<addr> tenant admin (only a Google sign-in does).`
- **`deploy/README.md`:** has no admin-bootstrap or email-admin lines; nothing stale.
- **`PROTOCOL.md`:** says nothing about `email:` admin entries; nothing stale.

## Not done (M6 notes only, per brief item 5)

- **Pin `email:` to `google:<sub>` on first match.** On the first Google sign-in that matches `email:alice@acme.com`,
  replace the entry with `google:<sub>`. That closes the recycled-address case: a new person given the same
  Workspace address later inherits admin today. It needs a Registry op to replace an admin, done atomically.
- **Audit of bootstraps.** The CLI and dev-path bootstraps leave only a log line (the dev path) or stdout (the CLI).
  M6 audit should record who added which admin, and when.
- **Admin removal and listing.** There is no way to remove or list tenant admins other than reading the Registry
  directly.

## Not verified / risks

- **Existing bad entries:** tenants created before this change may already hold off-domain or control-character
  entries. They are not cleaned up. They are harmless: an off-domain `email:` entry still never matches, because
  `caller.domain === t.domain` plus Google's `hd` rule prevents it.
- **Dev-token email admins:** callers who relied on a dev token with an `email` matching an `email:` admin entry
  lose admin. That was the point of fix 2. The fix is to flag the token `"admin": true` (making it `dev:<name>`), or
  add `--admin dev:<name>`.
- **Format characters:** `\p{Cf}` refuses zero-width and bidi characters as well as `\p{Cc}`. This is a little
  wider than "control characters", on purpose. No legitimate Google `sub`, dev name or Workspace email contains
  them.
- **Whitespace with control characters:** the control-character check runs on the untrimmed input. An entry with a
  leading or trailing tab or newline (e.g. `"alice@acme.com\n"`) is now refused, where it used to be trimmed and
  accepted. This matches the brief's "any"; a plain leading or trailing space is still trimmed.
- **Live server:** I did not run the real Google sign-in against a live server; that is p5-google2's job.

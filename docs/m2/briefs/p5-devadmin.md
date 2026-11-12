# Brief: p5-devadmin (first-admin bootstrap; POST /boards works on a dev node)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy. Never pkill/killall; servers on port 0 from a command that records the PID; kill only those PIDs. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-devadmin.md.

## Goal

Live finding S1 (docs/m2/reports/pd-drawh-live.md "Server-side gap"): on a stock single node with dev tokens, every
`POST /boards` gets 403: tenancy needs a tenant whose domain is the caller's with the caller as admin, and main.js
makes only a domain-less dev tenant with no admins. Production has the same hole: the first Google Workspace tenant
has no admin either. Agreed with engine (t18m):

1. **`bootstrapTenant({ registry, domain, admins })`** in server/admin/ (core over the Registry port, idempotent:
   creates the tenant if missing, adds the admins if missing, never removes anyone, never demotes; safe to run twice
   and concurrently on two nodes). Tests run against the Registry contract's adapters (memory; SQLite; Postgres when
   DATABASE_URL is set, as the existing contract tests do).
2. **A CLI**, e.g. `bun server/admin/bootstrap.js --domain acme.com --admin google:<sub>|<email>` (decide how an admin
   is named before their first sign-in: by email is the realistic case; say what the Registry supports and whether
   an email-named admin is matched at sign-in), reading DATABASE_URL or the SQLite data dir like main.js does. It is
   a composition root: it may import adapters. Print what it did; exit non-zero on error.
3. **main.js, dev path only** (engine allows exactly this): when dev tokens are enabled, for each dev token with a
   `domain`, call bootstrapTenant with the users of that domain flagged `admin: true` in PLENARY_DEV_TOKENS. A few
   lines; nothing else in main.js. Update main.js's env header comment for the new flag.
4. **Test:** a stock single node (main.js's start(env), port 0, temp data dir) with an admin dev token can
   `POST /boards` (201) and a non-admin of that domain gets 403.
5. Systems design (APPLIER, short): the bootstrap's behaviour under two nodes starting at once (cluster), and why the
   CLI is safe to re-run.

## Files you own

server/admin/, test/admin/ (new) or test/auth/, and the dev-path lines in server/main.js (plus its env header).
Update test/auth/architecture.test.js's classification table for any new file in server/admin/ (the CLI = root).

## Done when

The above, full `bun test` passes, architecture tests pass, report. Then stop. Do not commit.

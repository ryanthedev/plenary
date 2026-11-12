# Brief: p5-devadmin2 (tenant-admin hardening: the p5-devadminv LOWs)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-devadmin2.md. Report
only to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never
pkill/killall; ports from port 0. Do not commit. Stop at 60% context after writing what you have. Name failing tests
with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

p5-devadmin (7a44278) passed verification with LOWs only (docs/m2/reports/p5-devadminv.md, table at the top). Close
the cheap ones now, before Google sign-in is used against the real server (p5-google2, running in parallel).

## Do

1. **`--admin` required:** scripts/admin-bootstrap.js exits 2 with a clear message when no `--admin` is given (today
   `--domain acme.test` alone makes a tenant with no admins). Re-runs stay additive.
2. **`email:` entries match only IdP-vouched callers:** in server/admin/boards.js (`isTenantAdmin`), an `email:` admin
   entry matches only when `caller.user` starts with `google:` (dev tokens with an email no longer match). Keep
   `dev:<name>` admin entries working as main.js bootstraps them.
3. **Fix the vacuous test** (test/admin/tenants.test.js:126, "email: string as a user id never matches"): give its
   tenant a real `email:` entry so it fails if the guard is removed. Show the mutation.
4. **`normAdmin` (server/admin/tenants.js:42):** reject email admins whose domain differs from the tenant's
   `--domain`, and any control characters; the CLI reports the bad entry and exits 2.
5. **Not now (write in your report as M6 notes only):** pinning `email:` to `google:<sub>` on first match, audit of
   bootstraps, admin removal/listing.

Each fix gets a test that fails under its mutation; list the mutations and results in your report. Run the
Postgres path too if test/admin has one (Podman Postgres; record the container id and remove only that).

## Files you own

scripts/admin-bootstrap.js, server/admin/*, test/admin/*, docs/m2/reports/p5-devadmin2.md. **Not** server/main.js,
server/auth/*, server/registry/* or deploy/ (engine's pending patch and p5-google2). If a doc line (deploy/README.md,
main.js header) goes stale, quote it and the new wording in your report.

## Done when

Fixes 1-4 in, each with a mutation-checked test; full `bun test` passes (known unrelated: test/core-source.test.js).
Then stop and leave the session idle.

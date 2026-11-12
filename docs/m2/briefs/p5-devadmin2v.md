# Brief: p5-devadmin2v (verify p5-devadmin2: tenant-admin hardening)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values or tokens. No pkill/killall. Containers you
start are recorded (Podman id) and only those removed. Do not edit code; do not commit. Scratch copies in your
scratchpad. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Stop at 60% context after writing what you have.

## Job under check

Builder t1hn ran p5-devadmin2 (brief docs/m2/briefs/p5-devadmin2.md; report docs/m2/reports/p5-devadmin2.md). Read its
claims as claims. Its files (uncommitted): scripts/admin-bootstrap.js, server/admin/boards.js, server/admin/tenants.js,
test/admin/devadmin.test.js, test/admin/tenants.test.js. Diff them against HEAD. scripts/dev-google.js belongs to
another job (p5-google2, running now); other sessions' uncommitted edits in the tree are not this job.

## Check

- **Fix 1:** `--admin` required; CLI exits 2 before opening a store (no data dir or DB file created).
- **Fix 2:** `email:` admin entries match only callers whose user starts with `google:` (vouched email, same hd). Try
  to get admin with a dev token, a share-link/invite identity, an `email:`-prefixed user id, case and Unicode tricks
  (uppercase, IDN/punycode, trailing dot, fullwidth @), and a Google identity from another hd.
- **Fix 3:** the formerly vacuous test now really exercises an email admin (fails if the email path is removed).
- **Fix 4:** off-domain and control/format-character admin entries refused in both the CLI and `bootstrapTenant`;
  nothing is created on refusal; error output escapes the entry (no raw control bytes to the terminal).
- **No regression:** `dev:` and `google:<sub>` admins still match; bootstrap still idempotent and additive.
- **Mutations:** redo the builder's mutation table yourself; add any it missed.
- **Gates:** `bun test test/admin test/auth`, full `bun test` without DATABASE_URL and with it (Podman Postgres).
  Known unrelated: test/core-source.test.js. Check any other failure against a clean HEAD worktree plus these files.

## Done when

docs/m2/reports/p5-devadmin2v.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs
(minus secrets), each claim confirmed or refuted. Then stop.

# Report: p5-devadminv (verification of p5-devadmin: tenant bootstrap, operator CLI, dev-token admins, email admins)

**PASS: no HIGH; I rate every finding LOW (codex rated one, dev tokens claiming an email, MEDIUM; see below). Postgres path not verified by me.** No way to become a tenant admin one shouldn't be was found, by me or by the two
cross-model reviewers, through the real Google verifier path. Bootstrap is idempotent, additive and converges under
cross-process races on SQLite. The CLI validates before opening anything and prints no secret. Changed nothing in the
tree except this report (a stray `.scratch-verify` dir I created by mistake was removed at once; `git status` confirms it gone). **Postgres not verified by me** (starting a temp cluster was refused by the permission
system); I rely on the builder's Postgres evidence there.

## Findings

| Sev | Where | Finding |
|---|---|---|
| LOW | `scripts/admin-bootstrap.js:44` | `--admin` is shown as required in USAGE but not enforced: `--domain acme.test` alone exits 0 and creates a tenant with `"admins":[]`. Nobody can create boards there until a re-run adds one (re-run works: additive). Reproduced. Found by codex. Fix: require at least one `--admin` (exit 2). |
| LOW | `server/admin/boards.js:45` with `server/auth/dev.js` | A dev token configured with `email: alice@acme.com, domain: acme.com` matches an `email:alice@acme.com` admin entry, since dev identities are not IdP-vouched. Reproduced. Codex rated this MEDIUM; I keep LOW because dev tokens exist only when the operator sets `PLENARY_DEV_TOKENS` (`enabled === true`), the operator writes those fields, and the same operator can already make that token admin directly (`admin: true`). Worth a one-line fix anyway: match `email:` entries only when `caller.user` starts with `google:`. |
| LOW | `server/admin/boards.js` (`isTenantAdmin`, user-id path) | A caller whose user id is literally `email:alice@acme.com` would match via `t.admins.includes(caller.user)`. No verifier produces such an id (only `google:`/`dev:`; sessions are signed; dev names can't contain `:`), so defense in depth only. The builder's test for it (`test/admin/tenants.test.js:126`, "email: string as a user id never matches") is vacuous: its tenant has no `email:` entry, so it passes either way. |
| LOW | `server/admin/tenants.js:42` (`normAdmin`) | Accepts an admin email on a domain other than the tenant's (`bob@evil.com` for `acme.com`), which can never match anyone, and accepts control characters (`x@y\0`). Harmless but silently useless; reject email admins whose domain differs from `--domain`. |
| LOW (design) | `email:` entries | Not pinned to a `sub`: if the Workspace recycles `alice@acme.com` to a new person, they inherit admin. Builder already noted it. Pinning on first match (replace `email:` with `google:<sub>`) would close it. |
| LOW (gap, M6) | bootstrap | No audit trail of bootstraps, and no admin removal/listing. Out of scope; for M6. |

## Reviewer findings refuted

Grok (second reviewer) reported five MEDIUM/LOW items I checked and refuted, plus one inaccurate one:

- **Plus-address stripping:** `normAdmin` does not strip `+tag`; it only trims and lower-cases. End to end,
  `alice+x@acme.com` is refused for an `email:alice@acme.com` admin.
- **Secondary/alias domain maps to primary:** `normDomain` only lower-cases/trims; an `hd` of a secondary domain is a
  different string and is refused (tested end to end).
- **Concurrent bootstrap fails on the UNIQUE domain:** `bootstrapTenant` catches the create error, re-reads by domain,
  and rethrows only if the tenant is still missing. 12 processes × 8 fresh rounds: all exit 0, 1 tenant, 12 admins.
- **CLI opens the store before validating:** `run()` calls `parseArgs`, `normDomain`, `normAdmin` before any store
  is opened; bad args exit 2 and the data dir is not created.
- **`hd` not enforced:** `authoritativeEmail` in server/auth/oidc.js requires `hd` equal to the email's domain (or an
  `@gmail.com` address); the attack table's mismatched-`hd` and other-`hd` rows are refused end to end.
- **Inaccurate, "main.js bootstraps `email:` admins from dev tokens":** main.js bootstraps `dev:<name>` only. The real
  dev-token concern is codex's email-claim finding above.

## Security: attempts to become an admin (end to end)

Through the real `verifyIdToken` (fake IdP keys), session issue, `auth.verify`, then `createBoard`, with tenant
`acme.com` holding `email:alice@acme.com`:

| Attempt | Result |
|---|---|
| `email_verified` false / the string `"true"` | forbidden |
| Consumer account, no `hd` | forbidden |
| Another Workspace's `hd`; a secondary domain `hd` | forbidden |
| `hd: acme.com` but email on another domain | forbidden (oidc.js refuses: `hd` must equal the email's domain) |
| `alice@gmail.com` (same local part) | forbidden |
| Plus-address, Unicode `ⅿ`, fullwidth `ａ`, trailing-dot domain | forbidden |
| Kelvin sign `K` (U+212A) in place of `k` | **matches** (`toLowerCase` folds it to `k`); needs Google to vouch such an address in the tenant's own Workspace, so LOW at most |
| Uppercase email and `hd`, trailing space | allowed (same person; correct) |
| Vouched `alice@acme.com`, `hd: acme.com` | 201; owner grant goes to `google:<sub>` |

Matches oidc.js's authoritative-email rule (`email_verified === true`, and `hd` equal to the email's domain or an
`@gmail.com` address); `isTenantAdmin` additionally requires `caller.domain === tenant.domain`.

## Brief checks

- **Idempotent, never demotes/removes, concurrent bootstraps converge (SQLite, multi-process):** race.sh, 6 CLI
  processes × 5 rounds on fresh and on existing files; race2.sh, 12 × 8 fresh rounds, run before and after engine's
  sqlite.js changes. Every round: all exit 0, `created` once, 1 tenant, all admins present. The builder's "database
  is locked" on simultaneous open did not reproduce for me; engine has since added a busy retry in sqlite.js
  (not this job).
- **Postgres:** not run by me (permission refused). No `DATABASE_URL` was set, so the Postgres variants in
  test/admin/tenants.test.js and test/server/pg-registry.test.js were among the 101 skips. Code: `domain UNIQUE`, `ON CONFLICT DO NOTHING` on admins,
  createTenant in a transaction, same re-read path. Builder reports it tested on real Postgres.
- **CLI:** bad args (missing `--domain`, missing value, unknown flag, bad domain, `dev:a b`, `email:`,
  `--admin=--x`) all exit 2 as real child processes, data dir not created. Unreachable Postgres URL with a password:
  exit 1, `{"ok":false,"error":"failed: Failed to connect"}`, password not printed. Success prints one JSON line.
- **Stock single node (dev tokens):** ann (admin, domain written `Acme.Test`) 201; bob (non-admin) 403; `admin:"true"`
  (string) 403; unknown token 401; zed, admin of `zzz.test`, 201 in its own tenant; ann posting into zed's tenant is
  refused (400).
- **Production (dev tokens off):** with Google configured, no tenant is created and the log says "dev tokens are off:
  sign-in is Google only"; bare start creates nothing and warns that every hello will be refused.
- **Tests:** `test/admin` + both architecture tests: 53 pass, 0 fail. Full `bun test`: 1045 pass, 101 skip, 1 fail.
  The fail is `test/server/sqlite-registry-open.test.js` ("open while another process holds the new file's write
  lock"), engine's in-flight file: `server/registry/sqlite.js` was rewritten at 07:28 during my run. Re-run alone 3×
  afterwards: 2 pass, 0 fail each time. Not this job. An earlier full run (before engine's change) was 1044 pass,
  0 fail.

## Architecture

Hexagonal holds: tenants.js and boards.js use only the Registry port; only server/main.js (a composition root) and the
CLI (scripts/, its own root) wire adapters. Both architecture tests pass. All three main.js hunks (env doc comment,
import, dev-tenant bootstrap plus the sign-in log lines) are this job's; no foreign hunks.

## Distributed-systems check (systems-design CHECKER, applied)

The design holds. The linearization point is the `domain` UNIQUE constraint in both databases; admin adds are
insert-if-absent, so concurrent runs converge on the union. A lost commit acknowledgement is covered by the re-read.
A crash between create and add leaves fewer admins, fixed by re-running. Infra checklist items (LB, cache, CDN,
sharding) don't apply to a rare control-plane write. Gaps: audit trail and admin removal (M6).

## Ensemble review

- **Ran:** codex (effort high) and grok, read-only, in a copy of the repo without `.env` or `.git`. Both: no HIGH.
- **Agreement:** none on a real defect. Codex's dev-token email claim (MEDIUM) is kept as LOW above; grok's nearest
  item (main.js `email:` bootstrap) was inaccurate.
- **Unavailable:** agy (quota exhausted, ~59 h to reset), kimi (no model/login), mistral (no API key), qwen (not
  installed). The first dispatches were lost in the 03:44 kill and the second in the later restart; re-run on the
  current files.

## Noise (not this job)

- `server/main.js`'s "sign-in" log line shows `"devTokens":"[redacted]"`: the logger redacts the key name, though
  the value is a boolean.
- `server/registry/sqlite.js` and `test/server/sqlite-registry-open.test.js`: engine's in-flight work.

No PIDs to clean up: every server ran in-process and stopped itself; Postgres never started.

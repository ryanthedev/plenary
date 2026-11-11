# Brief: p5-fix (auth port errors, authoritative email, last-owner in the Registry)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p5-fix.md.
Never pkill/killall; port 0; kill only PIDs you recorded.

## Goal

Three fixes from the engine track (via the proxy), matching rules already decided. p5-auth is committed (91fb274);
read docs/m2/reports/p5-auth.md and p5-authv.md for context.

## Files you own

`server/auth/`, `server/admin/`, `test/auth/`. Nothing else (not PROTOCOL.md: engine is updating it in p1-seam).

## Fixes (each with a test that fails before and passes after)

1. **Outage is not refusal** (`server/auth/port.js:22,29`). `verify` and `role` catch every throw and return null,
   so a Registry outage answers `auth`. New rule: `null` means refused; infrastructure errors propagate so the
   gateway answers `unavailable`. Keep refusing (null) on bad input: malformed or forged tokens, bad signatures,
   unknown board, no role. Separate the two cleanly (e.g. verifiers return null for "not mine / invalid" and only
   genuine failures like a Registry throw escape). Update the port comment.
2. **Authoritative email** (`server/auth/oidc.js` `authoritativeEmail`). Today any `hd` that is set makes the email
   authoritative. Rule: email ends `@gmail.com`, or `email_verified` AND `hd` equals the email's domain
   (case-insensitive, after trim). Test: `x@other.com` with `hd: acme.com` gives no email. Note in the report that
   a Workspace user whose address is on a secondary domain of their Workspace (email domain ≠ `hd`) now can't
   claim an invite by email; they still get the member role via `hd` and can use a share link.
3. **Last owner in the Registry.** The admin `setGrant` (server/admin/boards.js) already enforces "only tenant
   admins grant owner" and "last owner stays", with a test (tenancy.test.js "M6"). Keep that. Add the last-owner
   rule to the Registry contract itself so a SQL backing can do it atomically in one transaction: `registry.setGrant`
   refuses (throws a typed `last-owner` error) to remove or demote a board's last owner, checked and written in one
   step. The admin layer keeps the caller rules (the Registry doesn't know callers). Tests: direct
   `registry.setGrant` on the last owner refuses; two concurrent admin `setGrant` demotions of the only two owners
   leave at least one owner (this was p5-authv re-check R1). Method names stay stable (no new names unless
   unavoidable; if one is added, put it at the top of the report).
4. **Stale header:** registry.js line 2 still says Store has `board(id)`; it's `Registry.board` now (PROTOCOL.md
   v1 § Registry, committed 28fa91d).

## Done when

All four done with tests, full `bun test` passes, report lists files, tests, what you did NOT verify, risks. Then
stop. Do not commit.

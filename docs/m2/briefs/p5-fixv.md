# Brief: p5-fixv (verify p5-fix: auth port errors, authoritative email, last-owner in the Registry)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p5-fixv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; port 0; kill
only PIDs you recorded.

## Goal and done-when (docs/m2/briefs/p5-fix.md: read it)

1. Auth port: `null` = refused; infrastructure errors (e.g. a Registry throw) propagate so the gateway answers
   `unavailable`; bad tokens, unknown board, no role still give null.
2. Email trusted only if it ends `@gmail.com`, or `email_verified` AND `hd` equals the email's domain.
3. `registry.setGrant` refuses (typed `last-owner`) to remove or demote a board's last owner, atomically; admin
   `setGrant` keeps the caller rules (only tenant admins grant owner).
4. Shared contract test `registryContract(name, makeRegistry)` in test/auth/registry-contract.js, run against the
   memory registry; engine will run it against SQL adapters, so it must test behaviour, not memory internals.
5. registry.js header no longer says Store has `board(id)`.

## The diff

`git diff -- server/auth server/admin test/auth` plus untracked files under test/auth (`git status --short
test/auth`). Compare against committed PROTOCOL.md § Auth, § Registry, § Tenancy.

## Try to break it

- Any input that now throws from `verify`/`role` but should be a refusal (malformed token, forged signature,
  wrong types, unknown board): a throw there turns a bad token into `unavailable` and invites retry storms.
- Any infrastructure failure still swallowed as null.
- Email rule: case, whitespace, subdomains (`x@sub.acme.com` with `hd: acme.com`), IDN, trailing dots.
- Last owner: direct registry call, concurrent demotions/removals (many at once), re-granting, owner demoting self.
- Contract test: does it pass against a deliberately broken registry (mutants)? Does it assume memory-only things?
- **Engine's failing tests:** full `bun test` shows 4 failures in engine's untracked `test/server/` (gateway "bad
  frames", two "H1" nesting tests, "M1/M4 slow sign-in"). Determine whether ANY of them is caused by this job's
  change (especially the error-propagation change: does server/gateway.js or test/server use authPort and expect
  null on throw?). Run them with this job's diff stashed in a scratch copy vs applied. Say plainly which.
- `bun test test/auth` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then review the diff with codex + agy + every other
harness passing `check_adapter`. Two agreeing = HIGH candidate: confirm or refute. List which harnesses ran.

## The builder's not-verified list and risks (only these)

- Outage not driven through server/gateway.js itself, only a stand-in.
- No SQL adapter yet; contract run only against memory and a mutant.
- No live Google token with a secondary-domain account.
- Two dev tokens with the same name (one owner) now throw `last-owner` at server start (server/main.js:52).
- `session.verify` still turns any internal throw into null.
- The contract requires adapters to take an injected `now` for `createdAt`.
- Admin pre-check for last owner is now redundant with the Registry's atomic check.

Grade HIGH: any auth bypass, a refusal turned into a throw (or the reverse for real outages), the last owner
removable, or this job breaking any test. Then stop and leave the session idle.

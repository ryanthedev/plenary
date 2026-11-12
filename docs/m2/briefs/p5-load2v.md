# Brief: p5-load2v (verify p5-load Round 2, tenancy side only)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187;
never prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; record any Podman ids you
start and remove only those. Never print .env values or tokens. If a full run fails, name the failing tests
(`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-load2v.md with PASS or FAIL and findings graded
HIGH/MEDIUM/LOW.

## Job under check

docs/m2/reports/p5-load.md "Round 2" (brief docs/m2/briefs/p5-load2.md, narrowed to steps 1, 2 (GAP-M3), 3, 6, 7).
Uncommitted diff: `git diff server/auth/tenancy.js test/auth/role-cache.test.js`. Round 1 verifier report:
docs/m2/reports/p5-loadv.md (findings 2, 3/GAP-M3, 5, 6). Read the builder's claims as claims, not facts.
Out of scope: the patch re-cut (steps 4-5), gateway gap tests M4/M6/M7, docs/m2/reports/p5-load.patch (stale, known).

## Check

- **Identity keying (finding 2):** `identityKey` matches engine's grouping key exactly
  (`${c.user}\n${c.identity?.email ?? ''}\n${c.identity?.domain ?? ''}`, server/gateway.js around 590, uncommitted,
  engine's); resolveMany/rolesFor (plain and cached) answer per identity; invalidate(board, user) drops every
  identity; the write-through `moved` logic cannot let a stale answer be cached across identities. Try to make one
  identity's answer leak to another (null vs undefined email/domain, empty strings, a user id containing "\n").
- **GAP-M3:** the test fails under the mutation it names; confirm by mutating once yourself.
- **TTLs (finding 6):** recordTtlMs 10 min / linkTtlMs 30 s. Show no path today where a board or tenant record
  changes without a restart (check every Registry port write in server/registry/ and server/admin/); if one exists,
  that is HIGH. Confirm revokeLink drops link records.
- **Finding 5 sentence:** is the proposed PROTOCOL.md sentence true of the code? (Do not edit PROTOCOL.md.)
- **Gates:** full `bun test` in the main tree (the core-source failure from herdr-draw's dirty tree is known; name any
  other). Also with DATABASE_URL against a Podman Postgres if the role cache touches the pg registry path.
- **Design skill:** `distributed-systems-design` CHECKER on the cache's staleness bounds (if not in your skill list,
  read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md).
- **sdd ensemble review** of the tenancy.js diff (codex + agy + any harness passing check_adapter). Two agreeing =
  HIGH candidate; confirm or refute each with a test.

## Done when

Report written. Then stop. Do not commit; do not edit the builder's files. If your context passes 60%, write what
you have and stop.

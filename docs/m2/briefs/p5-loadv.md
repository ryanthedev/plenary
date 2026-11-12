# Brief: p5-loadv (verify p5-load: p-audit F4 and F8)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never
prompt, hc send or SendMessage to the proxy (t1bx) or engine. Change nothing in the tree. Never pkill/killall; servers
and containers you start are recorded and only those stopped (Podman: record the container id, remove it after).
Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report:
docs/m2/reports/p5-loadv.md, PASS or FAIL with findings graded HIGH/MEDIUM/LOW. Stop at 60% context after writing
what you have.

## Job under check

Brief: docs/m2/briefs/p5-load.md. Builder's report: docs/m2/reports/p5-load.md (claims, not facts; read its
not-verified and risks yourself). Two parts:

- **In the tree, uncommitted:** server/auth/tenancy.js (combine, resolve, rolesFor, roleCache), server/auth/registry-port.js
  and server/auth/registry.js (`linkUsesFor`), server/main.js (`announcingRegistry` hunk only: `addLinkUse` announces
  nothing), test/auth/registry-contract.js, test/auth/registry.test.js, new test/auth/role-cache.test.js. Other sessions
  edit nearby files (gateway.js, tune.test.js are engine's p2-tune round 2): judge only this job's hunks; report the
  rest as noise. Known unrelated failures: test/core-source.test.js (herdr-draw's dirty tree) and tune.test.js R2
  (engine's work in progress).
- **For engine to apply:** docs/m2/reports/p5-load.patch (gateway wiring, authPort pass-through, main.js roleCache,
  SQLite/Postgres `linkUsesFor`, rig and tests). Apply it only to a scratch copy (`git worktree` is fine for plenary,
  in your scratchpad; remove it after), never to the main tree.

## The bar

**A revocation is never hidden past the next grants message or timed pass** (a revoked user's op is never acked
after the revoke reached the gateway as the code does today); no wrong close of a healthy connection; F4: a share-link
redemption triggers no whole-board re-check; F8: the query counts in the report hold.

## Check

- **Revocation under the cache, adversarially (on the patched scratch copy):** revoke during an in-flight hello read,
  during a `rolesFor` chunk, between invalidate and the pass, across two gateways sharing a bus, with a `{ board,
  user }` link-use message racing a `{ board }` revoke. Email/domain change, role downgrade (editor to viewer),
  share-link revoke. Mutate the invalidation and single-flight guards once each and confirm a test fails.
- **F4 without the patch (tree as is):** an unpatched gateway plus the tree's main.js: a redemption announces nothing;
  is the user who redeemed still admitted correctly on their next hello? Is any path left where a redemption must
  re-check (e.g. a link that grants a higher role to an already-connected user)? Rate it.
- **Counts:** reproduce the before/after table with your own counting wrapper, memory, SQLite, and Postgres in Podman
  (`linkUsesFor` with `jsonb_array_elements_text`; also a user list with quotes, unicode, 5,000 entries).
- **Patch hygiene:** `git apply --check` on HEAD; does it conflict with the tree's uncommitted gateway.js (engine's
  p2-tune round 2)? Say which hunks, so engine can plan the merge.
- **Gates:** `bun test` in the main tree; full run on the patched scratch copy, with and without DATABASE_URL;
  architecture tests (adapters import only ports).
- **distributed-systems-design** in CHECKER mode on the role cache's staleness and invalidation across gateways (skill,
  or read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md).
- **sdd ensemble review** of the tree hunks plus the patch (codex + agy + any harness passing check_adapter; never give
  them .env). Two agreeing = HIGH candidate; confirm or refute each with a test or a run.

## Done when

Report written (gates, commands and outputs, each claim confirmed or refuted, findings). Then stop. Do not commit.

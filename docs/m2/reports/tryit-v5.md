# Review: tryit round 5 (e940f95, base 8607bac), independent

Worktree `/Users/r/loops/plenary/wt/tryit`, branch `plenary/tryit`. Reviewed `git diff 8607bac..e940f95` (server/auth/http.js,
registry-port.js, registry.js, server/registry/sqlite.js, postgres.js, server/main.js, test/auth/registry-contract.js,
test/server/bad-host.test.js, dev-menu.test.js) against round 4's findings (M-1, L1-L4). Nothing committed. Probes lived in
the scratchpad (`tryv5-69016`). The Try it server (pid 86338, port 8099) was stopped by recorded pid. The rig `tryv5-69016`
was brought down with `--clean`, and my headless Chrome tabs are closed. Two mutants only, as asked; each was restored from a
copy, and `git status` was clean afterwards.

## Executed results

- Focused: `test/server/dev-menu.test.js` + `bad-host.test.js` + `test/auth/registry.test.js` + `test/server/registry.test.js`
  → 68 pass / 0 fail.
- **Real Postgres** (rig, `DATABASE_URL=postgres://postgres@127.0.0.1:52481/plenary`): `test/server/pg-registry.test.js` +
  both registry files → **107 pass / 2 fail**. Both failures are the new contract case
  `tenantAdminsAmong: exactly those of the given users …`, once as the owner and once as the runtime role:
  `PostgresError: cannot extract elements from a scalar` (22023, jsonfuncs.c `elements_worker_jsonb`). See H-1.
- Full `bun test` (repo root, once, rig down): **1632 pass, 157 skip, 0 fail**, 1789 tests across 99 files, 247.0 s, exit 0. The cluster-rig flake (row 15)
  did not show this run. The pg files are among the skips because `DATABASE_URL` is unset, which is why H-1 is invisible
  here.

## Round 4 findings

| # | Round 4 | Now |
|---|---|---|
| M-1 | user count decided in two places; start says ON while requests 404 silently | **Fixed on SQLite / memory.** main.js:351-355 runs the same filter before `devMenuOff`, so `users` is true and an all-admin table logs `… is OFF: no dev token is offerable`. http.js:374-378 warns once per name. Tests at dev-menu.test.js:147-173 and :186-195. **On Postgres the start-up call throws (H-1).** |
| L1 | per-request cost dev users × admin rows | **Fixed on SQLite**: one query, and EXPLAIN QUERY PLAN shows `SEARCH reg_tenant_admins USING COVERING INDEX reg_tenant_admins_member (member=?)`. **On Postgres the query fails (H-1).** |
| L2 | slow Registry → dropped connection | **Fixed.** http.js:84-85, 367-372: a 3 s bound, then 503. Test dev-menu.test.js:197-218 (50 ms bound, 503 in under 1 s). |
| L3 | per-server limiter untested | **Fixed.** bad-host.test.js:46-57. Trace: with the limiter module-global again (server.js:84), the second server's line falls inside the same 1000 ms window and is dropped, so the `length === 1` check for `b` fails. |
| L4 | Registry error logs nothing | **Fixed.** http.js:369-370: one short warn per 10 s, no stack, no token. The test covers the timeout wording; the "failed" wording has no test (Note). |

## Mutants (menu gate, two only)

| Mutant | Result |
|---|---|
| main.js:352 `if (false && offered.size)` (no start-up filter) | **killed**: "a dev name that is a tenant admin … (and the log says so)" |
| http.js:376 drop `menuWarned.add` (warn per request) | **killed**: "a name the Registry removes after start is warned about once per name" |

## Probes

**Per-request cost, re-timed** (SQLite, `GET /auth/dev` through `start()`, median of 5):

| Dev users | Admin rows | Round 4 | Now |
|---|---|---|---|
| 2 | 0 | 0.5 ms | 0.2 ms |
| 2 | 20,000 | 9.0 ms | 0.3 ms |
| 1000 | 0 | 2.5 ms | 0.7 ms |
| 1000 | 20,000 | 1206.7 ms | **0.9 ms** |

**Postgres index and migration.**
- A fresh schema gets `reg_tenant_admins_member`.
- An existing DB: I opened the schema, dropped the index (the state before this commit), inserted 20,000 admin rows, and
  reopened with this commit's code. The index was created. The migration is safe on an existing DB.
- EXPLAIN on 20,000 rows and 1001 names: the shipped `$1::jsonb` form and the corrected `$1::text::jsonb` form both plan
  `Hash Semi Join` over a `Seq Scan on reg_tenant_admins`. The planner does not use the new index for this
  `IN (SELECT jsonb_array_elements_text(...))` shape. With the cast corrected, the query took 2.9 ms (median of 5), so
  that is fine at this size (Note N-1). In the shipped form, the EXPLAIN shows the literal as `'"[\"dev:u0\",…]"'::jsonb`:
  a JSON *string*, which is the H-1 bug.

**README Try it, literally (headless Chrome).**
- The README command word for word, port 8099. The log shows `dev sign-in menu is ON {users:2}`, `dev tokens are ON`,
  `server listening {port:8099}`, 0 error lines, and no token value.
- `curl /auth/dev` → 200 with both users. With `Host: evil.example:8099` → 404.
- `?as=ada`: the canvas loads, the pill reads "Live", the count reads "👁 0 viewers", and the session is `dev:ada`.
- `?as=bo` in a second tab: session `dev-bo`. R plus a drag gives "1 selected", and ada's tab shows the rectangle with a
  dashed remote selection (screenshot).
- `/` in a fresh tab: "Sign in to Plenary / Dev sign-in is on: pick a user. / Continue as ada (owner) / Continue as bo
  (editor)".

## Findings

### HIGH

**H-1. `tenantAdminsAmong` on Postgres throws whenever `reg_tenant_admins` has any row. A cluster node with dev tokens
then refuses to start, and the menu's contract test fails on real Postgres.**
- Where: server/registry/postgres.js:242,
  `… member IN (SELECT jsonb_array_elements_text($1::jsonb))`, `[JSON.stringify(users.filter(key))]`.
- Cause: Bun.sql sends the JSON text so that `$1::jsonb` reads it as a JSON string scalar.
  `SELECT jsonb_typeof($1::jsonb)` with `JSON.stringify(["a"])` → `"string"`, and `$1::text` shows `"[\"a\"]"`. The same
  file already uses the working form at :371 (`$2::text::jsonb`, linkUsesFor).
- Why it hid: on an empty table the hash semi join never evaluates its inner side, so no error comes back. The default
  `bun test` skips pg-registry.test.js (no `DATABASE_URL`), and the builder could not run it.
- Demonstrated:
  1. The contract on real Postgres: 2 fail (above).
  2. A direct probe (`probe-pg.js`, one admin row): every input, including `[]`, `["dev:x"]` and `["dev:root"]`, threw
     `cannot extract elements from a scalar`.
  3. Live, a cluster node (`start()` with DATABASE_URL + NATS_URL + COOKIE_KEY, token `{t-ada: ada}`). With an empty
     admins table it starts and `/auth/dev` → 200. After `scripts/admin-bootstrap.js --domain acme.test --admin
     dev:someone-else` (an unrelated admin), the same start → `START THREW: cannot extract elements from a scalar`.
     main.js:353 awaits the call unguarded. On a node already running when the first admin is added, every
     `/auth/dev` would get 503 instead.
- Fix: `$1::text::jsonb` (or `member = ANY($1::text[])` with an array parameter). Add a case that would have caught it in
  the default suite, or make sure the pg contract runs in CI. The contract case already fails on Postgres once the cast is
  wrong, so it is the right test; it just has to run.

### MEDIUM

None.

### LOW

None blocking.

## Notes (non-blocking)

- **N-1.** The Postgres planner does not use `reg_tenant_admins_member` for the `IN (SELECT jsonb_array_elements_text…)`
  shape: it chooses a seq scan + hash semi join, 2.9 ms at 20k rows with the corrected cast. One scan per request is fine
  for a dev menu. `member = ANY($1::text[])` would likely use the index if this ever matters.
- **N-2.** The "the Registry failed" warn wording (http.js:370, non-timeout branch) has no test. The fail-closed 503 for a
  throwing Registry is tested (dev-menu.test.js:220-226), but not its log line.
- **N-3.** When the bound fires on Postgres, the Registry call keeps its gate slot until Postgres's own 15 s limit. That is
  harmless for a dev menu.

## Verdict

**FAIL** on H-1: the new Postgres query is broken whenever any tenant admin exists, which makes a cluster node with dev
tokens fail to start. Round 4's M-1 and L1 are fixed on SQLite/memory and verified (mutants killed, 1.2 s → 0.9 ms). L2,
L3 and L4 are fixed. The README Try it works end to end in headless Chrome.

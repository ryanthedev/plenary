# Review: tryit round 4 (8607bac, base 530d5a2), independent

Worktree `/Users/r/loops/plenary/wt/tryit`, branch `plenary/tryit`. Reviewed `git diff 530d5a2..8607bac` (server/auth/http.js,
registry-port.js, registry.js, server/registry/sqlite.js, postgres.js, server/main.js, server/server.js, README.md,
test/auth/registry-contract.js, test/server/dev-menu.test.js) against round 3's findings (M1, M2, LOW-1, LOW-2) and the
coordinator's rule. Nothing committed; `git status` is clean. Probes lived in the scratchpad (`tryv4-72451`). Processes I
started were each stopped by recorded pid: the Try it server (pid 6352, port 8099), plus the in-process probe servers.
The rig `tryv4-72451` was brought down with `--clean` after each cycle. My headless Chrome tabs (17-19) are closed.

## Executed results

- `bun test` (repo root, once): **1629 pass, 157 skip, 1 fail**, 1787 tests across 99 files, 299.5 s, exit 1. The one
  failure is `test/deploy/cluster-rig.test.js` "(unnamed)": a hook timed out (7.4 s). The file is not in the diff, and my
  own rig and probes were running at the same time. Run alone twice, it passed once and failed once (14.5 s hook).
  This is TECH-DEBT row 15, which is already OPEN and owned by the rig loop, so I added no new row. It does not block
  tryit.
- Registry contract on **real Postgres** (rig, `DATABASE_URL=postgres://postgres@127.0.0.1:52502/plenary`):
  `test/server/pg-registry.test.js` + `test/auth/registry.test.js` + `test/server/registry.test.js` → 109 pass / 0 fail.
  `-t isTenantAdmin` on the pg file ran 2 tests, 14 expects, 0 fail, so the new contract case runs on Postgres.
- Focused baseline: `test/server/dev-menu.test.js` + both registry files → 64 pass / 0 fail.
- Mutants on the focused files. Each mutant was restored from a copy, and `git status` was clean afterwards.

| Mutant | Result |
|---|---|
| M1 (round 3's): `const host = "127.0.0.1"` (main.js:334) | **killed**: "HOST reaches the gate: HOST=127.1 …" |
| V1 (mine): any `127.*` HOST normalised to 127.0.0.1 | **killed**: same test |
| V2: no `isTenantAdmin` filter (http.js:363) | **killed**: 3 tests (persistent admin, bootstrap after start, fails closed) |
| V3: fail open, `.catch(() => false)` | **killed**: "a Registry that cannot answer publishes nothing" |
| V4: SQLite `WHERE member LIKE ? \|\| '%'` | **killed**: registry contract sqlite isTenantAdmin |
| V5: limiter back to module-global (server.js) | **survives**: test/server + test/auth 495/0 (see L3) |

I ran no further mutants, per the coordinator's later instruction.

## Round 3 findings

| # | Round 3 | Now |
|---|---|---|
| M1 | no integration test that HOST reaches the gate | **Fixed.** dev-menu.test.js:135-145 starts with `HOST=127.1` (binds loopback, not on the list) and asserts 404 for both Host headers and the warn line. Kills the round-3 mutant and my V1. |
| M2 | a name that is a tenant admin in the persistent Registry was offered | **Fixed for offering** (http.js:358-365, port registry-port.js:55, adapters registry.js:45 / sqlite.js:109,216 / postgres.js:239-242, contract registry-contract.js:63-74). Checked per request and fails closed. One rule gap remains: M-1 below. |
| LOW-1 | the no-gateway decision sat outside devMenuOff | **Fixed.** main.js:333-352 computes `off` once; both branches use it. The live host-only node on Postgres logged exactly one menu line: `… is OFF: this node has no gateway role (no dev board on this node)`. `/auth/dev` and `/?as=ada` → 404, and no token appeared in the log. But "offerable" is now decided in two places (start-up count, per-request filter): M-1. |
| LOW-2 | per-process bad-Host limiter | **Fixed in behaviour** (server.js:35, 84). Probe: two servers in one process at debug, one `Host: evil@localhost` each → 400 and 400, one log line per server. No test pins it (V5 survives): L3. |

## Hexagonal check

`isTenantAdmin(user)` is on the Registry port typedef (registry-port.js:55). It is implemented in all three adapters,
covered by the shared contract (memory, SQLite, Postgres all run it), and used from http.js only through the injected
`registry`. Every Registry in server/ either implements it or spreads one that does (main.js:239 `...registry`;
tenancy.js:253 is a read view not passed to http). `test/auth/architecture.test.js` passes in the full run.

## Probes

**Admin bootstrap after start.**
- SQLite: covered by dev-menu.test.js:162-171, and V2 kills it.
- Live on Postgres: a gateway node on the rig offered `[ada, bo]`. `scripts/admin-bootstrap.js --domain … --admin dev:bo`
  with `DATABASE_URL` → exit 0, `"registry":"postgres"`. The next `GET /auth/dev` → `[ada]`.

**Tenant admin revoked later.** The port has no revoke call, so I deleted the `reg_tenant_admins` row for `dev:ann`
straight from `registry.db` while the server ran. The next request offered `[ann, ada]`. That is correct: `dev:ann` is no
longer an admin of anything, and the plain token carries no domain, so it gets no tenant power.

**Many users / per-request cost** (SQLite, median of 5):

| Dev users | Admin rows | Median |
|---|---|---|
| 2 | 0 | 0.5 ms |
| 2 | 20,000 | 9.0 ms |
| 1000 | 0 | 2.5 ms |
| 1000 | 20,000 | **1206.7 ms** |

The cost is users × admin rows: N sequential queries, each a full scan, because neither adapter indexes `member` alone
(the PK is `(tenant, member)`). The Postgres EXPLAIN shows `Seq Scan on reg_tenant_admins … Filter: (member = …)`. See L1.

**Registry failing.**
- Postgres fast shutdown (SIGINT) → `503 {"error":"unavailable"}` in 1 ms, nothing published. A first attempt used
  SIGTERM. That is Postgres's smart shutdown, where pooled connections keep answering, so its 200 was correct and is not
  fail-open.
- The failure leaves no log line: L4.

**Registry slow.** I held `LOCK TABLE reg_tenant_admins IN ACCESS EXCLUSIVE MODE` on a second connection. `GET /auth/dev`
got no answer: Bun closed the request at its 10 s idle timeout (`Bun.serve() timed out a request after 10 seconds`), and
the client saw a reset at 11.3 s. The Postgres adapter's lock/statement timeouts are 15 s, so the 503 path is never
reached. Nothing was published, and after the unlock the route answered 200 again. See L2.

**README Try it, literally (headless Chrome).**
- The README command word for word, port 8099. The log has `dev sign-in menu is ON {users:2}`, `dev tokens are ON`,
  `server listening {port:8099}`, 0 error lines, and no token value.
- `curl /auth/dev` → 200. With `Host: evil.example:8099` → 404.
- `localhost:8099/?as=ada`: the canvas loads, the pill reads "Live" and the count "👁 0 viewers".
- `?as=bo`: session `{"token":"dev-bo","user":"dev:bo",…}`. R plus a drag gives "1 selected". ada's tab shows bo's
  rectangle with a dashed remote selection (screenshot).
- `localhost:8099/` in a fresh tab: "Sign in to Plenary / Dev sign-in is on: pick a user. / Continue as ada (owner) /
  Continue as bo (editor)", with no Google button.

## Findings

### HIGH

None.

### MEDIUM

**M-1. When the Registry filter leaves no offerable user, the menu answers 404 with no warn line, and the log still says
the menu is ON.**
- The coordinator's rule says that when the conditions fail ("≥1 offerable dev user" among them), the answer is 404 plus
  one warn line. Since this diff, offerability is decided in two places:
  - main.js:342-347 counts the names at start without the Registry and logs `dev sign-in menu is ON … users:N`
    (main.js:392).
  - http.js:363-364 filters per request and answers a bare 404 when nothing is left. It logs nothing.
- Demonstrated, case A (scratch `probe1.js`, round 3's M2 scenario):
  - Run 1 uses `{"SECRET-ADM":{name:"ann",domain:"acme.test",admin:true}}`.
  - Run 2, same data dir, uses only `{"tok-plain":{name:"ann",role:"editor"}}`.
  - The log: `warn: dev sign-in menu is ON … users=1`. Then `GET /auth/dev` → 404, four times, with no further line.
- Demonstrated, case B (`probe4.js`, LOG_LEVEL=warn): tokens `{t-bo: bo}`. The menu answers 200, then
  `admin-bootstrap --admin dev:bo` runs. The next 4 requests → 404, with **0 new log lines**.
- The person sees "menu is ON" in the terminal and a 404 or an empty sign-in screen in the browser, with nothing telling
  them why. Security holds (nothing is published). The rule's diagnostic does not.
- Fix:
  - At start, run the same `isTenantAdmin` filter over `offered` before `devMenuOff`, so `users` is the true count and an
    all-admin table logs `… is OFF: no dev token is offerable …`.
  - In http.js, when a request filters out a name that start-up offered, warn once per name (not per request), e.g.
    `dev sign-in menu: <name> is a tenant admin in the registry, not offered`.
  - Add a test for both: the round-3 two-run case asserts the OFF/warn line, and bootstrap-after-start asserts one warn.

### LOW

**L1. Per-request cost is O(dev users × tenant-admin rows)** (http.js:364, sqlite.js:109, postgres.js:241; no index
on `member`). The probe measured 1.2 s at 1000 × 20k. It is loopback-only, and realistic dev tables are a handful of
names, so this is not a blocker. Fix: one query (`WHERE member = ANY($1)` / `IN (…)`), or an index on `member`.

**L2. A slow Registry holds `/auth/dev` past Bun's 10 s request idle timeout; the client gets a reset, not a 503.** It
fails closed (nothing published, and the client adapter treats it as no menu). This is the same interplay every
Registry-backed HTTP route has with the 15 s Postgres limits; it was not introduced here. Optional: bound the menu's
Registry wait (e.g. 2 s → 503).

**L3. LOW-2's per-server limiter has no test.** V5 (module-global again) survives `test/server/ test/auth/` 495/0. The
behaviour is right (probe above). A two-servers-in-one-process case in bad-host.test.js would pin it.

**L4. A Registry error on `/auth/dev` answers 503 but logs nothing** (http.js:438-446 generic catch). That is fine for
security, but a dev looking at a missing menu has no hint. Optional: one rate-limited warn.

## Not findings (checked)

- Postgres `isTenantAdmin("")`, `undefined`, and NUL strings → false (`key()` returns a boolean; postgres.js:122).
- A name that is no longer an admin is offered again (revoke probe). That is correct.
- The SIGTERM 200 is smart shutdown, not fail-open (above).
- No token value in any log: the Try it server, the cluster gateway, and the host-only node.

## Verdict

**FAIL** on M-1. Round 3's M1, M2 (offering), LOW-1 and LOW-2 are fixed and verified: mutants killed, the contract runs
on real Postgres, the live Postgres bootstrap-after-start works, it fails closed on Postgres down, and the README Try it
works in headless Chrome. The remaining blocker: when the per-request Registry filter leaves no user, the menu answers
404 with no warn line while start-up logged "menu is ON". The coordinator's rule requires 404 plus one warn line.
L1-L4 are non-blocking. Under "fix everything", L1 and L3 are cheap to do with M-1.

# Report: p5-tidyv (verify p5-tidy round 2: the p5-devadmin2v and p5-google2v LOWs)

**PASS, with LOWs only. F1/F2 is not fully closed.** Every value the builder routed through `shown()` reaches
stderr escaped. That covers the admin entry, the domain, an unknown flag and `--flag=value`, checked with `od -c` on
real stderr. But one CLI path the builder missed still prints operator input raw. `scripts/admin-bootstrap.js:81`, the
exit-1 `failed:` line, echoes the `--data-dir` / `PLENARY_DATA_DIR` path or the `DATABASE_URL` database name with
only `JSON.stringify`, so DEL, C1 and RLO reach the terminal. That line is unchanged since HEAD (not a regression),
and the input is the operator's own, so I grade it LOW, as p5-devadmin2v graded F1. codex found it independently.

**One regression, LOW:** a connection reset while Google's token body is being read now logs `bad_token_response`
("not JSON, check for a proxy"). The same probe run against HEAD's `server/auth` logged `idp_unreachable` (2xx) and
`token_http_500` (500). This also goes against the builder brief's step 3, "Network/fetch failure stays
`idp_unreachable`".

**The verdict hinges on two regrades.** codex rated V1 and V2 MEDIUM. I graded both LOW:
- **V1:** the bytes come from the operator's own argv or env, on the exit-1 path.
- **V2:** the CEO's action ("retry") is the same under either label.

If the manager grades either one MEDIUM, this becomes FAIL.

Everything else holds:
- **Mutations:** all 13 of the builder's reproduce as killed. X5 fails on memory, SQLite and Postgres.
- **Cause table:** the p5-google2.md (e) table lists exactly the labels the code can log, checked independently.
- **Logs:** no new log line can carry a token, code, body, email or IdP text.
- **Gates:** green apart from known or other sessions' failures.

This file replaces round 1's verifier report (committed in d8fc084, still in git history).

Nothing committed. No code or test file in the live tree was edited. All mutations ran in scratch worktrees, which
are now removed. `git diff HEAD` of the 8 job files hashed `b8af2dc9…8d5162` before and after.

## Findings

| # | Grade | Finding |
|---|---|---|
| V1 | LOW (existed before this job; F1/F2 not fully closed) | **The `failed:` path echoes operator paths and DB names raw.** `scripts/admin-bootstrap.js:81` does `err(JSON.stringify({ ok: false, error: \`failed: ${e.message…}\` }))`. `JSON.stringify` escapes only C0. Real stderr, `od -c`: `--data-dir $'/etc/passwd/x\x7f'` gave raw `177`; `…x\xc2\x9b2J` gave `302 233`; `…x\xe2\x80\xae` gave `342 200 256` (RLO). `PLENARY_DATA_DIR=$'/etc/passwd/y\xe2\x80\xae'` gave the same. `DATABASE_URL=postgres://…/x%7Fy`, `x%E2%80%AEy` and `x%C2%9By` (database names, real Podman Postgres) gave the raw bytes in `database "x\u202ey" does not exist`. ESC was escaped (C0). **Fix:** run the whole message through `shown()` (or the `UNSAFE` replace without the quoting) before `JSON.stringify`, and add a `--data-dir` case to the CLI test. **Ensemble:** codex (high) reported the same at MEDIUM via `EEXIST`, and I had found it first by probing. I confirmed it with the runs above and graded it LOW, because the bytes come from the operator's own argv or env. |
| V2 | LOW (regression from this job) | **A connection reset mid-body logs `bad_token_response`, not `idp_unreachable`.** `server/auth/oidc.js:255` and `:262` label every non-timeout rejection of `res.json()` as `bad_token_response`. A real socket that sends headers plus `{"id_token":"abc`, then resets, logs `["bad_token_response"]` for status 200 and 500 (Bun throws `TypeError: ECONNRESET`). At HEAD the 2xx body read sat inside the outer `try`, so it logged `idp_unreachable`. The hand-off table then tells the CEO to suspect a proxy for what was a network drop. The action ("retry") is the same, hence LOW. **Fix (also fixes V3):** `const text = await res.text()` with fetch errors mapped as now (timeout gives `idp_timeout`, else `idp_unreachable`), then `JSON.parse(text)` in its own `try`, where a failure gives `bad_token_response`. codex raised this (MEDIUM). I confirmed it with `drop.js` (a raw `node:net` server). The same script against a `git archive HEAD` copy of `server/` gives `idp_unreachable` (200) and `token_http_500` (500), so this is a regression, measured. |
| V3 | LOW (test fidelity; claim partly refuted) | **An empty body behaves differently on a real socket.** In Bun 1.4.4 `await res.json()` on a real fetch with an empty body returns `null`, with either `content-length: 0` or an empty chunked body. A synthetic `new Response("")` throws `SyntaxError`. Over a real socket, an empty 200 logs `bad_token` and an empty 503 logs `token_http_503`. The builder's "empty 200 / empty 503 → `bad_token_response`" cases pass only because the test uses a synthetic `Response`. Both real labels are in the table with fitting meanings, so L4 is unaffected. The `text()` + `JSON.parse` fix in V2 makes both cases `bad_token_response` for real. |
| V4 | LOW | **Truncation can hide the offending character and cut an escape in half.** `shown()` escapes, then cuts at 80 code points of the escaped text. No raw byte or split surrogate ever results (checked: 100 emoji give 80 code points with no lone surrogate; a lone `\ud800` input is shown as `\ud800`). But: `normAdmin("dev:" + "a"×70 + "\u202e")` gives `…aaaa\u202` (half an escape, no closing quote). `"dev:" + "a"×100 + "\u202e"` shows only `a`s, so the reader is told "has a control character" but can't see it. `"a"×77 + U+E0001` ends `\u`. `normDomain` of a long domain with a trailing DEL shows only a valid-looking prefix with no reason at all. Escaping grows a character 6×, so the window is about 13 escaped characters. Nothing pins this (mutation E4, no cut, is killed only by the length assertion). **Fix:** cut the raw value first (by code point), then escape, and append `…` when cut; or name the first unsafe character's index and code point in the message. |
| V5 | LOW (test gap) | **The label scan and the table aren't pinned in both directions.** The scan misses a new label written with single quotes (E8), as a template literal (E9) or on the next line (E11): all three survive, and a label like `brand_new_label` would pass http.js's `why` filter and be logged. Nothing checks the other direction: a phantom label added to `CAUSES` (E12) or `SIGN_IN_CAUSES` (E13) survives. Nothing reads the p5-google2.md table either (codex, LOW): the builder's table check was a one-off `bun -e`. The table is exact today (see L4 below). **Fix:** have the scan match `'…'` and `` `…` `` literals and work over the whole call text, not one line; and add a test that parses section (e) and compares it to `CAUSES ∪ SIGN_IN_CAUSES` both ways. |
| V6 | INFO | **`p5-google2.md:161` is stale, as the builder flagged.** It still says "Every cause above is produced in `signin-cause.test.js`", which is untrue for `bad_config`, `bad_expected`, the four extra RFC 6749 names and others. The builder's suggested wording is fine. |
| V7 | INFO (pre-existing; from reading the code, not run) | **`unknown_kid` also means Google's key endpoint couldn't be reached.** `jwksCache.key` swallows a failed refresh and returns `null` (`oidc.js:108`), so `verifyIdToken` says `unknown_kid`. The table groups it under "shouldn't happen, report the cause". A JWKS outage is a "retry" case. Worth a phrase in that row. |
| V8 | INFO | **The table's first column lists `server_error`, `temporarily_unavailable` and `login_required` bare, as examples.** They are logged as `idp_error:server_error` and so on. A reader grepping the log for a bare `server_error` won't find it. Write them as `idp_error:server_error` and so on. |

## Builder claims

| Claim | Verdict | Evidence |
|---|---|---|
| F1: `shown()` escapes every Cc, Cf, U+2028/9, astral as `\u{…}`, 80 code points, no split pair | **Confirmed** for what it is applied to | Probes below; `trunc.js`. Truncation has the V4 caveats. |
| F1/F2: every operator value echoed by the CLI goes through `shown()` | **Refuted** (V1) | The `failed:` path at `:81`. The other echoes are `${flag} needs a value`, where `flag` is always one of the three literal flags, and `…not on the tenant's domain ${domain}`, where `domain` has already passed the `DOMAIN` regex. Both are safe. The success line goes to stdout, and every admin in it passed `normAdmin` (Cc/Cf refused; `\s` in the regexes excludes U+2028/9). |
| F3: X5 now fails on memory, SQLite and Postgres | **Confirmed** | X5 killed, failing exactly "an email admin off the tenant's domain…" on `memory`, `sqlite` and `postgres` (22 pass / 3 fail). |
| L2: non-JSON → `bad_token_response`; fetch failure → `idp_unreachable`; timeout during fetch or body read → `idp_timeout` | **Partly refuted** (V2, V3); the rest confirmed | Real local server (`l2.js`, real `AbortSignal.timeout`, 500 ms): see the L2 table below. |
| HTML 502 → `bad_token_response` (was `token_http_502`) | **Confirmed; I agree with it** | See "HTML 502 judgment". |
| L4: the table lists every loggable label; `mint_failed` added | **Confirmed** | Independent enumeration (below): missing 0, extra 0. M7 and M9 killed. |
| U+2028/U+2029 at either end of an admin entry are trimmed and accepted (deviation note) | **Confirmed** | `normAdmin("dev:ann" + U+2028)` and `normAdmin(U+2029 + "dev:ann")` both return `dev:ann`. This is p5-devadmin2v's F4 (INFO), out of this brief. |
| 13 mutations, all killed | **Confirmed**, every row | Mutation table below. |
| `bun test test/auth test/admin` 218 pass, 18 skip, 0 fail | **Confirmed** | Live tree: 218 pass, 18 skip, 0 fail, 236 tests. |
| test/admin with Postgres: 32 pass | **Confirmed** | 32 pass, 0 fail (Podman Postgres 17.11). |
| Full suite: 2 known failures plus the v1 pacing flake, which is not this job's | **Confirmed** | See Gates. v1.test.js's import graph (static and dynamic, walked transitively) loads none of the 4 job code files. It passed 3/3 alone and in the clean worktree. |
| Old `unknown argument: --nope` text has no dependents | **Confirmed** | `grep -rn "unknown argument" scripts server test docs`: only the code line and p5-devadmin2v's finding text. |
| Design check not needed | **Agree** | Escaping, log labels and a doc table. No state, messages or nodes. |

## F1/F2 probes (real process, real stderr, `od -c`)

Run as `bun scripts/admin-bootstrap.js …` from the scratchpad (no `.env`), with `DATABASE_URL` unset unless named.
Raw bytes were given as explicit UTF-8 (`$'\xe2\x80\xae'`), because macOS bash 3.2 mis-handles some `\u` escapes.

| Input | Exit | Raw byte on stderr? | Shown as |
|---|---|---|---|
| `--admin dev:ann` + DEL / C1 CSI / RLO / U+E0001 | 2 | no | `\u007f`, `\u009b2J`, `\u202e`, `\u{e0001}` |
| `--admin` email with ZWSP / RLO off-domain | 2 | no | `\u200b`, `\u202e` (refused as a control character first) |
| `--domain` with ZWSP / RLO / NEL | 2 | no | `\u200b`, `\u202e`, `\u0085` |
| unknown flag with ESC / LS; bare word with LS; `--x<NEL>=1` | 2 | no | `\u001b[2J`, `\u2028`, `"--x\u0085"` |
| invalid UTF-8 `\xff\xfe` in an admin | 2 | no | U+FFFD (Bun decodes argv) |
| **`--data-dir` with DEL / C1 CSI / RLO (mkdir fails)** | 1 | **yes** (`177`, `302 233`, `342 200 256`) | raw: V1 |
| **`PLENARY_DATA_DIR` with RLO** | 1 | **yes** | raw: V1 |
| **`DATABASE_URL` db name `%7F` / `%E2%80%AE` / `%C2%9B`** | 1 | **yes** | raw: V1 |
| `--data-dir` with ESC | 1 | no | `\u001b` (C0, JSON escapes it) |

## L2: the token exchange on a real socket

`googleOidc` with `fetch` redirected to a local `Bun.serve` / `node:net` server, `timeoutMs: 500`:

| Answer | Label | Leaked body/description? |
|---|---|---|
| connection refused; DNS failure | `idp_unreachable` | no |
| headers delayed 3 s | `idp_timeout` (500 ms) | no |
| 200 or 500, partial body then stall | `idp_timeout` (500 ms) | no |
| 200 or 500, partial body then **reset** | `bad_token_response` (**V2**) | no |
| 200 HTML; 502 HTML | `bad_token_response` | no |
| 400 JSON `invalid_grant` + description | `invalid_grant` | no |
| 400 JSON unknown `error` | `token_http_400` | no |
| 500 JSON with no `error` | `token_http_500` | no |
| **200 empty; 503 empty** | **`bad_token`; `token_http_503`** (**V3**) | no |
| 200 `null`; 200 `[1]` | `bad_token` | no |

### HTML 502 judgment

`bad_token_response` is the better label for the CEO. Its row says what to do ("retry; if it repeats, check for a
proxy, then report"), and it names the real causes of an HTML answer: an outage page, a proxy or a captive portal.
`token_http_502` in the old row read as "Google answered with status 502 and no standard error name". That is true,
but it gives no hint that something other than Google may have answered. What is lost is the status number. That
number would tell Google's 5xx outage page apart from a portal's 200. That costs little: the CEO's action is the same,
and a repeat gets reported anyway. If the status is wanted back, `bad_token_response_502` passes http.js's `why`
filter (`(?:_\d{3})?`) and would need one more row. Not required.

## L4: label check, independent of the builder

I listed what the code can log by reading it, not from the exported lists:
- **The only log call:** `grep -nE "console\.|log\??\.(warn|info|error|debug)|process\.(stdout|stderr)" server/auth/*.js` finds just `failed` (`http.js:259`) and the default `stdoutLog` (`http.js:447`).
- **Every input to `failed`:** the `fail(…)` / `failed(…)` call sites, `cause ??= "idp_threw"`, `?? "idp_refused"`, and every `no(…)` in `oidc.js` that reaches `why`.
- **Which IdP feeds `why`:** in production `server/main.js:121` wires only `googleOidc`.
- **The `why` filter:** I checked every `why` label against the filter regex; none is dropped.

`table.js` parsed the first column of section (e) and compared it to that hand-written set:
- **Missing from the table:** `[]`.
- **In the table but not loggable:** only `cause` (the header) and the bare examples in V8.
- **Pattern rows:** `token_http_<n>` covers all 3-digit statuses, and `idp_error:<other name>` covers the 12 other `AUTHORIZE_ERRORS`.

The widened scan **does** catch a missing label written in the house style:
- **Caught:** a new ternary label in oidc.js (E7) is killed. A new label via `cause ??=` (E10) is killed, though by a behaviour test, not by the scan.
- **Missed:** the forms in V5 survive.

## Nothing logged leaks

- **New log calls:** this diff adds exactly one, `failed("mint_failed")`, a fixed string.
- **New label:** `bad_token_response` is a fixed string handed to `no`.
- **No new error text logged:** no new path logs an error object, message or body.
- **L2 probe:** every server answer embedded a unique `SECRET…` marker. No label contained it or the `weird_` error name.
- **CLI:** the new CLI echoes go to the operator's own stderr, not the server log. They show only the operator's own argument, escaped.

## Mutations (scratch worktree = HEAD + this job's diff; `mut.js` applies one exact edit, runs the tests, restores)

| Id | Mutation | Tests | Result |
|---|---|---|---|
| X5 | `CONTROL.test(s)` (trimmed) | tenants.test.js with Postgres | **Killed** on memory, sqlite, postgres |
| M1 | `shown` skips the escape | test/admin | **Killed** (3) |
| M2 | raw `${flag}` | test/admin | **Killed** (CLI test) |
| M3 | `normDomain` back to `JSON.stringify` | test/admin | **Killed** (2) |
| M4 | `charCodeAt` | test/admin | **Killed** (2) |
| M5 | `q.slice(0, 80)` | test/admin | **Killed** |
| M6 | 2xx non-JSON → `idp_unreachable` | signin-cause | **Killed** |
| M6b | non-2xx non-JSON → `token_http_<status>` | signin-cause | **Killed** |
| M6c | 2xx catch always `bad_token_response` | signin-cause | **Killed** |
| M6d | non-2xx catch always `bad_token_response` | signin-cause | **Killed** |
| M7 | no `mint_failed` log | signin-cause | **Killed** |
| M8 | drop `bad_token_response` from `CAUSES` | test/auth | **Killed** |
| M9 | drop `mint_failed` from `SIGN_IN_CAUSES` | test/auth | **Killed** |
| E1 | `UNSAFE` without U+2028/9 | test/admin | **Killed** (3) |
| E2 | `UNSAFE` without `\p{Cf}` | test/admin | **Killed** (3) |
| E3 | "not an admin name" message raw `JSON.stringify` | test/admin | **Killed** (2) |
| E4 | no truncation | test/admin | **Killed** (length assertion only) |
| E5 | fetch failure → `bad_token_response` | signin-cause | **Killed** |
| E6 | known RFC 6749 name ignored | signin-cause | **Killed** |
| E7 | new ternary label in oidc.js | signin-cause | **Killed** (scan) |
| E8 | new single-quoted label | signin-cause | **Survived** (V5) |
| E9 | new template-literal label | signin-cause | **Survived** (V5) |
| E10 | new label via `cause ??=` | signin-cause | **Killed** (idp_threw test, not the scan) |
| E11 | new label on the next line | signin-cause | **Survived** (V5) |
| E12 | phantom label in `CAUSES` | test/auth | **Survived** (V5) |
| E13 | phantom label in `SIGN_IN_CAUSES` | test/auth | **Survived** (V5) |

## Gates

| Run | Result |
|---|---|
| `bun test test/auth test/admin`, live tree | **218 pass, 18 skip, 0 fail** (236 tests, 16 files) |
| same, scratch worktree with `DATABASE_URL` (Podman) | **224 pass, 18 skip, 0 fail** |
| `bun test test/admin`, worktree with Postgres | **32 pass, 0 fail** |
| Full `bun test`, live tree | **1365 pass, 150 skip, 3 fail** (1518 tests, 79 files). Failures: `test/core-source.test.js` (known, herdr-draw drift); gateway.test.js "the entries subject carries each entry once, after it is durable" (other sessions' uncommitted files); v1.test.js "§ Pacing: … past maxLiveQueuedBytes" (20 s timeout). |
| Full `bun test`, clean worktree (HEAD + this job only) | **1302 pass, 144 skip, 3 fail.** The gateway and v1 pacing tests **pass** there. The 3 failures were NATS tests with `ERR_MODULE_NOT_FOUND`: my worktree lacked `node_modules`. After linking it, `test/server/nats` gives 15 pass, 0 fail. `core-source` skips there (no sibling herdr-draw), so the clean run says nothing about it. |
| `bun test test/server/v1.test.js` alone, live tree | 12 pass ×3 |

**The flake:** v1.test.js "§ Pacing: frames read from a live socket faster than they are handled are capped in bytes"
hit its 20 s timeout in my live full run and in the builder's final run. It is **not this job's**:
- **Import graph:** its transitive import graph contains none of the job files.
- **Clean worktree:** it passes there (HEAD plus only this job).
- **Alone:** it passes 3/3 run on its own.
- **Other sessions' files:** it imports `server/room-host.js` and `server/bus/port.js`, both carrying other sessions' uncommitted edits, so look there or at load (it fails only in full runs).

## sdd ensemble review

- **agy:** `check_adapter("agy")` failed with "Individual quota reached… Resets in 50h28m". Not used.
- **codex** (`effort: high`, own scratch worktree): two MEDIUM findings and one LOW.
  - The `--data-dir` echo: **confirmed** as V1, graded LOW.
  - The body-read network error labelled `bad_token_response`: **confirmed** as V2, graded LOW.
  - The table not tested: **confirmed** as part of V5.
  - codex said 7 tests failed in its sandbox because socket binds were denied. That is its environment.
- **grok** (own scratch worktree): no findings. It also called the synthetic-`Response` tests faithful to real fetch, which V3 refutes.
- **Agreement:** by the brief's rule (two harnesses agreeing) there were **no HIGH candidates**, since grok reported nothing. codex's three findings (V1, V2, V5's table gap) each match something I found or confirmed with a run. I graded them as in the Findings table.

## How this was run; cleanup

- **Scratch worktrees:** `wt` (mutations, full suite), `rev` (codex) and `rev2` (grok). Each was HEAD plus `job.diff` (`git diff HEAD` of the 8 job files, sha256 `b8af2dc9…8d5162`). All are removed (`git worktree remove --force`, then `prune`).
- **Postgres:** Podman `postgres:17.11-alpine3.23`, id `3b0fea0e6d6d`, on a random port with a random password (not printed). Removed with `podman rm -f` on that id only, then checked gone.
- **No pkill or killall.** Test servers used port 0. The `node:net` probes listened on port 0 and were closed.
- **One `git stash` / `stash pop`** ran inside the scratch worktree to run NATS at pure HEAD. Its stack is shared with the repo; `git stash list` is empty afterwards.
- **Live tree:** after cleanup, the 8 job files hash the same as at the start. `git status` shows no file of mine. New untracked files (`test/web/one-link.test.js`, `test/web/contracts/class-transport.test.js`) are other sessions'.
- **Probe scripts** are in `/private/tmp/claude-501/-Users-r-repos-plenary/9b8dec91-68d9-40e6-abf4-077cb844d0f0/scratchpad/`: `drop-head.js` (V2 against HEAD), `probe.sh`, `probe2.sh`, `trunc.js`, `l2.js`, `drop.js`, `table.js`, `mut.js`, `gen.js`.

## Not verified

- **Terminal rendering:** how a real terminal displays the escaped output. Only bytes were checked.
- **V7:** read from the code, not run.
- **`mint_failed` from a real failure:** a real `crypto.subtle` failure was never triggered, only the builder's stub.
- **Body read slower than the timeout on Google itself:** only on a local server.

## Suggested fixes (for the manager to brief; none made)

1. **V1:** escape the `failed:` message at `scripts/admin-bootstrap.js:81` with the `UNSAFE` replace, and test it with a `--data-dir` value.
2. **V2 + V3:** read the token answer as `text()` (fetch errors as now), then `JSON.parse` it in its own `try`, which gives `bad_token_response`. Add real-socket tests for a mid-body reset and for empty 200/503 bodies.
3. **V4:** cut the raw value before escaping, add `…` when cut, or name the first unsafe code point.
4. **V5:** widen the scan to `'…'`, `` `…` `` and multi-line calls, and add a test that parses section (e) and compares it both ways.
5. **V6–V8:** doc wording in p5-google2.md (row (e) at :161, the `unknown_kid` meaning, the `idp_error:` prefix on examples).

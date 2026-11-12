# Report: p5-tidy (round 2: the p5-devadmin2v and p5-google2v LOWs)

**Done.** F1, F2, F3, L2 and L4 are closed, and `mint_failed` is added. Every code fix has a test that fails under its
mutation (13 mutations, all killed). `bun test test/auth test/admin` is all green. Full `bun test` fails only the 2
known unrelated tests, plus 1 timing flake that passes when run alone (Gate). Nothing committed.

This file replaces round 1's report (clean-checkout google-live fix, committed in d8fc084, still in git history).

## Files changed

| File | Change |
|---|---|
| `server/admin/tenants.js` | New export `shown(v)`, the one escape helper: JSON-quotes the value, then writes every `\p{Cc}`, `\p{Cf}`, U+2028 and U+2029 as `\uXXXX` (astral as `\u{XXXXX}`, e.g. `\u{e0001}`), and cuts at 80 code points (never splits a surrogate pair). `normDomain` and all three `normAdmin` errors use it. |
| `scripts/admin-bootstrap.js` | `unknown argument: ${shown(flag)}` (was the raw flag). Imports `shown` from tenants.js. |
| `server/auth/oidc.js` | The token fetch and the body parse are now in separate `try`s. A token answer whose body isn't JSON logs `bad_token_response`, **whatever its status**: 2xx, or an error status such as Google's HTML 502 page, which used to be `token_http_502`. A JSON error body without a known name still gives `token_http_<status>`. A fetch failure still logs `idp_unreachable`. A timeout, during the fetch or while reading the body, still logs `idp_timeout`. `bad_token_response` is added to `CAUSES`. |
| `server/auth/http.js` | A `mintCode` failure (the 503 after a successful sign-in) now logs `mint_failed`. Added to `SIGN_IN_CAUSES` and its doc comment. |
| `test/admin/tenants.test.js` | F3 entries in the refusal list. New tests: `shown` unit test, and "normAdmin and normDomain errors never echo a raw control or format character". |
| `test/admin/devadmin.test.js` | New CLI test: DEL, C1 CSI, RLO, ZWSP, NEL, LS and a tag character (U+E0001) in an admin entry, a domain, an unknown flag and an unknown `--flag=value`. Asserts exit 2, the raw UTF-8 bytes are absent from stderr, and the escaped form is present. |
| `test/auth/signin-cause.test.js` | `bad_token_response` cases: HTML 200, empty 200, truncated JSON 201, empty 503. The HTML 502 case changes from `token_http_502` to `bad_token_response`. Two body-read `TimeoutError` cases (200 and 500) expect `idp_timeout`. New `mint_failed` test. The source scan for labels now also sees labels inside ternaries (see M8). |
| `docs/m2/reports/p5-google2.md` | Section (e) only: the cause table now lists all 34 labels, plus a note on how that is checked. |

## Each LOW, its test and its mutation

| LOW | Fix | Test | Mutation | Result |
|---|---|---|---|---|
| **F1** (DEL, C1, Cf raw on stderr) | `shown()` escapes every Cc/Cf and U+2028/9 | `shown` unit test; "errors never echo a raw control or format character"; the CLI test | M1: `shown` skips the escape | **Killed** (3 tests) |
| F1 | astral Cf as its code point | `shown` unit test; CLI test (U+E0001) | M4: `charCodeAt` instead of `codePointAt` (gives a lone surrogate escape) | **Killed** (2 tests) |
| F1 | cut by code point | `shown` unit test (100 emoji: 80 code points, no lone surrogate) | M5: `q.slice(0, 80)` | **Killed** |
| **F2** (unknown flag raw) | `unknown argument: ${shown(flag)}` | CLI test | M2: raw `${flag}` | **Killed** |
| F2 (`normDomain` raw DEL) | `not a domain: ${shown(d)}` | unit test and CLI test | M3: back to `JSON.stringify(...)` | **Killed** (2 tests) |
| **F3** (trim-before-check untested) | test only: `"alice@acme.com\n"`, `"\tdev:ann"` in the refusal list | "an email admin off the tenant's domain, or any control character, is refused…" | **X5**: `CONTROL.test(s)` (trimmed) instead of `a` | **Killed on memory, SQLite and Postgres** (it survived all three before this job, per p5-devadmin2v) |
| **L2** (non-JSON 200 called `idp_unreachable`) | separate parse `try`, label `bad_token_response` | cases in "Google's token endpoint…": HTML 200, empty 200, truncated JSON 201 | M6: label it `idp_unreachable` again | **Killed** |
| L2 | non-2xx non-JSON is `bad_token_response` too | HTML 502 and empty 503 cases | M6b: the `!res.ok` parse failure falls back to `token_http_<status>` | **Killed** |
| L2 | a body-read timeout stays `idp_timeout` (2xx branch) | stalled-body 200 case | M6c: the 2xx parse `catch` always says `bad_token_response` | **Killed** |
| L2 | a body-read timeout stays `idp_timeout` (non-2xx branch) | stalled-body 500 case | M6d: same, in the `!res.ok` branch | **Killed** |
| L2 | label listed in `CAUSES` | "every cause either file reports is listed" | M8: drop it from `CAUSES` | **Killed**, after a test fix. At first it **survived**: the scan only matched `no("x")`, so a label inside `no(cond ? "a" : "b")` was never checked (`idp_timeout`, `idp_unreachable` had the same blind spot). The scan now collects every quoted lowercase label in each `no(…)` / `fail(…)` / `failed(…)` statement. It also asserts it sees the ternary labels `bad_token_response` and `bad_login_cookie`. |
| **L4** `mint_failed` | `failed("mint_failed")` before the 503 | new "sign-in succeeds but the exchange code can't be made" test. A stub IdP returns a BigInt user id, so `JSON.stringify` in `mintCode` throws. Asserts 503 and one `mint_failed` line. | M7: no log line | **Killed** |
| L4 | listed in `SIGN_IN_CAUSES` | "every cause … is listed" | M9: drop it | **Killed** |

How I ran mutations: a script edits one file, runs the named test file, then restores it from a scratchpad backup.
After all runs, `git diff` of the 4 code files shows only the intended changes.

## How the label list was checked (L4)

- **One log site.** `grep -rn "warn\|\.error(\|\.info(\|console\.\|stdout" server/auth/*.js`: the only logging call is `failed` in
  `server/auth/http.js:259` (`log.warn("sign-in failed", { cause })`), plus the default `stdoutLog` it writes through.
- **What reaches it:** labels from `fail(…)` / `failed(…)`, `idp_threw`, `idp_refused`, `idp_error:<name>`, and any
  label oidc.js hands to `why`. That set is exactly oidc.js `CAUSES` ∪ http.js `SIGN_IN_CAUSES`.
- **The source scan** (in `signin-cause.test.js`) checks that every label written in either file is in those lists:
  - oidc.js: `bad_config bad_nonce bad_token bad_alg unknown_kid bad_sig bad_iss bad_aud bad_time expired stale bad_sub bad_expected state_mismatch no_code idp_timeout idp_unreachable bad_token_response`, plus the 6 RFC 6749 names and `token_http_<status>`.
  - http.js: `no_login_cookie bad_login_cookie idp_error state_mismatch no_code state_used idp_refused replay_guard_full mint_failed`, plus `idp_threw` and `idp_error:<name>`.
- **The table check:** a `bun -e` script imported both lists (34 labels) and checked that each appears in backticks
  in section (e). `token_http_<status>` is written there as `token_http_<n>`, and `idp_error:<name>` as
  `idp_error:<other name>`. Result: `missing from (e): []`.
- **Beyond the six labels the brief named,** the table also gained the four RFC 6749 token errors
  (`invalid_request`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`), `idp_error:<other name>`,
  `bad_token`, `bad_alg` and `mint_failed`.

## Gate

| Run | Result |
|---|---|
| `bun test test/auth test/admin` | **218 pass, 18 skip, 0 fail** (236 tests, 16 files). The skips are the Postgres and live-Google cases that need env. |
| `test/admin` with Postgres | **32 pass, 0 fail.** That is 26 without Postgres, so 6 Postgres cases ran. X5 also fails on Postgres. The container was Podman `postgres:17.11-alpine3.23`, id `c309d4d6770f…`, on a random port with a random password (not printed). I removed only that container (`podman rm -f`) and checked it is gone. |
| Full `bun test`, final run | **1322 pass, 150 skip, 3 fail** (1475 tests, 77 files). Known: `test/core-source.test.js` (herdr-draw drift) and `test/server/gateway.test.js` "the entries subject carries each entry once…" (other session's uncommitted file; a heartbeat now carries `opened: true`). **Third, a flake, not mine:** `test/server/v1.test.js` "§ Pacing: … past maxLiveQueuedBytes" hit its 20 s timeout. The file is unmodified and imports none of my files. It passed when run alone twice (12/12), and it passed in my earlier full run. That earlier run was 1323 pass, 2 fail (the two known). The known `room-host-lease` MEDIUM-3 failure appeared in neither full run. |
| Real process (not in-process `run()`) | `bun scripts/admin-bootstrap.js $'--nope\xc2\x9b[2J'` printed `unknown argument: "--nope\u009b[2J"` (`od -c`: no byte 302 233), exit 2. `--domain $'acme.com\x7f'` printed `not a domain: "acme.com\u007f"` (no byte 177). `--admin $'dev:ann\u202e'` printed `…control character: "dev:ann\u202e"` (no bytes 342 200 256). |

## Deviations and notes

- **The HTTP status is no longer logged for a non-JSON error answer.** Per the brief ("status 200 or not"), Google's
  HTML 502 page is now `bad_token_response`, not `token_http_502`, so the log no longer says which status it was.
  `token_http_<status>` remains for a JSON error body with an unknown name.
- **U+2028 / U+2029 at either end of an admin entry are still trimmed and accepted** (`"dev:ann "` becomes
  `dev:ann`). This is p5-devadmin2v's F4 (INFO), not in this brief. They are Zl/Zp, not Cc/Cf, so the control
  check doesn't refuse them. When they are echoed (mid-entry, domain, flag), they are escaped. The tests put each
  character mid-entry for that reason.
- **The error text changed slightly:** `unknown argument: --nope` now reads `unknown argument: "--nope"` (quoted
  by `shown`). No test or doc depended on the old form (grep).
- **Not verified:** a real terminal's rendering of the escaped output. The tests check bytes, not a terminal.
  `mint_failed` was triggered only by a stub IdP, never by a real `crypto.subtle` failure.
- **Change needed in a section I don't own:** `docs/m2/reports/p5-google2.md`, "Which steps I ran myself", row (e)
  (~line 150), says "Every cause above is produced in `signin-cause.test.js`". That is no longer true for all 34
  labels in the table: for example `bad_config`, `bad_expected` and the four extra RFC 6749 names aren't produced
  there. Suggested wording: "The causes p5-google2 added are produced in `signin-cause.test.js`; the table lists
  every label the code can log."
- **Engram:** searched before finishing. One relevant hit: Bun fetch errors carry the full request URL. It agrees
  with this code, which logs only fixed labels and never the error. Nothing written.
- **Design check:** not design-bearing. These are input escaping, log labels and a doc table, with no state, messages
  or nodes, so the distributed-systems-design skill was not applied.

## Round 3 (brief p5-tidy3: close p5-tidyv V1–V8)

**All of V1–V8 are closed.** 21 mutations were run and every one was killed. Gates are green apart from the known
`core-source` drift. Nothing is committed.

### Files changed (this round)

- **Code:** `scripts/admin-bootstrap.js`, `server/admin/tenants.js` and `server/auth/oidc.js`.
- **Tests:** `test/admin/devadmin.test.js`, `test/admin/tenants.test.js` and `test/auth/signin-cause.test.js`.
- **Doc:** `docs/m2/reports/p5-google2.md`, section (e). I also edited the (e) row of "Which steps I ran myself"
  (line 163), outside section (e), because brief step 5 names it.

### Findings closed

| # | Fix (file:line) | Test |
|---|---|---|
| V1 | `scripts/admin-bootstrap.js:83-84`. The URL is redacted first, then the whole `{ok:false}` line goes through `escapeUnsafe(line, { json: true })`. Both branches of the ternary are covered. New helper `escapeUnsafe` (`server/admin/tenants.js:46`) is the same escape `shown()` uses, without the quoting or the cut. With `json: true`, an astral character is written as its surrogate pair (`\udb40\udc01`), because JSON has no `\u{…}` escape. So the stderr line is still valid JSON, and it parses back to the real path. | `devadmin.test.js:139`. Spawns `bun scripts/admin-bootstrap.js` as a real process, in a temp cwd with only `PATH` in its env, so no `.env` is loaded. The data dir sits under a regular file, so mkdir fails and names the path. Covers DEL, C1 CSI, RLO and U+E0001, each via `--data-dir` and via `PLENARY_DATA_DIR`. It checks the raw stderr bytes, exit 1, empty stdout, that the line passes `JSON.parse`, and that the path round-trips. |
| V2, V3 | `server/auth/oidc.js:244-263`. `fetch` and `res.text()` share one `try`: a timeout gives `idp_timeout`, any other failure (a reset mid-body included) gives `idp_unreachable`. Then `JSON.parse` has its own `try`: a failure, an empty body included, gives `bad_token_response`, whatever the status. Then `res.ok` is checked. The `CAUSES` JSDoc says the same. | `signin-cause.test.js:123`. A raw `node:net` server on port 0 sends headers plus a partial body, then a reset, for 200 and 500, via both `destroy` and `resetAndDestroy`: `idp_unreachable`. An empty 200 or 503 body, sent with `content-length: 0` or empty chunked: `bad_token_response`. A real-socket `invalid_grant` and a `null` body (`bad_token`) are also checked. This test uses its own 8 s timeout, so a loaded run can't turn a reset into `idp_timeout`. |
| V4 | `server/admin/tenants.js:63-71`. `shown()` cuts the raw value to 80 code points first, then quotes and escapes it, and puts `…` after the closing quote when it cut. If the first unsafe character was cut off, it appends `(U+XXXX at code point N)`. | `tenants.test.js:133`. Both trailing cases from V4 (`dev:`+70 `a`+RLO, and 77 `a`+U+E0001) now show the whole escape and the closing quote. Also covered: `a`×100+RLO, an astral character past the cut, an unsafe character at position 80, and a long domain with a trailing DEL. |
| V5 | `signin-cause.test.js:296`, `sourceLabels`. Reads `"…"`, `'…'` and `` `…` `` literals (`${…}` becomes `<>`, anywhere in the label) across the whole call text, to its matching parenthesis, over any number of lines. It also reads `cause ??= "…"`. | **Both directions:** source labels ⊆ lists, and lists ∖ source = exactly the 6 RFC 6749 names (oidc) or ∅ (http). The scanner is also tested on its own input forms. **Table:** `signin-cause.test.js:310` parses section (e) and compares it with `CAUSES ∪ SIGN_IN_CAUSES` both ways. Concrete examples of a pattern row (`idp_error:server_error`) are allowed. |
| V6 | `p5-google2.md:163`, the (e) row now reads: "The causes p5-google2 added are produced in `signin-cause.test.js`, and a test there checks the table lists every label the code can log." | Doc only. |
| V7 | `p5-google2.md:136`, `unknown_kid` has its own row: "a key we don't have, or Google's key endpoint couldn't be reached …; wait a minute and retry". Checked against the code: `jwksCache.key` (`oidc.js:~106`) swallows a failed refresh and returns `null`. | Table test (T4). The behaviour itself was read from the code, not run. |
| V8 | `p5-google2.md:127`, the examples are now `idp_error:server_error`, `idp_error:temporarily_unavailable` and `idp_error:login_required`. | The table test fails on a bare example (T3). |

**Other table rows changed with V2/V3:**
- **Network row:** the `idp_unreachable` row now also says "the connection dropped before its whole answer arrived".
- **`bad_token_response` row:** now says "arrived whole … an empty answer included".

**Round-2 cases:** every round-2 case in `signin-cause.test.js` still passes with the same label. I kept the
synthetic-`Response` cases. Over a real socket, the empty 200 and empty 503 now also give `bad_token_response`, as
the round-2 synthetic cases had claimed.

**Other CLI echoes checked:**
- **`${flag} needs a value`:** `flag` is always one of the three literal flags.
- **The domain in "not on the tenant's domain":** it has already passed the `DOMAIN` regex.
- **The stdout success line:** it prints only normalised values.

None of these needed a change.

**Round-2 mutations:** two of them no longer apply to the code as it now is.
- **M5 (`q.slice(0, 80)`):** `shown()` no longer has `q`. R4 and R4c replace it.
- **M6–M6d (the two `res.json()` branches):** those branches are gone. R2–R2d replace them.

### Mutations

Run in a scratch worktree: HEAD plus `git diff HEAD` of the 8 job files (sha256 `cb0085e1…7eee524d`), with
`node_modules` linked. `mut.js` applies one exact edit, runs the named tests and restores the file. The live tree's
job diff hashed the same after the runs.

| Id | Fix | Mutation | Result |
|---|---|---|---|
| R1 | V1 | `failed:` line not escaped (`err(line)`) | **Killed**: CLI process test |
| R1b | V1 | escaped, but astral as `\u{…}` (invalid JSON) | **Killed**: CLI process test (`JSON.parse`) |
| R1c | V1 | escape only the bad-request branch | **Killed**: CLI process test |
| R2 | V2, V3 | token exchange restored to round 2 (`res.json()` in each branch) | **Killed**: real-socket test |
| R2b | V2 | body read moved into the parse `try` | **Killed** (2): real-socket test, token-endpoint test |
| R2c | V3 | `res.json()` in place of `text()` + `JSON.parse` | **Killed** (2) |
| R2d | V2 | body-read failure labelled `bad_token_response` | **Killed**: real-socket test |
| R4 | V4 | `shown` escapes first, then cuts at 80 (round 2) | **Killed** (2) |
| R4b | V4 | no note naming a cut-off unsafe character | **Killed** |
| R4c | V4 | no `…` after a cut | **Killed** (2) |
| E8 | V5 | new single-quoted label in oidc.js | **Killed**: scan |
| E9 | V5 | new template-literal label in oidc.js | **Killed**: scan |
| E9b | V5 | new template label in http.js, placeholder mid-label | **Killed** (2), but it replaced `fail("no_code")`, so the "before Google" test and the reverse scan kill it whatever the scan shape. The mid-label shape itself is pinned by the scanner's own `x_<>_z` assertion. |
| E10 | V5 | new label via `cause ??=` | **Killed**: scan |
| E11 | V5 | new label on the next lines of a `no(` call | **Killed**: scan |
| E12 | V5 | phantom label in `CAUSES` | **Killed** (2): reverse scan, table test |
| E13 | V5 | phantom label in `SIGN_IN_CAUSES` | **Killed** (2): reverse scan, table test |
| T1 | V5 | `mint_failed` dropped from the table | **Killed**: table test |
| T2 | V5 | phantom label added to a table row | **Killed**: table test |
| T3 | V8 | examples written bare again (`server_error`) | **Killed**: table test |
| T4 | V7 | `unknown_kid` row unlabelled | **Killed**: table test |

V6 is wording only, and no test pins it.

### Gates (live tree)

| Run | Result |
|---|---|
| `bun test test/auth test/admin` | **222 pass, 18 skip, 0 fail** (240 tests, 16 files) |
| same with `DATABASE_URL` (Podman Postgres) | **228 pass, 18 skip, 0 fail** (246 tests) |
| full `bun test` | **1375 pass, 150 skip, 1 fail** (1526 tests, 79 files). The one failure is `core-source` (known herdr-draw drift). The gateway "entries subject" and v1 pacing tests passed this run. |

### Housekeeping

- **Postgres:** Podman `postgres:17.11-alpine3.23`, id `b9d5caf68cb0`, on a random localhost port with a random password (never printed). Removed with `podman rm -f` on that id only, and checked gone.
- **Worktree:** the scratch worktree was removed and pruned.
- **No pkill or killall.** Every server used port 0.
- **Repo `.env`:** checked by key names only. It has no `DATABASE_URL`.

### Not verified

- **V7:** read from the code (`jwksCache.key`), not run.
- **Terminal rendering:** only bytes were checked, as in round 2.
- **Body reset against Google itself:** only a local `node:net` server.
- **V1 via `DATABASE_URL`:** a database name with DEL/RLO goes through the same escaped line, but I did not run it against Postgres this round (p5-tidyv did, on the old code).
- **Real-socket stall:** checked by a scratch probe, not a repo test. Headers plus a partial body, then silence, with a 300 ms timeout, gave `idp_timeout` for 200 and 500 (301 ms each). The repo test for this stays the synthetic `stalled()` stream.
- **Other platforms:** `resetAndDestroy` is used when present; on this Bun 1.4.4 it is, and plain `destroy` gives the same label.

**Gotcha I hit:** on two edits, a `\u2028\u2029` escape I typed reached the file as the raw characters. That broke
a regex literal ("Syntax Error"). The fix builds those regexes with `new RegExp(UNSAFE.source, "u")` and from a string.
The same thing turned a typed surrogate-pair escape in this report into a raw tag character, now fixed. A final
`grep -P '[\p{Cf}\p{Zl}\p{Zp}\x7f-\x{9f}]'` over the 8 job files and this report finds none, except one raw
character at line 73, in round 2's text, which I left alone.

**Design check:** not design-bearing. This round covers escaping, error labels, tests and a doc table, with no state,
messages or nodes.

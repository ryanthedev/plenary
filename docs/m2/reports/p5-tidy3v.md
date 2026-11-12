# Report: p5-tidy3v (verify p5-tidy round 3: V1-V8 from p5-tidyv)

**PASS, with LOWs. V1-V5, V7 and V8 are closed and checked by runs. V6 is not closed.** The new sentence at
`p5-google2.md:163` says "The causes p5-google2 added are produced in `signin-cause.test.js`". p5-google2 added
almost every label. No test anywhere in `test/` produces `bad_config`, `bad_expected`, `bad_time`, `bad_sub` or
`stale`, and the four extra RFC 6749 names appear only in a list. The sentence is still untrue: a doc wording slip,
graded LOW.

**The verdict hinges on that grade.** The brief's V6 check ("wording matches the code") fails, and the builder's
"Done when" asked for V1-V8 closed. PASS stands if the manager accepts V6 as open at LOW. Otherwise this is FAIL.

- **V1 (the `failed:` echo):** closed. DEL, C1, RLO, LS and a tag character reach stderr escaped via `--data-dir`,
  `PLENARY_DATA_DIR` and a `DATABASE_URL` database name (real Podman Postgres). Each line still parses as JSON, and
  HEAD's CLI still shows the raw bytes as a control.
- **V2/V3 (token answer labels):** closed. Round 2's `drop.js` now gives `idp_unreachable` for 200 and 500. Empty
  200/503 bodies give `bad_token_response`, as the table says. The timeout rows are unchanged.
- **V4 (truncation):** closed. No half escape. The closing quote always shows. A cut-off unsafe character is named.
- **V5 (label scan and table):** closed for what was asked. E8, E9, E11, E12 and E13 are now killed. Two narrower
  gaps remain (N2, N3).
- **Mutations:** 48 run, 42 killed, 6 survived. The 48 include the first cuts of G1 and G4, which I discarded and
  re-cut. All 6 survivors are probes of mine, not the builder's: R1d, R4b2, G1', G2, G3 and G4' (table below).
- **Ensemble:** codex found one LOW, the same gap as N2. grok found nothing.
- **Gates:** green apart from the known `core-source` failure, which is not this job's.

Nothing committed. No code, test or doc file was edited apart from this report. The job diff (8 files, `git diff
HEAD`) hashed `cb0085e1…7eee524d` at the start and at the end. That is the hash the builder reported.

## Findings

| # | Grade | Finding |
|---|---|---|
| N1 (V6) | LOW (doc; V6 not closed) | **`p5-google2.md:163` still claims more than the tests do.** It says "The causes p5-google2 added are produced in `signin-cause.test.js`". `git show 35d5f5a^:server/auth/oidc.js` contains none of `bad_config`, `bad_expected`, `bad_time`, `stale`, `bad_sub` or `unauthorized_client`, so p5-google2 added them. `grep -rn "bad_time\|bad_sub\|bad_config\|bad_expected" test/` finds nothing, and `"stale"` is not in signin-cause.test.js (only in unrelated sync tests). `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` and `invalid_request` appear in signin-cause.test.js only inside the RFC list, never as a produced cause. **Fix (wording):** "Most causes above are produced in `signin-cause.test.js`, and a test there checks the table lists every label the code can log." Or add cases that produce the missing labels. |
| N2 | LOW (test gap; codex agrees) | **The table test accepts a made-up example of a pattern row.** `signin-cause.test.js:321` (`instance`) accepts any `[a-z0-9_]+` suffix after `idp_error:` or `token_http_`. But http.js logs `idp_error:<name>` only for the 13 `AUTHORIZE_ERRORS`, and `token_http_` only with a 3-digit status. Mutations G2 (adds `` `idp_error:made_up_name` `` to a row) and G3 (adds `` `token_http_abc` ``) both survive. Today's table has no such entry. **Fix:** check an `idp_error:` example against `AUTHORIZE_ERRORS` (export it, or read it from http.js), and a `token_http_` example against `\d{3}`. |
| N3 | LOW (test gap) | **A note for an unsafe character at exactly code point 81 isn't pinned.** Mutation R4b2 (`at < SHOWN_MAX` changed to `at <= SHOWN_MAX`) survives. The tests cover an unsafe character at code point 80 (inside the cut) and at 87 and 91 (named), but not 81, the first one cut off. The code is right today: my probe of `"a"×80 + DEL` gives `…"… (U+007F at code point 81)`. **Fix:** add that case to the `shown` test at `tenants.test.js:~142`. |
| N4 | INFO | **The source scan sees only string literals written inside `no(` / `fail(` / `failed(` calls.** A new label held in a variable (`const l = "brand_new_label"; return no(l);`, mutation G1') or passed straight to `why?.(…)` in `verifyIdToken` (G4') survives every test. It would reach the log, because it passes http.js's `why` filter. This is the nature of a static scan, and nothing in today's code does either. The brief asked for `'…'`, `` `…` `` and multi-line calls, and those are covered. |
| N5 | INFO (follows from round 2's accepted decision; not in the builder's list) | **One more token-answer shape changed label:** a close-delimited body (no `content-length`, no chunking) cut short, then a clean close. It gave `idp_unreachable` at HEAD and gives `bad_token_response` now. With no length to check against, a body cut short this way can't be told apart from a whole answer that isn't JSON, so the new label is defensible. It follows from round 2's accepted rule (a whole answer that isn't JSON gives `bad_token_response`), not from round 3. Google sends a length or uses chunking. A body cut short against a declared length, or mid-chunk, still gives `idp_unreachable` (table below). |
| N6 | INFO (existed before this job) | **No test checks that the CLI strips a Postgres URL from a `failed:` message.** Mutation R1d (the `<url>` replace removed) survives. I couldn't make a real error carry the password: six bad `DATABASE_URL` shapes (wrong password, bad port, unknown host, bad IPv6, refused, bad `sslmode`) put no password marker on stderr. So this is an untested safety net, not a leak. The `sslmode` error echoes the operator's own query value, escaped. |

## V1: real stderr, `od -c` (live tree CLI, run from the scratchpad, no `.env`)

`v1.sh` greps `od -c` for DEL (`177`), C1 (`302 2xx/1[2-9]x`), `342 200 2xx` (bidi, LS/PS) and `363 240` (tags),
and checks that line 1 passes `JSON.parse`.

| Input | Exit | Raw byte? | JSON? | Shown as |
|---|---|---|---|---|
| `--data-dir /etc/passwd/x` + DEL | 1 | no | ok | `\u007f` |
| … + C1 CSI `\xc2\x9b2J` | 1 | no | ok | `\u009b2J` |
| … + RLO | 1 | no | ok | `\u202e` |
| … + ESC | 1 | no | ok | `\u001b[2J` |
| … + U+E0001 | 1 | no | ok | `\udb40\udc01` (surrogate pair, valid JSON) |
| … + LS | 1 | no | ok | `\u2028` |
| 200-char path + RLO | 1 | no | ok | whole path, then `\u202e` (the line is not cut) |
| `PLENARY_DATA_DIR` + RLO; + DEL NEL | 1 | no | ok | `\u202e`; `\u007f\u0085` |
| `DATABASE_URL` db `x%7Fy`, `x%E2%80%AEy`, `x%C2%9By`, `x%F3%A0%80%81y` (Podman Postgres) | 1 | no | ok | `database "x\u007fy" does not exist`, etc.; password marker absent |
| **Control:** HEAD's CLI (`git archive HEAD`), `--data-dir` + RLO DEL CSI; db `x%E2%80%AEy` | 1 | **yes** | — | raw, so the grep does catch raw bytes |

**Hex recheck (after review: `od -c` may decode C1, so the `302` pattern might never fire).** The check was rerun as
`LC_ALL=C od -An -tx1 err | tr -d '\n'`, with the whole stderr joined so no sequence straddles a line. It greps for
` c2 8x/9x`, ` 7f`, ` e2 80 8b/a8/a9/ae` and ` f3 a0`. Each case ran on the live CLI and on HEAD's:

| Input | Live | HEAD |
|---|---|---|
| `--data-dir` + C1 CSI only | clean | **RAW** |
| `--data-dir` + NEL only | clean | **RAW** |
| `PLENARY_DATA_DIR` + C1 CSI only | clean | **RAW** |
| `PLENARY_DATA_DIR` + RLO, DEL, U+E0001, LS | clean | **RAW** |
| `DATABASE_URL` db `x%C2%9By`, `x%C2%85y`, `x%7Fy`, `x%E2%80%AEy` (second Podman Postgres) | clean ×4, password absent | **RAW** ×4 |

So C1 is covered by a control that isolates it.

**Other CLI echoes:** I re-read every `err(`, `UsageError(` and `BootstrapError(` in the two files.
- **`${flag} needs a value`:** `flag` is always one of the three literal flags.
- **The `${domain}` in "not on the tenant's domain":** it has passed the `DOMAIN` regex.
- **Everything else:** goes through `shown()` or the escaped `failed:` line.

## V2/V3: token answers on a real `node:net` socket (`timeoutMs` 3000 unless noted)

| Answer | Round 2 (p5-tidyv) | Now | HEAD |
|---|---|---|---|
| 200, partial body, then reset (`drop.js`) | `bad_token_response` | **`idp_unreachable`** | `idp_unreachable` |
| 500, partial body, then reset | `bad_token_response` | **`idp_unreachable`** | `token_http_500` |
| 200, chunked, cut mid-chunk, then RST | — | `idp_unreachable` | `idp_unreachable` |
| 200 / 500, short of `content-length`, then a clean close | — | `idp_unreachable` | `idp_unreachable` / `token_http_500` |
| 200, close-delimited, cut short | — | `bad_token_response` (N5) | `idp_unreachable` |
| empty 200 / 503, `content-length: 0` | `bad_token` / `token_http_503` | **`bad_token_response`** | `bad_token` / `token_http_503` |
| empty 200 / 503, chunked | — | **`bad_token_response`** | same as above |
| headers late; 200 or 500 body stalls (`l2.js`, 500 ms) | `idp_timeout` | `idp_timeout` (500-501 ms) | — |
| 200 HTML, 502 HTML | `bad_token_response` | `bad_token_response` | — |
| 400 `invalid_grant`; 400 unknown error; 500 JSON no error | `invalid_grant`; `token_http_400`; `token_http_500` | same | — |
| 200 `null`, 200 `[1]` | `bad_token` | same | — |
| refused, DNS failure | `idp_unreachable` | same | — |

- **Rows that moved:** only the reset rows (V2), the empty-body rows (V3) and N5.
- **Table check:** the empty-body label matches the `bad_token_response` row ("an empty answer included").
- **No leak:** each probe body carried a `SECRET-…` marker. No label contained it or the odd error name.

## V4: `shown` truncation (live tree)

| Input | Ends with | Half escape? |
|---|---|---|
| `normAdmin("dev:" + a×70 + RLO)` | `…a\u202e"` | no |
| `normAdmin("dev:" + a×100 + RLO)` | `…a"… (U+202E at code point 105)` | no |
| `normAdmin(a×77 + U+E0001)`; `a×79 + U+E0001` | `…a\u{e0001}"` | no |
| `normAdmin(a×80 + DEL)` | `…a"… (U+007F at code point 81)` | no |
| `normDomain(a×100 + ".com" + DEL)` | `…a"… (U+007F at code point 105)` | no |
| RLO ×100 | 80 × `\u202e`, then `"…` | no |
| a×90 + lone `\ud800` | `…a"…` (no note: a lone surrogate isn't in `UNSAFE`, and it was cut) | no |

## V5: scan and table

- **The table test reads the real doc:** `signin-cause.test.js:310` parses `p5-google2.md` section (e). T1-T4
  (doc mutations) fail it.
- **Both directions:** source labels are checked against the lists, and the lists against the source, so E12 and
  E13 are killed.
- **Remaining gaps:** N2 and N4.

## V6-V8: wording against the code

| # | Verdict | Evidence |
|---|---|---|
| V6 | **Not closed** (N1) | See N1. |
| V7 | **Closed, and confirmed by a run** | `v7.js`: a token signed by the fake IdP's `k1`, with the key fetch throwing (`TypeError`) or answering 503, gives `["unknown_kid"]`. With the key endpoint up, sign-in succeeds. That matches the new row ("Google's key endpoint couldn't be reached"). |
| V8 | **Closed** | `p5-google2.md:127` lists `idp_error:server_error`, `idp_error:temporarily_unavailable` and `idp_error:login_required`. T3 (a bare example) is killed. |

The other rows that changed match the code:
- **`idp_unreachable`:** "dropped before its whole answer arrived" (`oidc.js:255-256`).
- **`bad_token_response`:** "arrived whole … an empty answer included" (`:257`).
- **`token_http_<n>`:** "error status `<n>` and no standard error name" (`:261`).

## Mutations

The scratch worktree was HEAD plus `job.diff` (sha256 `cb0085e1…`), with `node_modules` linked. `mut.js` applies
one exact edit (it must match once), runs the named tests and restores the file. Postgres was on for X5.

**Round 2's mutations:** the 20 that still apply to the new code were rerun. All were killed.

| Id | Result | | Id | Result |
|---|---|---|---|---|
| X5 (pg) | Killed (memory, sqlite, postgres) | | E2 | Killed |
| M1 | Killed | | E3 | Killed |
| M2 | Killed | | E5 | Killed |
| M3 | Killed | | E6 | Killed |
| M4 | Killed | | E7 | Killed (scan) |
| M7 | Killed | | **E8** | **Killed** (scan; survived in round 2) |
| M8 | Killed | | **E9** | **Killed** (scan; survived in round 2) |
| M9 | Killed | | E10 | Killed (scan) |
| E1 | Killed | | **E11** | **Killed** (scan; survived in round 2) |
| **E12** | **Killed** (reverse scan + table; survived in round 2) | | **E13** | **Killed** (reverse scan + table; survived in round 2) |

**Re-cut to the new code, the builder's set (by my own edits), and my own probes:**

How these map to the builder's ids:
- **Same edit:** the builder's R2d (body-read failure labelled `bad_token_response`) is the same edit as round 2's
  E5, rerun above.
- **Replacements for round 2's M6c/M6d:** those two branches are gone. R2b and R2f take their place.
- **Not rerun:** the builder's R2 (the whole round-2 block restored) and E9b (a template label in http.js). M6',
  M6b', R2b, R2c and R2e cover R2's ground piece by piece. E9b's shape is pinned by the scanner's own `x_<>_z`
  assertion, which I read but did not mutate.

| Id | Mutation | Result |
|---|---|---|
| M5' | `shown` cuts by UTF-16 unit (`split("")`) | Killed (2) |
| E4' | no truncation | Killed (2) |
| M6' | 2xx non-JSON gives `idp_unreachable` | Killed (2) |
| M6b' | non-2xx non-JSON gives `token_http_<status>` | Killed (2) |
| R1 | `failed:` line not escaped | Killed (CLI process test) |
| R1b | escaped, but astral as `\u{…}` (bad JSON) | Killed |
| R1c | escape only the bad-request branch | Killed |
| R1d | no `<url>` redaction | **Survived** (N6, pre-existing) |
| R2b | body read moved into the parse `try` | Killed (2) |
| R2c | empty body read as `null` | Killed (2) |
| R2e | empty non-2xx gives `token_http_<status>` before the parse | Killed (2) |
| R2f | timeout recognised as `AbortError` only | Killed (stalled-body cases) |
| R4 | escape first, then cut (round 2) | Killed (2) |
| R4b | no note | Killed |
| R4b2 | note dropped for code point 81 (`<=`) | **Survived** (N3) |
| R4c | no `…` | Killed (2) |
| R4d | note index 0-based | Killed |
| T1-T4 | table: `mint_failed` row, phantom, bare example, `unknown_kid` | Killed, each |
| G1' | extra label held in a variable | **Survived** (N4) |
| G2 | table: `` `idp_error:made_up_name` `` | **Survived** (N2) |
| G3 | table: `` `token_http_abc` `` | **Survived** (N2) |
| G4' | extra label via `why?.()` in `verifyIdToken` | **Survived** (N4) |
| G5 | the note stripped for `normDomain` only | Killed |

My first G1 and G4 replaced an existing label. They were killed, but only by the reverse scan, so I re-cut them as
additions (G1', G4').

## Gates

| Run | Result |
|---|---|
| `bun test test/auth test/admin`, live tree, no `DATABASE_URL` | **222 pass, 18 skip, 0 fail** (240 tests, 16 files) |
| same, scratch worktree with `DATABASE_URL` (Podman Postgres 17.11) | **228 pass, 18 skip, 0 fail** (246 tests) |
| full `bun test`, live tree | **1375 pass, 150 skip, 1 fail** (1526 tests, 79 files). The failure is `packages/core is still herdr-draw's core`: the known herdr-draw drift, not this job's. The gateway "entries subject" and v1 pacing tests passed. |

These counts match the builder's Round 3 gate table exactly.

## sdd ensemble review

- **agy:** `check_adapter` failed ("Individual quota reached… Resets in 50h"). Not used.
- **codex** (`effort: high`, own scratch worktree): VERDICT FAIL on one LOW. The table test accepts `idp_error:made_up`.
  - **Confirmed** by G2 (survives). Graded LOW as N2. It is a test gap with no wrong row in today's table, so I don't
    read it as a FAIL.
  - codex said its listener-based tests hit sandbox socket-bind limits. That is its environment; my gates ran them.
- **grok** (own scratch worktree): PASS, no findings.
  - It said the scan and table tests "catch phantom entries". G2, G3, G1' and G4' refute that in part.
  - It missed N1.
- **Agreement:** codex and I agree on N2. No two harnesses agreed on anything at HIGH or MEDIUM.

## Nothing logged leaks

- **New log calls:** this diff adds one, `failed("mint_failed")`, a fixed string.
- **Token exchange:** the body text is only parsed, never logged. Every label is a fixed string or an
  allow-listed RFC name.
- **Real-socket probes:** no label carried the `SECRET-…` marker or the `weird_…` error name.
- **CLI stderr:** no password from `DATABASE_URL` appeared in any probe (N6).

## Design check

Not design-bearing (escaping, error labels, tests, a doc table: no state, messages or nodes). No CHECKER pass
needed, as in round 2.

## How this was run; cleanup

- **Scratch worktrees:** `wt` (mutations, the Postgres gate), `rev` (codex) and `rev2` (grok). Each was HEAD plus
  `job.diff`. All were removed (`git worktree remove --force`, then `prune`). The other worktrees `git worktree list`
  shows belong to other sessions and were left alone.
- **HEAD copy:** `head/`, made by `git archive HEAD scripts server packages`, for the controls.
- **Postgres:** Podman `postgres:17.11-alpine3.23`, run twice: id `a4300ba1e527` (probes, mutations, gate), then
  `0d80a271dfc0` (the hex recheck). Each was on a random localhost port with a random password (never printed),
  removed with `podman rm -f` on its own id only, and checked gone.
- **No pkill or killall.** Every probe server listened on port 0 and was closed.
- **`git stash list`:** empty.
- **Scripts:** in `/private/tmp/claude-501/-Users-r-repos-plenary/6bce3f80-ffc5-404d-ab82-42a41480a473/scratchpad/`:
  `v1.sh`, `v3.js`, `v4.js`, `v7.js`, `drop.js`, `l2.js`, `mut.js`, `gen3.js`, `gen4.js`, `muts-old.json`,
  `muts3.json`, `muts4.json`, plus the outputs `mut-old.txt`, `mut3.txt`, `gate1.txt`, `gate2.txt` and `full.txt`.
- **Gotcha (same as the builder's):** a `\u2028` I typed into a heredoc reached the file as the raw character, and
  the regex failed to parse. `\p{Zl}\p{Zp}` avoids typing the escape at all.

## Not verified

- **Terminal rendering:** only bytes were checked.
- **Google itself:** resets, empty bodies and key-endpoint outages were tried only against local servers.
- **`mint_failed` from a real failure:** the only evidence is the builder's stub, as in round 2.

## Suggested fixes (for the manager to brief; none made)

1. **N1:** reword `p5-google2.md:163` to "Most causes above…", or add cases that produce `bad_config`,
   `bad_expected`, `bad_time`, `stale`, `bad_sub` and the four RFC names.
2. **N2:** in the table test, accept an `idp_error:` example only from `AUTHORIZE_ERRORS`, and a `token_http_`
   example only with 3 digits.
3. **N3:** add `shown("a".repeat(80) + DEL)` with the expected `(U+007F at code point 81)`.
4. **N4, N6:** optional. N6 needs one CLI test whose driver error carries the URL.

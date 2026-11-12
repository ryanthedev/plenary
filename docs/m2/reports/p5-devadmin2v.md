# Report: p5-devadmin2v (verify p5-devadmin2: tenant-admin hardening)

**PASS, with LOWs only.** Fixes 1-4 do what the builder claims. Every privilege-escalation probe was refused, and
all 7 of the builder's mutations reproduce exactly (memory, SQLite and Postgres 17.11). Gates are green except the
known `test/core-source.test.js` failure.

**One sub-claim is refuted (LOW):** the claim that error output "escapes the entry" holds only for C0 controls.
DEL, C1 controls and Unicode format characters (bidi overrides, zero-width, soft hyphen) reach stderr raw.

Nothing was committed, and no code or test file in the live tree was changed. Mutations ran in a scratch worktree
at HEAD plus the five job files. After every scratch worktree was removed, `git diff HEAD` of the five files was
byte-identical to the pre-run snapshot (`cmp` → `LIVE-UNCHANGED`).

**One breach of the scratch-only rule:** a temporary probe file, `test/admin/zz-verify-probe.test.js`, sat in the
live `test/admin/` for two runs, a few minutes in all, while p5-google2 was working in the same tree. Nothing
imports it. I deleted it, and `git status --short test/admin` afterwards showed only the two job files. Later
probes ran from the scratchpad.

## Findings

| # | Grade | Finding |
|---|---|---|
| F1 | LOW | **Raw DEL, C1 and format characters reach stderr.** `server/admin/tenants.js:52`: `shown = JSON.stringify(a)`, but `JSON.stringify` escapes only U+0000-U+001F, `"` and `\`. The entry is still refused (exit 2), but its bytes go to the terminal raw. Seen with `od -c`: `dev:ann\x7f` printed byte 177; `dev:ann\u009b2J` printed `302 233 2 J`, which is UTF-8 C1 CSI, read as an escape sequence by some terminals; `dev:ann‮` printed `342 200 256` (RLO, right-to-left override). BEL and ESC were escaped. The CLI test (`test/admin/devadmin.test.js:99`) checks only `\u0007`, so it cannot catch this. codex (high effort) raised the same finding independently, citing U+200B and U+0085. **Impact is low:** the bytes come from the operator's own argv. **Fix:** escape every `\p{Cc}\p{Cf}` (and U+2028/2029) in `shown`, e.g. `.replace(/[\p{Cc}\p{Cf}  ]/gu, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))`, and add `\u007f`, `\u009b` and `‮` cases to the CLI test. |
| F2 | LOW (existed before this job) | **`unknown argument: ${flag}` prints the flag raw.** At `scripts/admin-bootstrap.js:42` (the same line at HEAD), `bun scripts/admin-bootstrap.js $'--nope\x1b[2J'` wrote `033 [ 2 J` to stderr. `normDomain`'s error has F1's gap too: `--domain $'acme.com\x7f'` wrote `not a domain: "acme.com 177"` (raw DEL; seen with `od -c`). This is not a regression, but it falls under the brief's "no raw control bytes to the terminal" intent. Fix it together with F1 (one shared `shown()` helper). |
| F3 | LOW (test gap) | **The trim-before-check claim is untested.** The report says a leading or trailing tab or newline is now refused, because the control check runs on the untrimmed input. Mutation X5 (check the trimmed `s` instead of `a`) **survives** on all three adapters. The behaviour is as claimed, but nothing pins it. Add `"alice@acme.com\n"` or `"\tdev:ann"` to the refusal list in `test/admin/tenants.test.js:93`. |
| F4 | INFO | **Some odd inputs are silently normalised, not refused.** None of these is an escalation, because the operator supplies them and a Google-vouched email can't match them. `U+2028` at either end is trimmed, so `alice@acme.com ` becomes `email:alice@acme.com`. A Kelvin sign `Kate@acme.com` lower-cases to `email:kate@acme.com`. `email:EMAIL:x@acme.com` is stored as `email:email:x@acme.com`. A private-use character (`google:1`) is accepted. The caller side mirrors the Kelvin case: a `google:7` caller with email `Kate@acme.com`, domain `acme.com`, **matches** `email:kate@acme.com`, because `normEmail` lower-cases. This needs Google to vouch that address, which `authoritativeEmail` won't do for anything but a real Workspace address on `hd`. M6 could use a stricter allowlist for `google:<sub>` (Google subs are digits). |
| F5 | INFO | **Mutation X1 survives (harmless).** Changing the guard to `startsWith("google")` (no colon) survives. No verifier mints a `google…` user id without the colon: `server/auth/dev.js:21` always mints `dev:`, and sessions carry only what `/auth` issued from Google (`server/auth/http.js:242`). |

## Claims checked

| Claim | Verdict | Evidence |
|---|---|---|
| **Fix 1:** `--admin` required; exits 2 before opening a store | **Confirmed** | `bun scripts/admin-bootstrap.js --domain acme.com` with `PLENARY_DATA_DIR=<scratch>/cli-data` printed `--admin is required (at least one)` plus usage, `exit=2`. Afterwards `ls <scratch>/cli-data` gave "No such file or directory". The test cases `["--domain","acme.test"]` and `["--domain=acme.test","--data-dir",dir]` assert exit 2, no stdout and no `registry.db`. Mutation M1 kills them. |
| **Fix 2:** `email:` admin entries match only `google:` callers with the same hd | **Confirmed** | Probe results are in the table below. Only `google:` callers with a vouched email on the tenant's domain matched. |
| **Fix 3:** the formerly vacuous test is real | **Confirmed** | The tenant now holds `email:alice@acme.com` (asserted at `test/admin/tenants.test.js:144`). Mutation M3 (drop the `email:` user-id guard) fails exactly that test. |
| **Fix 4:** off-domain and control/format entries are refused in the CLI and in `bootstrapTenant`; nothing is created | **Confirmed** | `bootstrapTenant` refuses and `tenantByDomain` stays null (memory, SQLite, Postgres). CLI: exit 2 and no `registry.db`. M4a-d kill. |
| **Fix 4:** error output escapes the entry | **Partly refuted** | See F1. C0 is escaped; DEL, C1 and Cf are not. |
| **No regression:** `dev:` and `google:<sub>` admins still match; bootstrap idempotent and additive | **Confirmed** | Probe: `dev:ann` and `google:42` both got `true`. Existing idempotent, additive and race tests pass on three adapters. X7 (user-id path limited to `google:`) is killed by the main.js dev-admin test, so `dev:` admins are pinned. |
| **Builder's mutation table** | **Confirmed**, every row | My table is below. |
| **Design check skipped** (not design-bearing) | **Agree** | This is input validation plus a predicate over the existing Registry port. It adds no state, messages or nodes. |

### Fix 2 probes

Memory registry. The tenant is `acme.com` with admins `email:alice@acme.com`, `dev:ann` and `google:42`. The check
is `createBoard`, and "admin?" means it did not throw `forbidden`. The scratch test was deleted after the run.

| Caller (user · email · domain) | Admin? |
|---|---|
| `dev:alice` · alice@acme.com · acme.com (dev token claiming the email) | no |
| `dev:alice` · ALICE@ACME.COM · acme.com | no |
| `email:alice@acme.com` · alice@acme.com · acme.com (email-prefixed user id) | no |
| `EMAIL:alice@acme.com` · … · acme.com | no |
| `google:7` · alice@acme.com · **evil.com** (another hd) | no |
| `google:7` · alice@acme.com · null (no hd: gmail or a share-link guest) | no |
| `google:7` · alice@acme.com · `acme.com.` (trailing dot) | no |
| `google:7` · alice@acme.com · `ACME.com` (uppercase hd)¹ | no |
| `google:7` · `alice＠acme.com` (fullwidth @) · acme.com | no |
| `google:7` · `alice@xn--acm-bma.com` (punycode) · acme.com | no |
| `google:7` · null · acme.com (unvouched) | no |
| `google:99` · bob@gmail.com · null (share-link or invite guest) | no |
| `google:7` · alice@acme.com · acme.com (vouched, same hd) | **yes** (intended) |
| `google:7` · `" Alice@ACME.com "` · acme.com | **yes** (normEmail trims and lower-cases; Google vouched it) |
| `dev:ann` · — | **yes** (regression check) |
| `google:42` · — | **yes** (regression check) |
| `dev:ANN`, `google:42 ` (case or space variants of a user-id admin) | no |

¹ An uppercase hd can't happen in practice: `oidc.js` lower-cases `hd` before it builds the Identity.

**Share links and invites mint no identity of their own.** Only `server/auth/dev.js:21` (`dev:`) and
`server/auth/oidc.js:179` (`google:`) mint user ids. I traced the session path in the code:

- **Issue:** the bearer verifiers are `[sessions, dev]` (`http.js:131`). A session is issued only in `exchange`
  (`http.js:242`), from the identity in the HMAC-signed exchange cookie (`openXchg`, `http.js:214-228`).
- **Cookie origin:** that cookie is minted only by `mintCode` (`http.js:288`), whose identity comes from
  `oidc.finish(...)` (`http.js:282`).
- **What `oidc` is:** `server/main.js` wires `oidc` as `googleOidc` (`main.js:46,121`).

So a session's `google:` user always carries Google's `authoritativeEmail` and `hd`, and a link or invite caller is
one of the rows above. The fake IdP in `scripts/dev-google.js` (p5-google2's, dev-only) was not checked.

**No other reader of `email:` entries:** `grep -rn 'admins\|"email:"\|`email:' server` (excluding
`admin/tenants.js` and the registry adapters) finds only `boards.js:46-49` matching `email:` entries. `main.js`
bootstraps `dev:` names only. `tenancy.js:193-194` documents that `admins` is never served from its memo.

**Bootstrap-side normalisation** (`normAdmin(x, "acme.com")`):

| Entry | Result |
|---|---|
| `alice@ACME.COM` | lower-cased |
| `alice@acmé.com`, `alice@xn--acm-bma.com`, `alice@acme.com.`, `alice@acme。com` | refused, off-domain |
| `alice＠acme.com`, `x@y@acme.com`, `@acme.com`, `email:` | refused, not an admin name |
| `dev:ann‮`, `alice@ACME.com­` | refused, control character |

## Mutations

Each mutation was applied alone in a scratch worktree, followed by `bun test test/admin`, then the file was
restored. Script: `/private/tmp/claude-501/-Users-r-repos-plenary/741857b0-c0e7-4bb8-ad18-c2491d2c6dc6/scratchpad/mut.py`.
The unmutated baseline was 23 pass, 0 fail (no Postgres) and 29 pass, 0 fail (Postgres).

**Builder's rows (all reproduced):**

| # | Mutation | Fails (memory + SQLite) | With Postgres |
|---|---|---|---|
| M1 | drop `--admin` required | 1: CLI bad arguments | 1 |
| M2 | drop the `google:` guard | 1: dev token claiming the vouched email | 1 |
| M3 | drop the `email:` user-id guard | 1: email entry never matches by user id | 1 |
| M4a | domain check off | 4 | 5 |
| M4b | control check off | 3 | 4 |
| M4c | CLI `normAdmin(a)` without domain | 1: CLI off-domain | 1 |
| M4d | `bootstrapTenant` without domain | 2 | 3 |

**Mutations I added:**

| # | Mutation | Result |
|---|---|---|
| X1 | `startsWith("google")` without the colon | **survives**: harmless (F5) |
| X2 | drop `caller.domain === t.domain` | killed (1) |
| X3 | domain compare via `endsWith` (subdomain accepted) | killed (2 / PG 3) |
| X4 | control class `\p{Cc}` only (Cf allowed) | killed (2 / PG 3) |
| X5 | control check on the trimmed `s` | **survives** (F3) |
| X6 | CLI skips admin pre-validation | killed (2) |
| X7 | user-id path limited to `google:` (breaks `dev:` admins) | killed (2, including main.js `start(env)`) |
| X8 | `shown` not JSON-escaped | killed (2) |
| X9 | email path ignores the admins list | killed (1) |

## Gates

| Run | Result |
|---|---|
| `env -u DATABASE_URL bun test test/admin test/auth` | 210 pass, 18 skip, 0 fail |
| `env -u DATABASE_URL bun test` | 1288 pass, 1 fail: `packages/core is still herdr-draw's core` (known, unrelated) |
| `DATABASE_URL=… bun test test/admin test/auth` | 216 pass, 18 skip, 0 fail |
| `DATABASE_URL=… bun test test/admin` | 29 pass, 0 fail (no skips) |
| `DATABASE_URL=… bun test` | 1395 pass, 44 skip, 1 fail: the same core-source test |

- **Postgres:** Podman `docker.io/library/postgres:17` (PostgreSQL 17.11), trust auth, `127.0.0.1:36203` assigned
  by Podman. Container id `3d796d55903c7206814241fb33f8a89a39835b029e5cea80e1bb400209fdc45b`, removed with
  `podman rm -f <that id>`. No other container was touched.
- **Clean-HEAD check:** a worktree at HEAD (479cf46) plus only the five job files gave `test/admin` 23 pass,
  0 fail. No other failures appeared that needed it.

## Ensemble review (sdd)

| Harness | Result |
|---|---|
| codex (effort high), in its own scratch worktree | `VERDICT:` one LOW, the same as F1 (raw U+200B and U+0085 on stderr). Agreement with my independent finding makes F1 confirmed, still graded LOW. |
| agy, in a second scratch worktree | **failed**: empty output. `check_adapter("agy")` then gave `RESOURCE_EXHAUSTED (429) Individual quota reached … Resets in 51h22m`. |
| kimi | `check_adapter`: failed, "No model configured". Not dispatched. |
| grok, in a third scratch worktree | `VERDICT: Clean`, no findings. **It is wrong on F1:** it says `JSON.stringify` keeps raw control bytes off stderr, which the `od -c` evidence refutes for DEL, C1 and Cf. It is otherwise consistent with my probes. |

All scratch worktrees were removed afterwards. None of the reviewers changed a file: each worktree showed only the
5 job files plus `REVIEW.diff`.

## Not verified

- **Live Google sign-in** against a running server (p5-google2's job). The Google side was exercised only through
  hand-built Identity objects, not real ID tokens.
- **Rendering in a real terminal:** I did not check how an actual terminal renders the raw C1 and bidi bytes from
  F1. The bytes were confirmed with `od -c` only.
- **agy:** produced no review (out of quota).
- **`scripts/dev-google.js`'s fake IdP** (p5-google2's file): not checked to see whether it can mint `google:`
  users with arbitrary emails. Being dev-only, it is outside this job.

## For the manager

- **Landable as is.** F1 and F2 are one small follow-up: a shared escape helper for every echoed argument in the
  CLI and `tenants.js`, plus three test cases. F3 is one extra test entry. None of them blocks.

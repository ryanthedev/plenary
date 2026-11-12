# Brief: p5-google2v (verify p5-google2: Google sign-in on the real server, scripted up to the CEO's login)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values, tokens, cookies, codes or id_tokens; no
`cat .env`. No pkill/killall. Do not sign in to Google (that is the CEO's step). Do not edit code; do not commit.
Scratch data dirs and copies in your scratchpad. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Stop at
60% context after writing what you have.

## Job under check

Builder t1hm ran p5-google2 (brief docs/m2/briefs/p5-google2.md; report docs/m2/reports/p5-google2.md, hand-off at
"## Hand-off: the CEO's login"). Read its claims as claims. Its files (uncommitted): server/auth/http.js,
server/auth/oidc.js, scripts/dev-google.js, test/auth/{google-live-server,port-busy,signin-cause}.test.js. Diff
against HEAD. scripts/admin-bootstrap.js and server/admin/* belong to p5-devadmin2 (also uncommitted, under its own
verifier); the hand-off uses that CLI, so check the hand-off against the CLI as it is in the tree now.

## Check

- **Live test:** run `PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live-server.test.js` yourself (port 8080 must be
  free; it refuses otherwise). Confirm each scripted check is real: /auth/login 302 params and cookie flags, Google's
  sign-in page reached, wrong-secret control (`invalid_client`) beside bogus code (`invalid_grant`), WS hello with
  no/bad token refused, log scan finds no secret. Mutate the test's own assertions mentally or in a scratch copy:
  would it fail if a check silently passed?
- **Cause logging:** a failed callback logs one fixed label; no state, nonce, code, cookie, error_description or body
  can reach the log (try crafted IdP responses and query strings with the fake IdP). The IdP port contract
  (`finish` returns Identity | null) is unchanged for every other caller.
- **Default logger:** http.js writes to stdout when no `log` is passed. Is that consistent with server/log.js's format,
  and does it double-log or leak anything in the real server?
- **portBusy:** silent listeners on 127.0.0.1 and ::1 read busy; a free port reads free; no hang.
- **Hand-off section:** walk every step before the Google login against a scratch data dir exactly as written (with
  placeholder domain/email you choose). Steps must work with the current admin-bootstrap CLI (`--admin` now required;
  `email:` admins must be on the tenant domain and match only Google sign-ins). Clear for a non-expert, says what
  success looks like (POST /boards, board opens, stroke survives reload), how to tell failure causes apart, how to
  stop and clean up. Flag anything that would leave the CEO stuck.
- **Mutations:** redo the builder's mutation table; add any it missed.
- **Gates:** `bun test test/auth test/admin`, full `bun test` without DATABASE_URL. Known unrelated:
  test/core-source.test.js. Check any other failure against a clean HEAD worktree plus these files.

## Done when

docs/m2/reports/p5-google2v.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs
(minus secrets), each claim confirmed or refuted. Then stop.

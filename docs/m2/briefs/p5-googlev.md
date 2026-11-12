# Brief: p5-googlev (verify p5-google)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-googlev.md, PASS or FAIL with HIGH/MEDIUM/LOW. Change nothing in the tree. Never pkill/killall;
kill only PIDs you recorded.

## Job under check

Goal: prove sign-in works with the CEO's real Google OAuth client (Omniping, redirect
http://localhost:8080/auth/callback, consent External in Testing) as far as a script can go, so a human login is the
only step left. Brief: docs/m2/briefs/p5-google.md. Files: `scripts/dev-google.js`, `test/auth/google-live.test.js`
(both new, untracked).

**Secrets: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in .env (gitignored, 0600). Never print, log, echo or paste them,
or any URL carrying the client id unredacted. No `cat .env`. Compare in-process only.**

Builder's not-verified list and risks (not its claims): no real login (ID token signature/aud/nonce/email rules only
against the fake IdP); Safari/Firefox with the `__Host-` Secure cookie on http://localhost untested; Google's
cross-site redirect back not exercised; replay of a real code and Google's rate limits untested; the replay-guard
cap (100k per process, 10 min) sits at the join NFR.

## Check

- Run the live check yourself: `PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live.test.js`; and that the normal
  `bun test` skips it (name failing tests if any full run fails). Can the live test pass while sign-in is broken
  (e.g. would it notice a wrong redirect_uri, a missing PKCE param, Google's 200 error pages)?
- **Secret safety, adversarially:** the harness's logs, error paths (bad env, port busy, Google down, a throw),
  responses, `/whoami`, `/signed-in`, test output on failure (do assertion messages print the client id?). Scan the
  tree and your own outputs for both values in-process.
- The harness: 127.0.0.1 only; refuses a busy port; is it clearly not the product server; anything in it that would
  mislead the human-login steps? Read the hand-off steps as the CEO would.
- Systems design: run `distributed-systems-design` in CHECKER mode on the builder's failure table and bottlenecks (if
  not in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md).
- Skip the sdd ensemble unless you find something you want a second opinion on (secrets must never reach a harness:
  if you use one, it gets only the two files, never .env). Then stop.

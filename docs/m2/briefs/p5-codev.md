# Brief: p5-codev (verify p5-code)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-codev.md, PASS or FAIL with HIGH/MEDIUM/LOW. Change nothing in the tree; scratch work in your
scratchpad. Never pkill/killall; port 0; kill only PIDs you recorded. Never print values from .env.

## Job under check

Goal (proxy, from a MEDIUM security finding): the sign-in callback put the long-lived session token in the URL
fragment, which Chrome keeps in on-disk History. **No long-lived token in any URL.** The fragment carries a short-lived
(≤ 60 s), single-use code bound to the browser that ran the login; `POST /auth/exchange` turns it into the token. Must
work when callback and exchange hit different nodes. Required tests: replayed code refused, expired code refused,
wrong origin refused. Added: p5-googlev MEDIUM 2: an anonymous client must not be able to fill the replay guard and
lock out sign-in. Brief: docs/m2/briefs/p5-code.md. Client contract: docs/m2/contracts/auth-exchange.md (client's
file). Diff: `git diff -- server/auth/http.js test/auth/` plus untracked test/auth/exchange.test.js.

Builder's not-verified list and risks (not its claims): read the "Risks" and not-verified sections of
docs/m2/reports/p5-code.md yourself (one-origin requirement; parallel sign-ins; `exp` decoded from session.js's token
format; the cookie carries a signed identity payload instead of a bare binder).

## Try to break it

- Exchange: replay (same node, other node), expiry at 60/61 s, missing/foreign/`null` Origin, code without cookie,
  cookie from another login, tampered cookie/code, a session token or login cookie presented as the exchange cookie,
  wrong content type/body, huge body, other methods. One error for every invalid code (no oracle, timing included?).
- Leaks: no token or identity in any URL, Location, log line or error; `no-store` everywhere; the cookie attributes.
- Lockout: can an anonymous client still lock out real logins (bogus callbacks, valid-state callbacks, exchange
  spam filling the used-code set)? Does a replayed successful callback stay refused?
- Contract: does the 200 body match docs/m2/contracts/auth-exchange.md exactly (types incl. null rules)?
- Hexagonal: test/auth/architecture.test.js still passes; no new adapter imports.
- Full `bun test` (name failing tests if any: `bun test 2>&1 | grep -E '\(fail\)'`).
- Run `distributed-systems-design` in CHECKER mode on the cross-node design (if not in your skill list, read
  /Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md); report what it found.
- sdd ensemble review of the diff (codex + agy + any harness passing check_adapter; never give them .env). Two agreeing
  = HIGH candidate; confirm or refute. Then stop.

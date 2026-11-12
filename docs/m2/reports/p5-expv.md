# Report: p5-expv (verify p5-exp)

Verifier for manager platform (t187), 2026-11-12. Nothing in the tree changed.

## Verdict: PASS (no HIGH, no MEDIUM; 3 LOW)

`sessions().verify()` returns `exp` as integer seconds equal to the token's own, the Auth port passes it through,
the exchange's 200 body is unchanged, and a real session token's connection is closed by engine's gateway at `exp`
(run end to end below).

## Checks

| Check | Result | How |
|---|---|---|
| `exp` is integer seconds and equals the token's | PASS | session.js `issue` sets `exp = floor(now/1000) + ttlSec`; `verify` returns `c.exp` unchanged and requires `Number.isInteger`. `ttlSec` must be a positive integer, so `exp` always is. port.test.js pins the exact value |
| No `exp` for an invalid or expired token | PASS | every refusal path returns `null` (not an Identity), so there is nothing to carry `exp` |
| Dev tokens behave as the port says | PASS | dev.js unchanged; the key is omitted (`"exp" in dev === false`, port.test.js) |
| A caller can't get a session's identity without `exp` silently | PASS, with one LOW | the only `verify` callers are the gateway (via `authPort`, passes the object through), the exchange (503 if `exp` isn't an integer) and the admin bearer `caller()` (gets `exp` too; the admin use cases read only `.user`). tenancy.js reads only `user/email/domain`; nothing stores the whole object |
| Exchange 200 body matches auth-exchange.md | PASS | still `{token, user, name, email, domain, exp}`; exchange.test.js now asserts exactly those six keys |
| End to end with engine's gateway | PASS | see below |
| test/auth/architecture.test.js | PASS | 11 pass, 0 fail |
| Full suite on main | PASS | `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`: 633 pass, 78 skip, 0 fail |
| `distributed-systems-design` CHECKER | not run | the brief scopes the design to one line (dev tokens: no `exp`, no timer); that line is in idp-port.js and is consistent with p2's gateway |
| sdd ensemble | skipped | nothing found that needed a second opinion (brief allows skipping) |

## End to end (scratch copy of the p2-land worktree)

- **Setup:** copied `/Users/r/repos/plenary-p2` (no .git) to my scratchpad and applied `git diff -- server/auth test/auth`.
  The patched files are identical on main and p2-land, so it applied cleanly.
- **Test:** p2's `rig()`, with `verify` replaced by a real `authPort({ sessions: sessions({ ttlSec: 2 }), tenancy })`.
  It issued a real `s1.` token for `dev:editor` and sent a hello.
- **Result:** the client was welcomed, then closed with 1008 and `{t:"error", code:"auth", message:"your sign-in expired"}`
  at 1794470007.003 s, against `exp` = 1794470007. A second hello with the same token after expiry got
  `not allowed` (1008), because session.js returns null.
- **Clock:** the gateway takes `now` for the delay but uses a real `setTimeout`, so this ran on real time (about 2 s).
- **Same copy, wider:** `test/auth` plus p2's `test/server/v1.test.js` and `gateway.test.js` gave 190 pass and 2 fail.
  The 2 failures are `an unreachable Google never prints the client id > refused` and `> no such host`. They fail
  the same way on UNPATCHED p2-land (run read-only there), so they predate this diff and aren't caused by it.
- **p2 worktree untouched:** `git status` shows the same 19 entries as before.
- **Scratch copy NOT removed:** the sandbox refused `rm` twice. It lives in this session's scratchpad
  (`/private/tmp/claude-501/-Users-r-repos-plenary/dfc0c96e-d81a-41a3-b9a5-fe16476818d6/scratchpad/p2copy` and
  `p5-exp.diff` beside it), outside every repo, and is session-scoped temp space. Delete it by hand if wanted.

## Findings

- **LOW: the Verifier contract can't tell "forgot exp" from "has no expiry".** An adapter declares expiry by returning
  `exp/now/expire` from `make()`. A future adapter whose tokens expire but whose `make()` omits all three passes the
  "no expiry" branch, even though its `verify()` drops `exp`. Today only session.js has expiry and it declares it,
  and the exchange's 503 guard would catch a missing `exp` at sign-in. A possible tightening: if `expire` is given,
  require `exp`.
- **LOW: stale header line.** `test/auth/verifier-contract.js:1` still says `verify(token) → Identity | null`; it
  should say `Session | null`, like idp-port.js.
- **LOW (outside platform's files, already flagged by the builder):** PROTOCOL.md § Auth still says
  `verify(token) → { user, name, email, domain } | null`, with no `exp?`. Separately, the gateway guards with
  `Number.isFinite`, where `Number.isInteger` would match the port's promise; it's harmless either way.

## Not verified

- **Postgres/cluster wiring:** exp-at-close was checked on the single-node rig only. The gateway code path is the same.
- **Gateway with an injected timer clock:** it doesn't allow one, so the run used real time with a 2 s TTL.

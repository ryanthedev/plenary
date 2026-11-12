# Report: p5-exp (session verify returns exp)

Builder for manager platform (t187), 2026-11-12. Not committed.

## Outcome

`sessions().verify(token)` now returns the Identity plus `exp` (integer seconds since the epoch). The Auth port
passes it through unchanged, and the exchange takes `exp` from `verify()` instead of decoding the token.
Full suite: 633 pass, 78 skip, 0 fail (baseline was 627 / 78 / 0; the 6 new tests account for the difference).
test/auth/architecture.test.js passes.

## Gateway field name: matches

Engine's gateway lives only in the `plenary-p2` worktree (branch p2-land); main's gateway has no expiry code yet.
At `server/gateway.js:556` and `:589` it reads `identity.exp` flat on `auth.verify()`'s result, as seconds,
guarded by `Number.isFinite`. That is exactly what this job now returns. No rename needed.

## Design choice: `Session = Identity & { exp?: number }`, flat (idp-port.js)

- **Why a new type:** Identity stays exactly four keys because it is also what `session.issue()` takes and what
  the exchange cookie holds. It says who signed in, not for how long.
- **Why flat, not `{ identity, exp }`:** the gateway reads `identity.exp`, and the same object goes on unchanged to
  `role(identity, board)` and the admin use cases. Those read only `.user`, `.email` and `.domain`, so the extra
  key is harmless and nothing strips it.
- **No expiry (devAuth):** the key is OMITTED. Never null, 0 or Infinity. dev.js is unchanged.
- **Gateway with no `exp` (the one systems-design line):** it sets no expiry timer, so a dev-token connection lives
  until it closes or a `grants` re-check drops its role. That is engine's code as it stands; fine for dev tokens,
  which are off unless configured.

## Files changed

| File | Change |
|---|---|
| server/auth/session.js | `verify` returns `exp`; requires `Number.isInteger(c.exp)`; `sessions()` rejects a `ttlSec` that isn't a positive integer, so `exp` is always an integer |
| server/auth/idp-port.js | `Session` typedef; Verifier returns `Session\|null`; port comment states the absent-means-no-expiry rule and the reasoning above |
| server/auth/port.js | `Auth.verify` typed `Session\|null`; header says `exp` passes through. No logic change (it already returned the verifier's object) |
| server/auth/http.js | `tokenExp()` deleted. The exchange calls `sessions.verify(token)` for `exp`. A null, a throw, or a non-integer `exp` all release the code and answer 503 |

## Tests

- **verifier-contract.js:** `make()` may return `exp`, `now` and `expire`. An adapter with expiry must return an
  integer `exp` equal to the expected one, later than now, and in seconds (not ms). An adapter without expiry must
  omit the key. All three fields must be present together or all absent. The repeatability test now compares two
  verify results with each other instead of with `expected`.
- **contracts.test.js:** the sessions run supplies `exp` and `now`; devAuth supplies neither.
- **port.test.js:** the round-trip expects `exp`. Added a test that a non-integer `ttlSec` is refused, and that a
  correctly signed payload with a fractional, string or null `exp` is refused. `authPort.verify` passes `exp`
  through for sessions and omits it for dev tokens.
- **exchange.test.js:** with an opaque token (not the `s1.` format), the 200 carries verify's `exp` and has exactly
  the contract's six keys. A verify that throws, omits `exp`, or returns a fractional or string `exp` gives 503
  and leaves the code unspent.

## How I checked it

- **Mutation tests:** dropping `exp` from session.js's return fails 32 auth tests; returning milliseconds fails 4,
  including the contract's "in seconds" test. The file was restored after each run.
- **Exchange 200 body:** still `{token, user, name, email, domain, exp}` per docs/m2/contracts/auth-exchange.md.
  The existing contract-types test and the new exact-keys check both pass.

- **Composition root:** p2-land's `server/main.js` passes the real `sessions` adapter, unwrapped, to both
  `authPort` (line 112) and `httpRoutes` (line 162), so `exp` reaches the gateway in the real wiring. Main's
  main.js doesn't wire sessions yet (line 49: dev only).
- **PROTOCOL.md on p2-land:** § Auth doesn't mention `exp` there either, so the suggestion below doesn't conflict.

## Not verified

- **End to end with engine's gateway:** real session tokens against p2-land's gateway expiry timer were not run,
  because that gateway isn't on main. The field name and units were checked by reading the code only.

## Risks

- **Startup refusal:** `sessions()` now throws on a `ttlSec` that isn't a positive integer. No caller passes one
  today (grep, both worktrees), but a future env-derived string ("3600") would stop the server at start, by design.
- **Exchange depends on verify:** `/auth/exchange` answers 503 on every sign-in if the injected `sessions` adapter
  has no `verify` that returns an integer `exp` for its own fresh token. The contract test and the exchange tests
  pin this for session.js.
- **Gateway not landed:** the expiry code is uncommitted in the `plenary-p2` worktree, so the gateway line numbers
  cited above may shift when p2-land merges.

## Needs a change outside my files (manager)

- **PROTOCOL.md § Auth (line 430):** says `verify(token) → { user, name, email, domain } | null`. Suggest
  `verify(token) → { user, name, email, domain, exp? } | null`, with `exp` in integer seconds, absent when the
  token never expires, and the gateway closing the connection at `exp`.
- **Engine:** nothing to change. If they want a guard, `Number.isInteger` would match the port's promise more
  tightly than `Number.isFinite`, but it isn't required.

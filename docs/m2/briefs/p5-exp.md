# Brief: p5-exp (session verify returns exp)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-exp.md. Report only to t187; never message the proxy. Never print .env values.

## Goal (engine's ask, from p2-swap: docs/m2/reports/p2-swap.md "What platform must do")

The gateway closes a connection when its session token expires; today it is tested with a fake. Make the real
`sessions().verify(token)` (server/auth/session.js) return the Identity plus `exp` (integer seconds since epoch).
Then: update the Verifier port in server/auth/idp-port.js (Identity|null → Identity & { exp?: number } or a
`Session` type; your call: say why), the Verifier contract (test/auth/verifier-contract.js: an adapter that has
expiry must return an integer `exp` in the future; devAuth has none: say how the port expresses that), and drop
http.js's `tokenExp()` decoding of the token format (p5-code's coupling) in favour of `verify()`'s `exp`.
`authPort.verify` (port.js) must pass `exp` through to the gateway. Check how engine's gateway reads it
(server/gateway.js, read-only for you; tell me if the field name it expects differs).

No systems-design pass needed beyond one line: what a gateway does when `exp` is absent (dev tokens).

## Files you own

server/auth/session.js, idp-port.js, port.js, http.js; test/auth/. Nothing else.

## Done when

Tests pass (`bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`; name any failing test);
test/auth/architecture.test.js passes; the exchange's 200 body still matches docs/m2/contracts/auth-exchange.md.
Report, then stop. Do not commit.

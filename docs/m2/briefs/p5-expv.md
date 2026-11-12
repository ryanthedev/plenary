# Brief: p5-expv (verify p5-exp)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-expv.md, PASS or FAIL with HIGH/MEDIUM/LOW. Report only to t187; never message the proxy. Change
nothing in the tree. Never print .env values.

## Job under check

Goal (engine's ask): the gateway closes a connection when its session token expires. `sessions().verify()` must
return the Identity plus `exp` (integer seconds); the Verifier port, its contract and `authPort.verify` carry it to
the gateway; http.js stops decoding the token format itself (`tokenExp`). Brief: docs/m2/briefs/p5-exp.md. Diff:
`git diff -- server/auth test/auth`.

Builder's not-verified list and risks (not its claims): not run end to end with engine's gateway (on p2-land only,
worktree /Users/r/repos/plenary-p2: read `server/gateway.js` there, read-only); field name/units checked by reading.

## Check

- `exp` correct (integer seconds, equals the token's), never present for an invalid/expired token, dev tokens'
  behaviour as the port says. Can a caller get a token's identity without its `exp` silently?
- The exchange's 200 body still matches docs/m2/contracts/auth-exchange.md exactly (no extra field leaking out).
- If cheap: in a scratch copy of the p2-land worktree with this diff applied, a real session token's connection is
  closed at `exp` by the gateway (injected clock if the gateway allows it). Remove the scratch copy after.
- test/auth/architecture.test.js; full `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'` (name any
  failing test). Skip the sdd ensemble unless you find something worth a second opinion. Then stop.

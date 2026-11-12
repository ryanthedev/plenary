# Brief: p5-tidy (the p5-devadmin2v and p5-google2v LOWs)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-tidy.md. Report only to
t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values or
tokens. Never pkill/killall; ports from port 0. Do not commit. Stop at 60% context after writing what you have. Name
failing tests with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

p5-devadmin2 (84399eb) and p5-google2 (35d5f5a) passed verification with LOWs only. Read the tables at the top of
docs/m2/reports/p5-devadmin2v.md (F1-F3) and docs/m2/reports/p5-google2v.md (L2, L4). Close them.

## Do

1. **F1 + F2, one shared escape helper:** every operator-supplied value echoed to stderr by scripts/admin-bootstrap.js
   and server/admin/tenants.js (`normAdmin`, `normDomain`, the unknown-argument error) escapes all `\p{Cc}`, `\p{Cf}`,
   U+2028 and U+2029 as `\uXXXX` (astral Cf as its code point, e.g. `\u{e0001}`). Tests: DEL (`\u007f`), C1 CSI
   (`\u009b`), RLO (`‮`), ZWSP (`​`), NEL (`\u0085`) in an admin entry, a domain and an unknown flag; assert
   stderr bytes contain none of them raw.
2. **F3:** add `"alice@acme.com\n"` and `"\tdev:ann"` to the refusal list in test/admin/tenants.test.js; show mutation
   X5 (check the trimmed value instead of the raw one) now fails.
3. **L2:** in server/auth/oidc.js, a token-endpoint answer that is not JSON (status 200 or not) logs a new fixed label
   `bad_token_response`, not `idp_unreachable`. Network/fetch failure stays `idp_unreachable`. Test with the fake IdP.
4. **L4:** in docs/m2/reports/p5-google2.md, hand-off cause table (section (e)): add `idp_error`, `idp_refused`,
   `idp_threw`, `bad_sub`, `bad_config`, `bad_expected` and the new `bad_token_response`, each with a one-line plain
   meaning. Make the table list every label the code can log (grep server/auth for them and say how you checked).
   If a 503 from a `mintCode` failure (server/auth/http.js:~288) can log a cause cheaply, add `mint_failed`; else note why not.

Each code fix gets a test that fails under its mutation; list mutations and results in the report. Gate: `bun test
test/auth test/admin` all pass, plus full `bun test` (known unrelated failures: test/core-source.test.js, and two in
other sessions' uncommitted files: test/server/room-host-lease.test.js MEDIUM-3, test/server/gateway.test.js
"entries subject"). Run the Postgres path of test/admin if it has one (Podman Postgres; record the container id and
remove only that).

## Files you own

scripts/admin-bootstrap.js, server/admin/tenants.js, server/auth/oidc.js, server/auth/http.js (only if step 4 needs
it), test/admin/*, test/auth/* (new or the p5-google2 ones), docs/m2/reports/p5-google2.md (section (e) only),
docs/m2/reports/p5-tidy.md. Nothing else; never server/main.js, server/gateway.js or PROTOCOL.md (engine's).

## Done when

docs/m2/reports/p5-tidy.md has: files changed, each LOW closed with its test and mutation result, how the label list
was checked, gate counts. Then stop.

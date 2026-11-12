# Brief: p5-tidy3 (round 3 of p5-tidy: close the p5-tidyv findings V1-V8)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: append a "Round 3" section to
docs/m2/reports/p5-tidy.md. Report only to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine
(t18m) or the CEO. Never print .env values or tokens. Never pkill/killall; ports from port 0. Podman containers you
start: record the id, remove only that one. Do not commit. Stop at 60% context after writing what you have. Name
failing tests with `bun test 2>&1 | grep -E '\(fail\)'`.

## Why

p5-tidy round 2 (uncommitted, in the tree) passed verification with LOWs, but the job's own aim is not met: F1/F2
still has a raw echo (V1), and the job brought in a regression (V2) against its brief's step 3 ("Network/fetch
failure stays `idp_unreachable`"). Read the Findings table and "Suggested fixes" in docs/m2/reports/p5-tidyv.md.

Files you own: the same as round 2 (docs/m2/briefs/p5-tidy.md "Files owned"). Never server/main.js, server/gateway.js,
PROTOCOL.md or other sessions' files.

## Do

1. **V1:** `scripts/admin-bootstrap.js` `failed:` line (and any other CLI echo of operator input you find): escape
   with the same helper as `shown()` uses (without quoting if that reads better). Test with a real `--data-dir`
   value carrying DEL, a C1 char and RLO, checked on real stderr bytes.
2. **V2 + V3:** token answer read as `res.text()` (a read failure: timeout gives `idp_timeout`, else
   `idp_unreachable`), then `JSON.parse` in its own `try` (failure gives `bad_token_response`). Add real-socket
   tests (a `node:net` server on port 0): headers plus a partial body then reset (200 and 500) gives
   `idp_unreachable`; empty 200 and empty 503 bodies give the label you document. Keep every round-2 case passing
   or say why its label changed.
3. **V4:** cut the raw value first (by code point), then escape, append `…` when cut, so the offending character
   is never cut off or half-escaped; or name the first unsafe code point. Test both trailing cases from V4.
4. **V5:** widen the label scan to `'…'`, `` `…` `` and multi-line calls; add a test that parses p5-google2.md
   section (e) and compares it to `CAUSES ∪ SIGN_IN_CAUSES` in both directions.
5. **V6-V8:** fix the p5-google2.md wording (line ~161, the `unknown_kid` row says it can also mean Google's key
   endpoint was unreachable, so retry; examples written as `idp_error:server_error` etc.).
6. **Mutations:** for each fix, a mutation that undoes it must fail a test. Table them.
7. **Gates:** `bun test test/auth test/admin` (with and without DATABASE_URL), then full `bun test`. Known unrelated:
   core-source; gateway.test.js "the entries subject…"; v1.test.js pacing timeout (other sessions' files).

## Done when

"Round 3" appended to docs/m2/reports/p5-tidy.md: each of V1-V8 closed with file:line, mutation table, gate counts.
Then stop.

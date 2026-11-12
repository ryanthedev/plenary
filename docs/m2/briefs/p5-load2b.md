# Brief: p5-load2b (small fix round on p5-load2, tenancy side)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine. Never print .env values. Do not commit. Stop at 60% context.

Verifier p5-load2v PASSED the tenancy side (docs/m2/reports/p5-load2v.md). Fix these, in server/auth/tenancy.js and
test/auth/role-cache.test.js only:

1. **MEDIUM 0, take option (b):** a role entry's `until` is capped at the soonest `until` of the link records it was
   built from, so a new hello after a lost link revoke is admitted for at most `ttlMs` (30 s), not ~60 s. Add a test
   that fails without the cap (the verifier's "chained TTLs" scratch test in docs/m2/reports/p5-load2v.tests.txt is
   the shape: B is `null` by T+30.001 s). Keep the `ttlMs` JSDoc true.
2. **LOW 3:** strengthen the two-identity test so dropping only one identity on `invalidate(board, user)` fails
   (assert every identity misses, or `stats().entries`). Confirm with the M8 mutation.
3. **LOW 2:** `recordTtlMs` JSDoc says "the fields the cache reads never change" and warns never to serve `admins`
   from the memo.
4. **LOW 5:** update the proposed PROTOCOL sentence in docs/m2/reports/p5-load.md to the verifier's wording with
   "at most 30 s" (true after step 1) and the live-connection qualification. Do not edit PROTOCOL.md.

Gates: `bun test test/auth`, then full `bun test` (name failures with `bun test 2>&1 | grep -E '\(fail\)'`; the
known unrelated one is test/core-source.test.js). Append "Round 2b" to docs/m2/reports/p5-load.md. Then stop.
LOW 1 (newline key collision) is not in scope: it must change together with engine's gateway key.

# Brief: p5-load2bv (re-check Round 2b of p5-load)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine. Never print .env values or tokens. No pkill/killall.

## Job under check

You verified p5-load2 (docs/m2/reports/p5-load2v.md). Builder t1gh ran fix round p5-load2b
(brief docs/m2/briefs/p5-load2b.md; "Round 2b" section in docs/m2/reports/p5-load.md) on server/auth/tenancy.js and
test/auth/role-cache.test.js. Read the claims as claims.

## Check

- **MEDIUM 0:** a new hello after a lost link revoke is refused within 30 s (role `until` capped by link records).
  Write your own test or script for the boundary (T+30 s, T+30.001 s) and for a role entry with several link records.
  Mutate the cap once and confirm a test fails.
- **LOW 3:** the M8 mutation now fails the two-identity test.
- **LOW 2 / LOW 5:** JSDoc and the proposed PROTOCOL sentence in p5-load.md are accurate. PROTOCOL.md must be unchanged
  by this round.
- **No regression:** the rest of p5-load2v still holds; diff limited to the two files plus p5-load.md.
- **Gates:** `bun test` (name failures with `bun test 2>&1 | grep -E '\(fail\)'`; core-source is a known failure).

## Done when

Append "Re-check 2b" to docs/m2/reports/p5-load2v.md with PASS or FAIL and graded findings. Do not commit. Stop.

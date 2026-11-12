# Brief: p5-pgpriv4v (re-check Round 4 of p5-pgpriv2)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine. Never pkill/killall; record Podman ids you start and remove only those.
Never print .env values. Do not edit code; do not commit.

## Job under check

You failed Round 3 on M1 (docs/m2/reports/p5-pgpriv3v.md). Builder t1gs ran fix round p5-pgpriv4 (brief
docs/m2/briefs/p5-pgpriv4.md; "Round 4" in docs/m2/reports/p5-pgpriv2.md). Read the claims as claims.

## Check

- **M1:** re-run your `exp/b3.js` (stalls past and just past the deadline, and the control): a call whose deadline
  passed is never sent (server log), rejects `queue-timeout`, gate back to 0/0. Mutate the new check away once and
  confirm the new test fails.
- **No regression:** your Round 3 checks still hold (stacking, unrelated read, gate full, dead peer, slot accounting).
- **Docs:** L2 sentence, L1 note or change, and the two Store notes in deploy/README.md (upgrade ALTER, grant probe),
  each checked against server/store/postgres.js; "never ALTER, DROP or GRANT" still true.
- **Gates:** pg-registry and registry tests with DATABASE_URL; full `bun test` with and without (known unrelated
  failures as in your Round 3 report).

## Done when

Append "Re-check Round 4" to docs/m2/reports/p5-pgpriv3v.md with PASS or FAIL and graded findings. Stop.

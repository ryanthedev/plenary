# Brief: p5-tidyv (verify p5-tidy round 2: the p5-devadmin2v and p5-google2v LOWs)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-tidyv.md. Report only to
t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values or
tokens. Never pkill/killall; ports from port 0. Containers you start are recorded (Podman id) and only those removed.
Do not edit code or tests in the main tree; do not commit. Probes, mutations and scratch copies go in your scratchpad
or a scratch worktree, never in the live tree. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Stop at
60% context after writing what you have.

## Job under check

Builder brief docs/m2/briefs/p5-tidy.md; builder report docs/m2/reports/p5-tidy.md (read its claims as claims).
Original findings: tables at the top of docs/m2/reports/p5-devadmin2v.md (F1-F3) and p5-google2v.md (L2, L4).
Uncommitted, diff against HEAD: scripts/admin-bootstrap.js, server/admin/tenants.js, server/auth/oidc.js,
server/auth/http.js, test/admin/devadmin.test.js, test/admin/tenants.test.js, test/auth/signin-cause.test.js,
docs/m2/reports/p5-google2.md (section (e) only). Other sessions' uncommitted edits elsewhere are not this job.

## Check

- **F1/F2:** with `od -c` on real stderr, no raw Cc/Cf/U+2028/2029 byte reaches the terminal from any echoed operator
  value (admin entry, domain, unknown flag, `--flag=value`, anything else the CLI echoes that the builder missed).
  Truncation never splits a surrogate pair or hides why the entry was refused.
- **F3:** mutation X5 now fails, on every adapter test/admin runs (incl. Postgres via Podman).
- **L2:** behaviour of the token exchange for: network error, timeout during fetch and during body read, 2xx non-JSON,
  non-2xx non-JSON, non-2xx JSON with and without a known error name. The builder changed HTML 502 from `token_http_502`
  to `bad_token_response`; judge whether that's right for the CEO reading the hand-off table.
- **L4 / mint_failed:** the cause table in p5-google2.md (e) lists exactly the labels the code can log, no more, no
  fewer; check independently of the builder's scan. Test that the widened label scan really catches a missing label.
- **Nothing logged leaks:** no new log line carries a token, code, body, email or raw IdP text.
- **Mutations:** redo the builder's table yourself; add any it missed.
- **Gates:** `bun test test/auth test/admin` all pass; full `bun test` (known unrelated: test/core-source.test.js and
  failures in other sessions' uncommitted files, e.g. test/server/room-host-lease.test.js and gateway.test.js; check any
  you suspect on a clean worktree). The builder reported a timing flake: name it and say whether it is this job's.
- **sdd ensemble review** of the diff (codex + one more harness passing check_adapter). Two agreeing = HIGH candidate;
  confirm or refute each with a test or run.

## Done when

docs/m2/reports/p5-tidyv.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets), each builder claim confirmed or refuted. Then stop.

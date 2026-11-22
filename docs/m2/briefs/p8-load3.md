# Brief: p8-load3 (fix the LOWs left by verifier p8-load2v)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load3.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not commit.
**Mutations and load runs only in a copy of the repo in your scratchpad, never in /Users/r/repos/plenary.** Set
`TMPDIR` to your scratchpad for every run. Ports from port 0. Stop at 60% context after writing what you have.

**Secrets in copies (new rule, 2026-11-12):** a repo copy must never contain `.env`. Make it with
`git worktree add` plus the uncommitted files, or `rsync -a --exclude .env --exclude .rig`, then check
`find <copy> -name .env` is empty before any run. Never hand a folder to codex, grok or any other external review tool
unless that check is empty. Use dev tokens only (`PLENARY_DEV_TOKENS`), never Google values.

Leave alone processes you did not start (nats-server 19379, postgres 64891, any `server/main.js`, `run.js` or
nats-server from the real tree or another worker). Another worker (p8-rig3) works on scripts/cluster-rig.js and
test/deploy/*: do not touch them.

## Fix (findings in docs/m2/reports/p8-load2v.md; read it in full first)

Committed base: 448ca84. Your files: scripts/load/*, test/load/*, docs/m2/load/README.md, a correction note in
docs/m2/reports/p8-load2.md. Nothing else.

1. **Finding 2 (secret on an error path):** `createBoard` (`scripts/load/run.js:237`) must not pass the parser's
   message through; reuse the safe tokens-file reader. Test with a file starting `ltSECRETbare999`: no part of it in
   stdout/stderr, exit 2.
2. **Finding 3 (zero acks reads VALID):** a run where ops were sent but none was acked or echoed (or below a stated
   floor) is not VALID. Pick the rule, document it in the README, test it with a fake server that swallows ops.
3. **Finding 4 (orphaned `--local` server):** stop the server and workers on any setup failure after `startServer`
   and on SIGTERM/SIGINT/SIGHUP. Test both: no process tied to the run remains.
4. **Findings 5, 6:** refuse a ramp under 1 client/s (or cap it) and refuse an empty count, exit 2.
5. **Finding 7:** test exit code 2; X6 and X7 must then fail a test.
6. **Finding 8:** with no load-phase CPU sample, take one at the load phase's end or mark CPU unmeasured (not VALID
   on CPU grounds). L1 and L3 must then fail a test.
7. **Finding 9:** reverse the merge test's worker order (D1) and bound `drainMs` from above (D4).
8. **Findings 1, 10:** README: the 125-writer range as 1.8-12.4 s over 4 runs with load averages, server CPU for
   the load phase; fix the 14.8 load-average slip and name every folder the `drainMs` note covers.

## Gates

- Each fix's guard, re-applied as a mutation alone in your copy, fails `bun test test/load`; list them, plus the 39
  mutations from p8-load2v still caught.
- `bun test test/load` 3x in your copy; `bun test test/architecture.test.js` in the real tree (read-only run).
- `find <your scratchpad> -name .env` empty at the end. Process list before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-load3.md lists each finding with the change, the guarding test, mutation results and gate output.
Then stop.

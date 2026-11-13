# Brief: p7-tabv (verify the web client's hello.tab)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **CHECKER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md § Messages (hello.tab) and § Pacing, docs/m2/reports/p-tab.md and
p-tabv.md (engine, 40cba26), docs/m2/briefs/p7-tab.md (the builder's brief and the manager's rulings), and
docs/m2/reports/p7-tab.md (its report).

- **Your tab:** `worker p7-tabv (client) · <your id>: verify hello.tab`. Name `plenary-p7-tabv`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **Read only on main.** You write only docs/m2/reports/p7-tabv.md. Mutants and probes go in a scratch `git worktree`
  (with the builder's uncommitted files copied in: web/core/sync.js, session.js, roles.js, test/web/p7-tab.test.js,
  one-link.test.js, collab/wire.test.js, collab/wire2.test.js), never in the shared tree. Don't commit.
- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter).

## Rulings already made (don't re-litigate; refute only with a counterexample)

The tab id is per page load in memory (not sessionStorage); one neutral refusal text for both caps; retry unchanged;
local.js forwarding `tab` to the Room and not applying the caps is out of scope (dev only).

## Check

1. **Every hello the web client sends carries the page's one tab**, writer and viewer, through every path that makes a
   new hello (first connect, reconnect, drop, resync, backoff retry, Retry button, resume probe, token refresh, a
   share-link or role change if one reconnects). Find a path that sends a different tab, none, or two hellos.
2. **No tab** never throws and never sends `tab: null`/`undefined` keys. Can any caller hand a bad tab that throws at
   runtime in production (web/main.js, web/dev-main.js, web/dev.js)?
3. **Texts** are true for both a ninth tab and a third connection of one tab, everywhere the limit shows (pill, banner,
   tooltip, any other place that says "tabs" or "connections"). Grep web/ for leftovers.
4. **Tests prove it:** the real-gateway test really depends on the client's tab (try it with the flip reverted); the
   weakened/flipped old pins in one-link.test.js and wire*.test.js still catch what they caught before.
5. **Mutants.** Re-run the builder's 12 and add at least 6 of your own; list each survivor.
6. **Gates.** test/web green; `bun test` counts (known fail: test/core-source.test.js; other tracks' files named);
   test/web/architecture.test.js unchanged and green; only the files listed above changed for this job.

## Report

docs/m2/reports/p7-tabv.md: **PASS or FAIL** on the first line, then HIGH / MEDIUM / LOW with file:line and a repro,
mutant table, what you did NOT check. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.

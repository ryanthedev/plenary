# Brief: p7-tab (the web client sends hello.tab; refusal text for both tab caps)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md § Messages (hello.tab), docs/m2/reports/p-tab.md and p-tabv.md (engine's
job, commit 40cba26), then web/core/sync.js, web/core/session.js, web/core/roles.js and their tests under test/web/.

- **Your tab:** `worker p7-tab (client) · <your id>: send hello.tab`. Name `plenary-p7-tab`.
  Manager: `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** web/core/sync.js, web/core/session.js, web/core/roles.js, any other web/ file that must change for
  hello.tab to reach the server (local / shared-worker transports, dev rooms: name each in the report), tests under
  test/web/, and docs/m2/reports/p7-tab.md. Nothing in packages/, server/, PROTOCOL.md or other tracks' files.
  **Don't commit.**
- **.env rule (standing):** scratch copies of the repo leave out .env (git worktree, or rsync --exclude .env), and no
  folder holding .env ever goes to a review tool (codex, grok, any sdd adapter).

## Why

Engine shipped hello.tab (40cba26): the gateway caps writers at 8 tabs per (user, board) and 2 connections per tab, and
counts viewers per (user, tab). Until the client sends `tab`, every connection counts as its own tab, so a user who
reconnects a lot hits the 8-cap early and the viewer count is per connection.

## Manager rulings (don't re-litigate; refute only with a counterexample)

1. **Send it.** sync.js passes `tab` into `new Replica({ client, tab, now, random })` (replica.js throws on a tab that
   fails TAB_RE and adds hello.tab only when given). Writers and viewers both send it. Fix the stale "not sent yet"
   comments in sync.js and session.js.
2. **One id per page load, in memory.** Keep session.js's `mintTab` (16 base-36 chars). Not sessionStorage: the
   browser's "Duplicate tab" copies sessionStorage, so two tabs would share an id and trip the 2-per-tab cap. The id
   stays the same across reconnects and resyncs of one page.
3. **One neutral refusal text (p-tabv L3).** The client can't tell a ninth tab from a third connection of one tab (both
   are `error` `limit`, no id, closed). The pill, banner and accessible text (roles.js ~75/94/151) and sync.js's
   fallback ("too many open connections") must claim nothing the client can't know: cover both, e.g. "This board is
   open in too many of your tabs or windows, or this tab reconnected too quickly. Close one; this tab retries by
   itself." Your wording is fine if it is true in both cases and short. The server's message, when shown, stays as is
   (engine owns its wording, L2).
4. **Retry stays as today:** pending ops kept, backoff retry, Retry button.

## Job

Make the flip, the texts, and tests: hello carries `tab` matching TAB_RE; the same `tab` on reconnect and resync within
one session; two sessions (two page loads) get different ids; no `tab` when none was minted (no `draw` random) and
nothing throws; the limit UI text in all three places; every transport path the web client uses delivers hello.tab to
a server that accepts it (run one against the real gateway in-process if test/web already does that kind of test).
Mutants: at least 8 (drop tab from the Replica call, re-mint per connect, mint a bad length, old text back, …), each
killed or explained.

## Gates

test/web green; `bun test` counts (known fail: test/core-source.test.js; name other tracks' untracked files you see);
test/web/architecture.test.js untouched and green.

## Report

docs/m2/reports/p7-tab.md: files changed, the chosen text, mutant table, what you did NOT check. hc t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0. In shell cleanup use literal paths or `"${VAR:?}"`.

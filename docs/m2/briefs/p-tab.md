# Brief: p-tab (hello.tab: count tabs, not connections)

Read docs/m2/BRIEF-BASE.md first; its rules apply. Use the `distributed-systems-design` skill in APPLIER mode for the
spec. Tab: `worker p-tab (engine) · <id>: hello.tab`. Manager: `manager engine`, terminal `t18m`. Report to t18m only
(one short `hc send` when done); never message the proxy (t1bx) or client's manager. Don't commit. Report:
docs/m2/reports/p-tab.md (what changed, tests added, how checked, NOT verified, risks).

## Why

Client (p8-one-link, f1bfee6) now runs one Replica and one transport per browser tab and mints a tab id
(web/core/session.js:45 `mintTab`: 16 base-36 characters), but the wire has no place for it. The gateway counts
`here.viewers` and the writer cap per connection, so reconnects and overlap inflate both. Client's p7-tab waits on this.

## Owned files (only these)

PROTOCOL.md (§ hello and § here only), packages/protocol/replica.js, packages/protocol/envelope.js, server/gateway.js;
test/replica.test.js, test/protocol.test.js, test/envelope.test.js, test/server/gateway.test.js; one new test file
test/server/tab.test.js if you need it. Another builder (p4-wire2) is editing server/main.js, server/room-host.js,
server/bus/nats.js and their tests at the same time: if `bun test` fails in a file you don't own, name it and re-run it
alone before you call it theirs. Don't edit web/ (client's) or packages/core.

## Decided (spec these in PROTOCOL.md first, then code, then tests)

1. **hello.tab:** optional string, `/^[A-Za-z0-9_-]{1,32}$/` (accepts the client's 16 base-36). Bad format = the usual
   hello refusal. `new Replica({ tab })` puts it in the hello it builds (connectMessages); no `tab` option, no field.
2. **No tab = its own tab:** a hello without `tab` (Herdr/drawh, old clients) counts as one tab per connection, as today.
3. **here.viewers** counts distinct (user, tab) on the gateway per board, not connections. The same tab on two gateways
   during a reconnect may count twice; write that as "may happen".
4. **Writer cap:** 8 distinct tabs per (user, board) per gateway (today `lim.maxWritersPerUserBoard`, 8 connections).
   **Cap evasion:** `tab` is client-chosen, so also cap connections per (user, board, tab) at 2 (reconnect overlap); a
   third with the same tab is refused like today's limit (1008 `limit`). Say in the spec why both caps exist.
5. Counts drop when the last connection of a (user, tab) closes; a test proves no leak after open/close churn.
6. packages/protocol stays pure (test/purity.test.js); plain JS + JSDoc.

## Tests (each fails without its fix; name the mutation you ran)

Format accept/refuse; Replica puts `tab` in hello only when given; two connections, one tab = viewers 1; two tabs = 2;
no-tab connections count each; 8 tabs ok, 9th refused; 3rd connection on one tab refused; churn leaves counts at 0.

## Gates

`bun test` once (name every failure; test/core-source is known drift); `bun test test/server` 5x, 0 failures (a known
pacing flake in test/server/v1.test.js: re-run alone, report it); test/purity.test.js and test/architecture.test.js green.

## Rules

- Never pkill/killall; kill by recorded PID only. Port 0 where you can.
- Never read, print or log `.env` or a real secret; tests use fakes. Any scratch copy of the repo excludes `.env`
  (`git worktree add` or `rsync --exclude .env`); no folder holding `.env` goes to a review tool (codex, grok, agy ...).
- Read big files in ranges (≤ 200 lines); filter test output. Delete your scratch at the end.

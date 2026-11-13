# Report: p-tab (hello.tab: count tabs, not connections)

Worker p-tab (engine), for manager engine (t18m). Not committed.

## What changed

| File | Change |
|---|---|
| PROTOCOL.md | `hello` row gains `tab?`; new block **§ Messages, `hello.tab`** (format, no tab = its own tab, a tab is (user, tab) per board per gateway, the 8-tab cap, the 2-connections-per-tab cap and **why both exist**, viewers not capped per tab, when a tab stops counting, Guaranteed / May happen); **§ Presence, `here`, "What is counted"**: `viewers` = distinct (user, tab) viewer pairs per gateway, summed; same tab on two gateways during a reconnect **may** count twice |
| packages/protocol/envelope.js | `TAB_RE`, `isTab`, `MAX_TAB_CONNS = 2`; `MAX_WRITER_CONNS` comment now says tabs (name and value 8 kept) |
| packages/protocol/replica.js | `new Replica({ tab })`: checked with `isTab` (throws on a bad one), put in every hello from `connectMessages`; no `tab` option → no `tab` key at all |
| server/gateway.js | hello refuses a bad `tab` with `bad-op` (`badFrame`, beside the `client`/`since` checks). Tab key = `t:<tab>`, or `c:<conn id>` with no tab (prefixes keep the two apart). `writersBy` now counts distinct writer tabs per (user, board); new `tabConns` counts writer connections per (user, board, tab). `tooMany()` (run before the awaits and again in the synchronous go-live step, as before) refuses `limit`/1008 for a 3rd connection on a tab, or for a **new** tab when 8 are open; a further connection of an open tab passes the 8-tab cap. Counting happens in the go-live step; `end()` decrements and drops a tab on its last connection. `here`: `b.hvTabs` ("user|tabKey" → conns), `b.hv` = its size. `tab` is never forwarded to the room. The 8-cap message is byte-identical to before (test/server/v1.test.js:148 pins it); the per-tab refusal says `at most 2 open writer connections per tab on a board`. New limit `maxConnsPerTab` (default `MAX_TAB_CONNS`); `maxWritersPerUserBoard` kept by name, default now `MAX_WRITER_CONNS` |

## Tests added (each with the mutation that makes it fail)

All mutations were checked: each made its test(s) fail, and the code was restored after each.

| Test | File | Killed by |
|---|---|---|
| format accept/refuse (10 bad values, never forwarded) | test/server/tab.test.js | M7 format check removed |
| viewers: 2 conns one tab = 1; 2 tabs = 2; no-tab conns 1 each; another user on the same tab string = another tab; close of one of two conns keeps the tab | test/server/tab.test.js | M1 tab ignored, M5 viewers by connection, M6 shared no-tab key, M10 viewer key without user |
| 8 tabs ok, 9th refused; 2nd conn of an open tab admitted at the cap; no-tab hello at the cap refused; slot frees only on a tab's last close | test/server/tab.test.js | M1, M3 plain `distinct >= 8`, M4 no decrement on close |
| 3rd conn on one tab refused `limit`; other user same tab string ok; viewers not capped per tab; slot frees on close | test/server/tab.test.js | M1, M2 per-tab cap removed, M4 |
| no tab = its own tab (8 no-tab writers, 9th refused) | test/server/tab.test.js | M6 |
| churn: 5 rounds of open/close + refusals + sockets closed mid-hello (sign-in delayed), then viewers 0, the cut tab takes 2 conns, 8 fresh tabs ok, 9th refused | test/server/tab.test.js | M1, M2, M3, M4 |
| Replica puts `tab` in every hello only when given (key absent otherwise); bad tab throws; the room welcomes a hello with `tab` | test/replica.test.js | M8 `tab` always set, M9 `tab` never set |
| `isTab`/`TAB_RE`, caps 8 and 2 | test/envelope.test.js | M12 `TAB_RE` `{1,32}` → `{1,33}` (also fails the server format test) |
| hellos that wait together (rooms.open slowed so all pass the first check): 3 on one tab = 2 in + `CAP_TAB`; 9 tabs = 8 in + `CAP8` | test/server/tab.test.js | M11 the go-live re-check removed (it survived a first version of this test that delayed sign-in instead; the trace showed the hellos didn't overlap, so the test was fixed) |

test/protocol.test.js and test/server/gateway.test.js: no change needed.

## How checked

- `bun test` once: 1524 pass, 2 fail.
  - `packages/core is still herdr-draw's core`: the known core-source drift.
  - `p4-wire: a NATS open failure after Postgres opened…` (test/server/main.test.js): passes when run alone (20/0). The file is p4-wire2's; both it and server/main.js were being edited while the suite ran.
- test/purity.test.js and test/architecture.test.js: green.
- `bun test test/server` 5×: results in the last section of this report.
- Mutations M1–M12 are in the table above.

## Mutations and the real tree

- **Where mutations ran:** M1–M10 ran in the real tree (/Users/r/repos/plenary), before t18m's addendum arrived. That is probably what p8-load3 saw (the hello-tab check off: M7). Each was restored right after its run.
- **The real tree now holds no mutation:**
  - `server/gateway.js` and `packages/protocol/replica.js` diff clean against my pre-mutation copies.
  - A grep for every mutation's text (`if (false)`, `bump(tabConns, c.tkey, 0)`, `b.hv += by`, `` `t:`, tkey ``) finds 0 hits.
  - The three checks are present at server/gateway.js:886, :918 and :919.
- **After the addendum:** M11 and M12 ran only in an rsync copy of the repo in the session scratchpad, made without `.env` and `.git` and deleted at the end.

## Design (distributed-systems-design, APPLIER mode)

- **Scope:** fixed by the brief's "Decided" list. Per board: a few editors, ~2k annotators, 100k viewers. Counting is per gateway and best effort, like all presence.
- **Estimate (not measured):**
  - One `hvTabs` entry per viewer tab. A key is about 40–60 characters, plus Map overhead: roughly 100–150 B per entry.
  - 100k viewers on one gateway is about 10–15 MB, small next to the sockets themselves.
  - `tabConns`/`writersBy` are bounded by writers × 8 tabs × 2.
  - Nothing new goes on the bus: `.here` still carries one `viewers` number.
- **High-level design:** two maps on the gateway (writers) and one per board (viewers). They change only in the go-live step and in `end()`, the same places the old counters changed.
- **Deep dive:**
  1. The cap as a rate limiter (book chapter 4): `tab` is client-chosen, so a cap on tabs alone can be dodged by reusing one tab. That is why the connection count per tab is also capped. The op bucket stays per connection, so the per-user bound becomes 16 × 20 ops/s per gateway.
  2. Presence counting (book chapter 12): de-duplicating within a gateway is exact. Across gateways the counts are summed, so a reconnect landing on another gateway may count twice until the old socket closes.
- **Wrap-up (risks):** see Risks below.

## NOT verified

- **Real browser:** the client (p7-tab) sending `tab` from a real browser.
- **Cluster:** the cross-gateway double count on Postgres + NATS (only stated in the spec).
- **Memory at 100k viewer tabs:** the figure above is an estimate, not a measurement.
- **Herdr:** whether Herdr sends hellos without `tab`. The code path is the no-tab default.

## Risks

- **Half-open sockets:** a tab whose socket is half-open and that reconnects twice within 30 s is refused `limit` on its third connection. It gets in on a later retry. This is written as "may happen" in the spec.
- **Higher write bound:** one user's write bound doubles, from 8 to 16 connections × 20 ops/s per gateway.
- **Stale lines outside my sections:** some PROTOCOL.md lines outside § hello and § here still describe the old cap. I did not edit them (not owned). My new block says it replaces them. Suggested replacements:

| Line | Section | Now says | Should say |
|---|---|---|---|
| 26 | v1.1 table, "Gateway rate" | "≤ 8 writer connections per (user, board) per gateway" | "≤ 8 writer tabs and ≤ 2 writer connections per tab per (user, board) per gateway (§ Messages, `hello.tab`)" |
| 191 | § Limits table | "≤ 8 per gateway; a ninth writer `hello` gets `limit`…" | rename the row "writer tabs per (user, board)": "≤ 8 per gateway, ≤ 2 connections per tab; a ninth tab or third connection of a tab gets `limit` (no `id`) and is closed (§ Messages, `hello.tab`)" |
| 221–224 | § Pacing, "Connections per user" | "8 writer connections… A ninth writer `hello`… 8 × 20 ops/s" | "8 writer tabs, 2 connections per tab (§ Messages, `hello.tab`)… 16 × 20 ops/s" |
| 228 | § Pacing | "≤ 8 live tabs" | unchanged, now true by tab |
| 236 | § Pacing | "a ninth tab waits" | already correct |
| 276–277 | § Messages, the no-`id` paragraph | "a ninth writer connection" | "a ninth writer tab or a third connection of one tab" |
| 785 | § Bus, `.here` | "its number of viewer connections" | "its number of viewer tabs (§ Presence, `here`)" |

- **Misleading 8-cap message:** it still says "at most 8 open writer connections per user on a board" although it now counts tabs. It is kept byte-identical because test/server/v1.test.js:148 (not mine) pins it. Follow-up: change it to "tabs" there and here together.
- **For the client's p7-tab:** both refusals are `limit` with no `id`; only `message` differs. § Pacing has the client say "too many open tabs on this board" on that error, so a per-tab refusal after a network flap shows that text even though fewer than 8 tabs are open. p7-tab may want to read `message`, or the spec could give the per-tab refusal its own wording.
- **Changelog:** a row for the v1.1 changelog table would also be worth adding (`hello.tab`: viewers and the writer cap count tabs).

## Gate: `bun test test/server` 5×

- **First 5 runs:** 275 pass, 0 fail each.
- **After adding the go-live test:** 5 more runs, 276 pass, 0 fail each.
- **Known flake:** the v1.test.js pacing flake did not appear.
- **Final check of the real tree:** it matches the intended files. Mutation text: 0 hits. Both `tooMany()` calls are present.

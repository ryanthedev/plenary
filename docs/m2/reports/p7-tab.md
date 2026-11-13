# Report: p7-tab (the web client sends hello.tab; one refusal text for both tab caps)

Worker p7-tab (client), terminal t1m1, for manager client (t14k). Not committed.

## What changed

| File | Change |
|---|---|
| web/core/sync.js | `openLink` passes `tab` to `new Replica({ client, tab, now, random })` only when it is not null. Replica throws on any value that fails TAB_RE, null included, so "no tab" must mean no key. Stale "not sent yet" comments fixed. The cap comment now names both caps. The fallback for an id-less `limit` with no `message` is now `"too many tabs, or too many connections of this tab"` (was "too many open connections"). |
| web/core/session.js | Comments only. `mintTab` doc says why the id lives in memory and not in sessionStorage (ruling 2). The `tab` option doc now says it is sent on every hello. Minting is unchanged. |
| web/core/roles.js | New `LIMIT_TEXT`, used by the banner and the tooltip. Pill: **"Connection limit"** / "close a tab: retrying by itself" (was "Too many tabs", which claims a cause). The `pillFor` comment names both caps. |
| test/web/p7-tab.test.js | New: 14 tests (below). |
| test/web/one-link.test.js | The old "tab is NOT sent" test flipped: every hello now carries the session's tab. |
| test/web/collab/wire.test.js | Pill pin updated to "Connection limit". |
| test/web/collab/wire2.test.js | Banner and tooltip pins now require the full new clause. The old `/too many of your tabs/` pin also matched the old text, so it could not catch the old text coming back. |

Composition roots: **web/main.js and web/dev-main.js are unchanged**, because `createSession` mints the tab from the clock they already pass.

Transport files: **none changed.** Each one forwards the hello as the core wrote it, which the tests below check:
- **ws.js:** production.
- **shared-worker/client.js + host.js:** the dev page.
- **local.js:** `localNet`, the fallback when there is no SharedWorker.

## The chosen text

- **Banner:** `⚠ This board is open in too many of your tabs or windows, or this tab reconnected too quickly (<server message>). Close one; this tab retries by itself. Trying again in N s.`
- **Tooltip:** `This board is open in too many of your tabs or windows, or this tab reconnected too quickly. Close one: this tab retries by itself (or press Retry).`
- **Pill:** `Connection limit` · `close a tab: retrying by itself`
- **sync.js fallback** (only when the server sends no message): `too many tabs, or too many connections of this tab`
- **Server message:** shown unchanged in the banner (engine owns it, L2).

## Tests added (test/web/p7-tab.test.js)

- **The id:**
  - `mintTab` gives 16 base-36 characters and stays inside TAB_RE, even at random = 0 and ≈ 1.
  - Two sessions on the real `browserClock()` get different ids.
- **The same tab on every hello, read from the frames actually sent (not `replica.tab`):**
  - **Writer:** the first hello, `reconnect()`, `dropConnection()` and a resync (a refused settings op).
  - **Viewer:** the first hello and a reconnect.
  - **Writer cap:** each backoff retry and the Retry button (scripted clock).
- **A given tab** is sent exactly as given.
- **No tab:** `bindEditor` and `openLink({ tab: null })` send hellos with no `tab` key (a reconnect too), and nothing throws.
  - `createSession` with `tab: null` mints one. With no random at all it throws loudly, so a tab-less hello can never go out silently.
  - **The brief's "no `draw` random, nothing throws" case can't happen through `createSession`:** without a random, `openLink` throws first, because it needs one for the backoff jitter. The tab-less path is therefore tested at `openLink` and `bindEditor`, where nothing throws.
- **Transports:**
  - **ws.js:** decoded frames on the fake socket, on the first socket and after a server close.
  - **Shared worker:** `sharedNet` over a fake port pair into the real `roomHost`, with the Room's `receive` captured.
  - **In-page room:** `localRoom` with the Room's `receive` captured.
- **Real gateway, in-process** (`test/server/rig.js`, `wsNet`, Bun's WebSocket; the precedent is `test/web/adapters/auth-http.test.js`):
  - A session with a minted tab goes live.
  - Two sessions with one tab string both go live. A third is `limited` with the per-tab message (`/per tab/`).
  - Another tab of the same user gets in.
  - Only a gateway that read the session's `tab` can produce this. Without one, each connection would be its own tab.
- **Texts:** the pill, banner and tooltip carry both causes; the banner keeps the server's message. The message-less `limit` fallback is checked as well.

## Mutants (scratch rsync copy without `.env` and `.git`; the real tree never held one)

| # | Mutant | Result |
|---|---|---|
| M1 | drop `tab` from the Replica call | killed (9 fail) |
| M2 | pass `tab` even when null | killed (122 fail: Replica throws) |
| M3 | re-mint the tab on every connect | killed (9) |
| M4 | mint 17 chars | killed (3) |
| M5 | session hands `tab: null` to sync.js | killed (9) |
| M6 | constant tab for every page | killed (5) |
| M7 | old pill text back | killed (2) |
| M8 | old banner text back | killed (3) |
| M9 | old tooltip back | killed (2) |
| M10 | old sync.js fallback back | killed (1) |
| M11 | `LIMIT_TEXT` loses the "reconnected too quickly" clause | killed (2) |
| M12 | mint ignores `random` (always 0) | killed (3) |

12/12 killed. The mutants ran before I tightened the step counts in three tests (exactly one hello per reconnect, drop, resync, Retry and no-tab reconnect, plus a `resets` bump on the resync). The tightening only makes those tests stricter, so every kill stands.

## Gates

- **Baseline before my changes:**
  - test/web: 816 pass, 0 fail.
  - `bun test`: 1546 pass, 1 fail.
- **After my changes:**
  - test/web: **830 pass, 0 fail.**
  - `bun test`: **1560 pass, 1 fail**. The one failure is `packages/core is still herdr-draw's core`, the known core-source drift.
- **test/web/architecture.test.js:** untouched (`git diff --quiet`) and green.
- **Other tracks' files in the tree:** their untracked and modified files are listed in `git status`: deploy/, scripts/load, server/bus/nats.js, server/main.js, server/room-host.js, test/load/*, test/server/main.test.js, test/server/p4-wire2.test.js, test/deploy/, plus docs/m2 briefs and reports. I touched none of them.

## Design (distributed-systems-design, APPLIER mode)

- **Scope:** fixed by the brief's rulings 1–4. Per board: a few editors, ~2k annotators, 100k viewers. One field added to the hello; no new round trips.
- **Estimate:**
  - **Hello size:** about +27 bytes per hello (`,"tab":"<16>"`). 100k joins in 2 min adds about 2.7 MB in total, which is negligible.
  - **Id collisions:** an id is 16 base-36 characters, about 83 bits. A collision only matters inside one (user, board), which holds about 10 tabs. The chance is about n²/2^84, so effectively zero.
- **High-level design:** a page load runs `createSession`, which mints the id once. `openLink` gives it to the Replica, which puts it in every hello. The transport carries it unchanged, and the gateway counts it.
- **Deep dive 1, unique ids (Ch7):**
  - **Why not crypto UUIDs:** web/core may not touch `crypto` or `Math.random` (core-runtime-globals test). The clock port's random is enough, because the tab is client-chosen and untrusted anyway: the gateway's 2-per-tab cap is the defence (p-tab).
  - **Why not sessionStorage:** "Duplicate tab" copies it, so two tabs would share an id (ruling 2).
- **Deep dive 2, rate limiting seen from the client (Ch4):**
  - **No reason to name:** the refusal works like a 429 that carries no reason, so the text names both causes.
  - **Retry:** it stays on rule 12's backoff, and the banner shows when the next try comes, the counterpart of a Retry-After header (ruling 4).
- **Wrap-up:**
  - **Failure case:** a half-open socket plus two quick reconnects. The third connection gets refused. The text now covers this ("reconnected too quickly"), and the backoff gets back in once the dead socket closes (≤ 30 s, § Pacing).
  - **At 10x:** nothing changes on the client.

## NOT checked

- **Real browser:** no headless Chrome run against the production page or the dev page's SharedWorker. The transports were checked with fakes and the in-process gateway only.
- **Cluster:** not run on Postgres + NATS, so the cross-gateway double count during a reconnect (a "may happen" in the spec) is untested.
- **`web/dev.js`:** the old multi-pane dev page calls `bindEditor` with no tab, so each pane counts as its own tab. That is intended, but not tested beyond the no-tab test.
- **local.js is not a faithful gateway (unchanged, not mine to fix):**
  - It forwards `tab` to the Room; the real gateway strips it.
  - It counts viewers per connection and applies no tab caps.
  - The Room accepts the key (engine's replica test), so nothing breaks, but the dev rooms cannot show either cap.

## For other tracks (not edited)

- **engine, PROTOCOL.md § Pacing (~line 223):** it has the client tell the UI "too many open tabs on this board". That is now untrue for the per-tab refusal. Suggest wording that names both causes, or none.
- **engine, L2:** the server's 8-cap message still says "connections". The banner shows it in parentheses, so the visible text mixes "tabs" and "connections" until engine changes it.

## Housekeeping

- **Scratch copy still exists:** the mutant copy is at `/private/tmp/claude-501/-Users-r-repos-plenary/efe7ab7d-0678-41b5-abd9-eca39d24a87d/scratchpad/mut`.
  - The permission check denied `rm -rf` on that literal path twice.
  - It holds no `.env` and no `.git`; `node_modules` inside it is a symlink to the repo's.
  - Delete it by hand, or it goes with the session scratchpad.

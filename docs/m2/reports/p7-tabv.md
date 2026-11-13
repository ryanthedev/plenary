**PASS** (no HIGH, no MEDIUM; 3 LOWs)

# Report: p7-tabv (verify the web client's hello.tab)

Verifier p7-tabv (client), for manager client (t14k). Job under test: p7-tab (uncommitted on main; files below).
Read only on main; probes and mutants ran in a scratch `git worktree` with the builder's 7 files copied in (no `.env`).
Nothing committed.

## Verdict per check

| # | Check | Result |
|---|---|---|
| 1 | Every hello carries the page's one tab | **Holds.** One Replica per link, built once in `openLink` (web/core/sync.js:79). Every hello comes from `connect()` (sync.js:126-131), which reads `replica.connectMessages`, so the tab can't change per connect. `createSession` is called once per page (web/adapters/dom/app.js:58), and it calls `openLink` once (web/core/session.js:95). Paths traced: first `start()`; `reconnect()` (Retry button app.js:646, resume probe app.js:656, token refresh via `reconnect(newToken)`); `onDrop`; resync `goDown()`; backoff `reopen()`. All of them go through `reopen()` and then `connect()`, so each sends exactly one hello. No share-link or role-change path builds a new link. A new link only comes with a new page load (`location.assign` in relogin). |
| 2 | No tab never throws and never sends `tab: null`/`undefined` | **Holds.** sync.js:79 spreads `tab` only when `!= null`. `mintTab` stays inside TAB_RE for any value `random` returns. Run: NaN, -0.5, 1, ±Infinity, undefined and ±1e30 all give a 16-character id that passes TAB_RE (e.g. NaN → `0NaN0NaN0NaN0NaN`, -0.5 → `-i000-i000-i000-`). No production root passes `tab`: web/main.js:60, web/dev-main.js:49, web/dev.js:33 (bindEditor, no tab key). The only way to make Replica throw is a caller passing a bad `tab` explicitly (e.g. `""`), and none does. |
| 3 | Texts true for a 9th tab and a 3rd connection of one tab | **Holds** for the pill (roles.js:79), the banner (roles.js:98), the tooltip (roles.js:155) and the sync.js fallback (sync.js:172). A grep of web/ for "too many", "open connections", "open tabs", "your tabs" and "writer connection" finds only comments (L1). |
| 4 | Tests prove it | **Holds.** With the flip reverted (the Replica call without `tab`), 8 of the 14 p7-tab tests fail, the real-gateway test among them. The flipped one-link pin fails under M1/M3/M5. The wire.test.js pill pin is exact. The wire2 pins are stricter than before: the old `/too many of your tabs/` pin matched both the old and the new text, so it couldn't catch the old text coming back; the new pin doesn't match the old text (M8, M9 killed by it). p-tabv's L3 (a per-tab refusal shown as "too many open tabs") is met: no client text names one cause. |
| 5 | Mutants | Builder's 12/12 killed (re-run). Mine: 9 of 12 killed; 3 survivors, explained below. |
| 6 | Gates | test/web **830 pass / 0 fail** (worktree). `bun test` on main: **1560 pass / 1 fail**; the fail is `packages/core is still herdr-draw's core` (known drift). test/web/architecture.test.js exists, is unchanged since 2703540 (`git diff --quiet`) and passes alone (26 pass). `git status -- web/ test/web/` shows exactly the 7 job files. Other tracks' files in the tree (none touched by p7-tab): .gitignore, deploy/README.md, deploy/cluster.compose.yml, deploy/cluster/Caddyfile, deploy/cluster/RIG.md, scripts/cluster-rig.js, scripts/load/{client,run,server,tokens,worker}.js, test/architecture.test.js (platform: p8-rig/p8-load composition roots), test/load/{counting,load,guards,guards4}.test.js, test/deploy/, plus docs/m2 briefs and reports. |

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW

- **L1: stale comments still say "writer-connection cap"** (one cap; there are now two).
  - **Where:** web/core/sync.js:258 (`limited` getter doc), web/core/session.js:157 (`limited` doc), web/ports/collab.js:17.
  - **Repro:** `grep -rn "writer-connection cap" web/`.
  - **Effect:** comments only, no behaviour change. web/ports/collab.js is outside the files p7-tab touched; it is a web/ file, so it's the client track's to change.
- **L2: the real-gateway test fails as a bare timeout.**
  - **Where:** test/web/p7-tab.test.js:209 (`until`, 10 s default) inside a test with Bun's 5 s default timeout.
  - **Repro:** revert the flip at sync.js:79. The test then reports `this test timed out after 5000ms` instead of `timed out: third connection of the tab limited`.
  - **Effect:** it still fails, so the regression is caught, but the message doesn't say which step broke. Fix: pass a timeout to `test(…, 15_000)`, or lower `until`'s default under 5 s.
- **L3: three mutant survivors** (table below): V3, V9 and V12.
  - **V3, hex-only ids:** `/^[0-9a-z]{16}$/` (p7-tab.test.js:72, one-link.test.js:146) can't tell base-36 from base-16. Harmless: about 64 bits is still plenty.
  - **V9, pill subtitle:** its wording is not pinned. Cosmetic.
  - **V12, empty string:** `tab ? …` instead of `tab != null` would silently drop an empty-string tab, where today the Replica throws. Equivalent in production, because no caller passes `""`.
  - **Effect:** none needs fixing. V3 could be pinned with a distribution check if anyone cares.

### Carried, not this job's

- **Engine L2 (deferred in p-tabv):** the banner shows the server's message in parentheses. For the 8-tab cap that message still reads `at most 8 open writer connections per user on a board`, so the banner mixes "tabs or windows" with "connections".
- **PROTOCOL.md § Pacing:223:** still has the client say "too many open tabs on this board". The client's text is now neutral, so the spec line is the stale one. The builder reported this; it's engine's.

## Mutant table (scratch worktree, `bun test test/web` per mutant, file restored after each)

| # | Mutant | Result |
|---|---|---|
| M1 | drop `tab` from the Replica call | killed (9) |
| M2 | pass `tab` even when null | killed (122) |
| M3 | re-mint the tab on every connect | killed (9) |
| M4 | mint 17 chars | killed (3) |
| M5 | session hands `tab: null` to sync.js | killed (9) |
| M6 | constant tab | killed (3) |
| M7 | old pill text | killed (2) |
| M8 | old banner | killed (3) |
| M9 | old tooltip | killed (2) |
| M10 | old sync.js fallback | killed (1) |
| M11 | LIMIT_TEXT loses "reconnected too quickly" | killed (2) |
| M12 | mint ignores random | killed (3) |
| V1 | a given tab ignored (always mint) | killed (3, incl. real gateway) |
| V2 | mint 15 chars | killed (3) |
| V3 | mint hex only (`toString(16)`) | **survived**: valid and unique enough; the regex accepts hex (L3) |
| V4 | mint only from an explicit `random`, not `clock.random` (production would send no tab) | killed (9) |
| V5 | tab dropped after the first hello | killed (5) |
| V6 | tab dropped only on the backoff reopen after a `limit` | killed (1: the backoff/Retry test) |
| V7 | two hellos per reopen | killed (52) |
| V8 | ws.js strips `tab` from the hello frame | killed (2, incl. real gateway) |
| V9 | pill subtitle back to "close one: …" | **survived**: wording not pinned (cosmetic) |
| V10 | tooltip drops "(or press Retry)" | killed (1) |
| V11 | banner drops the server's message | killed (2) |
| V12 | `tab != null` → truthy check | **survived**: differs only for `""`, which no caller passes |

Plus the flip-revert probe on p7-tab.test.js alone: 8 fail, the real-gateway test among them.

## Ensemble review (sdd, on a separate .env-free worktree with the diff as P7TAB.diff)

| Harness | Outcome |
|---|---|
| codex (effort high) | no findings |
| grok | no findings |
| agy | failed: quota (`RESOURCE_EXHAUSTED 429`, "Individual quota reached", resets in ~44 h), per `check_adapter`; not retried |
| kimi | failed: not signed in ("No model configured"), per `check_adapter` |
| mistral | failed: `MISTRAL_API_KEY` not set, per `check_adapter` |

Two harnesses agreed on "no defects"; there were no HIGH candidates to confirm or refute. The review worktree held only the job's files and the diff afterwards: no harness edited it.

## Design check (distributed-systems-design, CHECKER mode)

- **Scope and estimate:** one 16-character field per hello, about 27 bytes. No new round trips, no new state on the server beyond what engine already counts. Agrees with the builder's numbers.
- **Unique ids:** 16 base-36 characters from `Math.random` (browserClock, web/adapters/clock/browser.js:18). That is about 83 bits, and a collision matters only inside one (user, board). Fine. Keeping the id in memory (not sessionStorage) avoids "Duplicate tab" sharing an id, as ruled.
- **Failure modes:**
  - **Half-open socket plus quick retries:** each `reconnect()` closes its old socket on the client, but the gateway may still count it for up to 30 s. So two Retry clicks during a half-open spell can make a third connection, which is refused. The UI then says "…or this tab reconnected too quickly" and backs off. That matches PROTOCOL.md's "May happen" and is not an infinite loop: backoff is rule 12, and Retry while limited is a user action.
  - **Probe, real gateway in-process (scratch, deleted after):** one live session, then `reconnect()` 2, 3 and 5 times back to back, and again 2, 3 and 5 times each right after the previous went live. 3 runs of the first set and 2 of the second: always ends live in 11–59 ms, never `limited`. ws.js `open()` retires the old socket first (web/adapters/transport/ws.js:136-137). A real half-open socket was not simulated.
  - **bfcache restore:** keeps the same in-memory id. That's correct, since it is the same tab.
  - **Cluster:** the same tab on two gateways during a reconnect counts twice (a spec "May happen"). Not exercised here.
- **Hexagonal:** no new imports. web/core stays on ports (architecture test green). Only sync.js, session.js and roles.js in core changed.

## What I did NOT check

- **No real browser.** No headless Chrome on the production page or the dev page's SharedWorker; the transports were checked only through the builder's fakes and the in-process gateway.
- **No cluster run:** not on Postgres + NATS, and not across two gateways.
- **Herdr/QuickJS:** not run there; the job's files are web-only.
- **local.js caps:** not exercised. It is out of scope by ruling.
- **Ensemble coverage is thin:** only 2 of the 5 harnesses produced a review.
- **Half-open sockets:** the reconnect probe ran on loopback, where closes arrive at once; a gateway that still holds two dead connections of the tab was not simulated.

## Housekeeping

- **Scratch worktrees:** both (`wt` for mutants and probes, `rv` for the ensemble) were removed with `git worktree remove --force` and `git worktree prune`. No `.env` was ever in them.

**Round 2: PASS. The builder adopted the 17 tests as-is and removed the dead aliases; all 17 former survivors are killed (53 of 54 mutants, the 54th equivalent), the alias removal changed no behaviour, and nothing else in the job's files changed.**

Round 1 verdict (kept for the record): FAIL (tests only): the code is correct, but the builder's tests let 17 mutants survive, each breaking a rule it claims. Fix: append docs/m2/reports/p7-chromev.tests.js.txt to test/web/ui-app.test.js (17 tests). No code change is needed.

# Verify: p7-chromev (page chrome, link liveness, token expiry)

- **Who:** verifier plenary-p7-chromev, manager t14k. Read only on main; mutants and extra tests ran in scratch worktrees (HEAD plus the job's 5 files), all removed at the end.
- **Job files checked:** web/adapters/dom/app.js, web/core/roles.js, web/main.js, web/dev-main.js (`git diff`), new test/web/ui-app.test.js.
- **Scope:** nothing outside those files was changed by this job. `git diff` of web/core/{sync,session}.js is empty. The packages/protocol changes in the tree belong to engine's in-flight work, not to this job.
- **Base:** checked against main at 479cf46. 84399eb (p5-devadmin2) landed during the run; it touches none of the job's files, and those files are byte-identical to the ones I tested.
- **Independence:** the job passes on HEAD plus its own 5 files alone, with no other track's in-flight files: unit tests, mutants and the Chrome rebuild counts were all run there.

## Verdict in one table

| Check | Result |
|---|---|
| 1. C-2/C-8 rebuilds | **Holds.** Unit tests and Chrome both show 0 rebuilds for a pan and for incoming ops. Each part key covers what its render reads (checked by hand against every build function and panel.js `renderPanel`). No stale chrome found. |
| 2. C-4 resume | **Holds.** Code is right, and Chrome showed 0 sockets at 0.3 s and 2 by 2.5 s after `online`. **Test gap (HIGH-T1).** The 0–2 s window is narrow at 100k (MEDIUM-1). |
| 3. C-9 expiry and return | **Holds.** Banners match in Chrome. Hostile stored values are rejected. No token in any URL, localStorage, console or server log. **Test gap (HIGH-T2):** main.js has no tests. |
| 4. C-6/C-17 clocks | **Holds.** No `setTimeout`/`setInterval`/`performance.now`/`Date.now` in app.js. **Test gap (HIGH-T3).** The ui.js aliases are dead (LOW-1). |
| 5. `jumpTo` | **Holds.** Scale is clamped to 0.1–8. 0, negatives, NaN, ±Infinity, `"3"` and null all keep the current scale, and the view stays finite. |
| 6. Mutants | **Builder's suite:** 37 of 54 killed. **With my tests:** 53 of 54; the one survivor is equivalent (it changes nothing). |
| 7. Headless Chrome | **Reproduced:** 65 rebuilds per part at HEAD, 0 after. The expiry and refused banner paths both work. |
| 8. `bun test` | **1274 pass, 137 skip, 1 fail, 1412 tests.** The one fail is the known `test/core-source.test.js`: herdr-draw has uncommitted edits in `core/editor.js` and `core/geometry.js` (checked with `git status` there). `ui-app.test.js` passed 5/5 runs, 10/10 tests each, so it is not flaky. |

## HIGH (by the brief's rule: "a claimed rule a mutant survives"). All are test gaps; the code is right in every case.

- **HIGH-T1: the page's own guard on reconnects is not tested.** test/web/ui-app.test.js:222 checks only the pure `shouldProbe`.
  - **Mutant that survives:** `S.reconnect()` without the `shouldProbe` check at app.js:622.
  - **What it would allow:** a page reconnecting while refused, capped or mid-drag, with every builder test still passing.
  - **Killer:** test K1 drives the real page refused, capped and mid-drag, then fires `online` and a long hide.
- **HIGH-T2: main.js is not under any test.** These mutants all survive the builder's suite and page-signin.test.js:
  - the token appended to the sign-in URL;
  - the token written to session storage;
  - the stored return value read raw into the address bar.
  - **Killer:** test K3 is a source scan of main.js. The token appears only in the gate check and in createSession. `location.assign` takes only `signInLink.href`. The return board is read only through `takeReturnBoard`.
  - **Behaviour itself:** checked in Chrome (below).
- **HIGH-T3: the clock rule is not tested.** These mutants survive:
  - `toast` on `setTimeout`;
  - `countClick` on `performance.now`;
  - `mountCollab` without `clock`. The builder already said its C-6 test is weak: ui.js's 1 s tick falls back to real timers, which the virtual-clock test never sees.
  - **Killer:** test K2. A source scan of app.js finds none of the four globals. A page with the collab UI runs a virtual minute with `setTimeout`/`setInterval` trapped from before mount, and records 0 calls.
- **HIGH-T4: 9 part-key fields are not tested.** Each is needed and present in the code; only the tests miss them. Removing any one leaves that part stale, and every builder test still passes:
  - **Panel:** `B.doc.layers` (a remote layer added or renamed), `framesSig` (a remote frame renamed), the selection's animation preset (a remote preset change on my selection).
  - **Hud:** `frameAt` (the ‹ › frame index), `framesSig` (a remote frame added).
  - **Drawer:** the row text (a remote note edited); and a key of the count only.
  - **Timeline:** `marks` (a mark removed, same duration), `!!B.play` (playback ending by itself).
  - **Killers:** tests V1–V6, V10, K4 and K5.

**Fix for all four:** append docs/m2/reports/p7-chromev.tests.js.txt to the end of test/web/ui-app.test.js as is. It uses the file's own helpers and its `rig`. I ran that merged file: 27 tests, 5 of 5 runs green, and it kills 53 of 54 mutants. The survivor removes `S.eds.board.play ? now : ""` from the gate at app.js:593. It is equivalent: `Editor.tick()` already bumps `S.version()` on every playing frame (editor.js:1068). It could be deleted as redundant.

## MEDIUM

- **MEDIUM-1: the 0–2 s jitter is too narrow for a correlated mass event** (app.js:616). See the design check below.
  - **Not blocking:** the herd case is not "no jitter", and the builder named the residual risk (E-1 heartbeat plus J3).
  - **For the manager:** decide whether J3 widens the window or adds gateway admission.

## LOW

- **LOW-1: the ui.js aliases are dead.** `setTimer`, `clearTimer` and `raf` in `collabClock` (app.js:73–75) are never read.
  - **Why:** ui.js `clockPort` returns the port as-is when it has `set` and `mono` (ui.js:46–47), and `raf = frame ?? …` (ui.js:57) takes the `frame` app.js passes.
  - **Follow-up:** drop the aliases and pass `clock` directly. Not a block.
- **LOW-2: a part skipped while you type stays stale after you stop** (codex finding 1, confirmed; it predates this job).
  - **Cause:** `buildDrawer`/`buildPanel` return false while an input has focus, but `gateKey` is already recorded (app.js:593–598). A blur that is not a canvas click (Tab, a click on other chrome) leaves the part stale until the next gate change.
  - **Seen:** a note that arrived while typing stayed missing for 2 s of idle after blur, and showed after the next op.
  - **Also affected:** `dialogs()` has the same gap for the export preview (app.js:464).
  - **Why it's old:** HEAD set `chromeKey = key` before the same busy skip (HEAD app.js:464).
  - **Possible fix:** leave `gateKey` unset when any part was busy.
- **LOW-3: `online` reconnects even if the room spoke within 10 s** (codex finding 4; app.js:624).
  - **Why it's sound:** `online` means the network changed, so a socket that was heard a moment ago may still be dead (a NAT rebind or Wi-Fi switch).
  - **The catch:** brief item 2 can be read as wanting the skip on both triggers.
  - **For the manager:** confirm it is intended. I recommend keeping it as is.
- **LOW-4: on production pages, part keys are rechecked every second for the whole session** (app.js:592).
  - **Cause:** `ticking` puts the second into the gate whenever `expAt` is known, which on production is always.
  - **Cost:** a panel and drawer key computation once a second (a 200-row JSON). No rebuilds.
  - **Possible fix:** tick only inside `EXPIRY_WARN_MS` of expiry.
- **LOW-5: the expiry banner doesn't warn about unsent edits** (app.js:512). Its "Sign in again" does not say how many unsent edits leaving loses; the refused banner does.
- **LOW-6: p6-hexv's storage rule needs rewording.** It says "sessionStorage holds only `plenary.session`" (p6-hexv.md:163), and this job adds `plenary.return`, which holds a board id only.
  - **Suggested wording:** "the token is only under `plenary.session`."
  - **Brief wording:** "never reaches sessionStorage" can't hold either: the sign-in session there is p6-hex's design, not this job's.

## Refuted (codex)

- **"The drawer key omits note order":** wrong. `notesRowsKey` lists row ids in sorted order (app.js:538–541), so a reorder changes the key.
- **"chromeDirty bypasses part keys":** this is by design and documented. A local action rebuilds every part, as before. The brief's rule covers only pans and incoming ops, which no longer set it.

## How I checked

- **Reading the code:** I compared each part key in `parts` (app.js:549) with what its build function reads: topbar, hud, timeline, notesList, dock, sheetView, dialogs, banners, and panel.js `renderPanel`/`propsModel`. The memos are per `Doc.rev`, and `Doc.apply` and `Doc.load` bump `rev` on every change (doc.js:29, 77).
  - **Per-frame cost:** `inPlace` only, which is compares plus O(1) memo hits.
  - **Per check** (at most every 250 ms, and only when the gate moved): the part keys. `propsModel` calls `labelOf`, which is O(n) for a selected shape. That is not per frame.
- **Extra unit tests (17)**, beyond the builder's cases. **All pass on the job:**
  - a remote note deleted, and a remote note's text edited;
  - a remote frame (hud and panel), a hud ‹ › click, and a remote frame rename;
  - a remote style or preset change on my selection, and a style chip with nothing selected;
  - a remote layer added, renamed and counted;
  - undo with ⌘Z, and playback ending on its own (▶ returns);
  - hostile return values: `javascript:`, `//evil`, `?`, `#`, `/../`, `%2F`, a newline, 65 characters, empty;
  - bad `jumpTo` scales;
  - K1–K5 above;
  - K6: a mid-session role downgrade on a quiet page (no expiry ticking). The topbar's tools grey out and the panel goes read-only with no input, because a role only changes through a `welcome`, which moves `status` and fires `onChange` (session.js:84). No stale chrome.
- **Mutants:** 54 in total: 19 re-creating the builder's 21 (its two "no jitter" variants as one; all 19 killed by its suite) plus 35 of mine. Each was run against the builder's suite alone (ui-app, page-signin, signin, ui-chrome, architecture tests), then with my tests appended.
  - **The 17 that survive the builder's suite:** panel key without layers, without framesSig, without the selection's preset; hud key without frameAt, without framesSig; drawer key without row text, drawer key of the count only; timeline key without marks, without play; timer skipping `shouldProbe`; token in the return URL; token in session storage; the hostile return read raw into the address bar; toast on `setTimeout`; `countClick` on `performance.now`; `mountCollab` without `clock`.
  - **The 18th survivor (equivalent):** the gate without its playback term.
  - **The ones the brief asked for:**

| Mutant | Builder's suite | With my tests |
|---|---|---|
| A field dropped from a part key (14 variants, 1 of them the builder's) | 5 killed, 9 survive | 14 killed |
| No 10 s skip / skip window 60 s | killed | killed |
| No jitter / fixed 2 s / `Math.random` | killed | killed |
| Token in the return URL / in session storage / logged | survives / survives / killed | all killed |
| Hostile return written to the address bar | survives | killed |
| `Date.now` in the countdown | killed | killed |

- **Headless Chrome** on the production rig (test/server/rig.js, port 0; production index.html and main.js over ws), driven by the DevTools protocol from a Bun script. Chrome PIDs were recorded and killed by PID.
  - **Trees:** the rebuild table compares a HEAD worktree with a worktree of HEAD plus the job's 5 files only. The banner, `online` and token runs used the shared tree (other tracks' server files in flight); they touch only this job's page code.
  - **Why HEAD's ops count is 9 here and 10–20 in the builder's run:** the count depends on how ops are batched in delivery; a synchronous burst gave 3.
  - **Board:** 300 shapes and 100 notes drawn by editor0's page; the page under test is the editor's, with the notes drawer open.
  - **Same instrument before and after:** a MutationObserver counting childList rebuilds per container.

| | HEAD (app.js before) | This job |
|---|---|---|
| 60 wheel + 5 ctrl-wheel frames (topbar/panel/drawer/timeline/hud/dock) | **65 each** | **0 each** (`ui.rebuilds` also 0 for all 9 parts; zoom % current at 189%) |
| 100 incoming ops, sent one every 16 ms from outside the page (the counted page saw x go from −40 to 160) | 9 each | **0** |
| 1 incoming note | every part once | topbar 1, drawer 1 ("❏ Notes 101") |
| 1 incoming frame | every part once | panel 1, hud 1 ("– / 1") |

  - **`online`** (a real event in the page): 0 new WebSockets at 0.3 s, 2 by 2.5 s, then back to live.
  - **Expiry** (exp in 4 min): "⚠ Your sign-in ends in 4 min. Sign in again to stay connected.", with a link to `/auth/login`.
  - **Refused** (a dead token): the banner and the pill "Refused · sign in again". A real mouse click on the link went to `http://127.0.0.1:<port>/auth/login` with no query, and `plenary.return` was the board id.
  - **Hostile stored return** (`javascript:alert(1)//` on a board page; `x&board=evil#y` on a page with no board): consumed, and the address bar was unchanged ("No board in this link").
  - **Token scan:** across 6 pages, the dev token's marker was in no `location.href`, localStorage, sessionStorage key other than `plenary.session`, console message, or any of 338 request and WebSocket URLs. Server log: 0 of 15 lines.
- **sdd ensemble review:** codex only. agy failed `check_adapter` (quota, resets in about 52 h), so I ran a single harness as the brief allows. Codex's 4 MEDIUMs: 2 confirmed as LOW-2 and LOW-3, 2 refuted (above).

## Design check (CHECKER, distributed-systems-design)

- **NFR in play:** 100k joins in 2 min, about 830 hellos/s. Every tab has 2 links, so 2 hellos per reconnect.
- **Correlated return, worst case** (a whole all-hands tabs back at once): 0–2 s uniform jitter gives 200k hellos over about 2 s, roughly **100k/s, about 120× the join budget.**
  - **How it's avoided:** only by the heard-recently skip. On a 100k board, `here` goes to viewers at most every 5 s and only on change (PROTOCOL.md:541–543).
  - **When that holds:** the viewer count churns on a board that size, so in practice every live tab heard something within 10 s and sends nothing. The herd is avoided by that traffic, not by the jitter.
  - **When it fails:** any big board where nothing changes for over 10 s (a frozen viewer count, or the gateway's `here` paused) herds at 120×.
- **Recommendation for J3 / E-1:**
  1. E-1's 2 s room heartbeat (PROTOCOL.md:744) makes "heard" always true on a live link.
  2. Widen the jitter for the non-urgent visibility path, for example scaled by the last `here`'s `viewers` (window ≈ viewers / 830 s, capped).
  3. A gateway hello token bucket as the backstop.
- **`online`:** correlated per network, for example one office of 5k tabs. That is 10k hellos over 2 s, about 5k/s, 6× the budget, briefly. Acceptable with gateway admission; worth the same widening.
- **Failure walk, token expiry:** the warning at 5 min, the link lives until the next reconnect, the refused banner offers sign-in, and the board comes back. Holds, but see the limit below.
  - **Limit:** a reconnect after `exp` (including one of the C-4 probes) is refused at once.
  - **Effect:** the C-4 probe turns a silent expired-but-live link into a refused one sooner. This is correct: the page then shows the way out.
- **Caching:** the per-`rev` memos are invalidated by the Doc's own counter, so no stale reads were found. The perf cost has moved to the gate's 250 ms checks, which is fine at 4/s.

## What I did NOT check

- **The `signed-in` return trip in a browser:** the rig has no Google sign-in or exchange, so `takeReturnBoard` on a fresh sign-in is unit-tested only. In Chrome I checked writing the board, and the hostile values on a restored session.
- **Real `visibilitychange`, laptop sleep or Wi-Fi switch:** `online` was a synthetic event in a real page; visibility is unit-tested only.
- **Phone layout and the sheet** in a browser.
- **dev-main.js** in a browser: read only. `relogin: null`; `expAt` from `signIn.exp`, which is null for dev tokens.
- **Clock skew** between the browser and the server's `exp`.

## Files

- **This report.**
- **docs/m2/reports/p7-chromev.tests.js.txt:** the 17 tests to adopt, appended to the end of ui-app.test.js.
  - **Why `.txt`:** so `bun test` doesn't pick it up, following p2-swapv's `.attack.js.txt`.
  - **Ownership:** I own only the report; this extra file follows that precedent.

## Round 2 (2026-11-12, after builder t1h3's fix round)

**PASS.** Checked on main at 35d5f5a (22e4636 since, docs only); job files byte-compared against round 1, then mutants, unit runs and Chrome on a worktree of HEAD plus the job's 5 files only.

| Check | Result |
|---|---|
| **What changed in the job's files** | **app.js:** only the alias removal. Its diff against HEAD differs from round 1's only in that hunk: `collabClock` with `setTimer`/`clearTimer`/`raf` is gone and `mountCollab` gets `clock` directly. **ui-app.test.js:** the builder's round-1 file plus docs/m2/reports/p7-chromev.tests.js.txt, byte for byte (plus one trailing newline). **roles.js, main.js, dev-main.js:** unchanged since before round 1 (last modified 10:00–10:37, before my round-1 report). |
| **The 17 survivors** | **All killed.** The same 54 mutants against the builder's suite (ui-app, page-signin, signin, ui-chrome, architecture tests): 53 killed. The only survivor is the equivalent one (the gate's playback term, which `Editor.tick()` already covers). The "collab without clock" mutant was re-targeted to the new `clock,` argument and is killed by K2. |
| **Alias removal changed no behaviour** | ui.js `clockPort` returns a port that has `set` and `mono` unchanged (ui.js:46–47), and `raf` comes from the `frame` app.js passes (ui.js:57), so the aliases were never read. K2 (no real timers from mount through a virtual minute with the collab UI) and the C-6 test pass. In Chrome the production page, which mounts the collab UI, matched round 1 exactly (below). |
| **ui-app.test.js** | 27 pass, 5 of 5 runs. |
| **Headless Chrome** (round-2 files, same paced script) | 60 wheel + 5 ctrl-wheel frames and 100 paced incoming ops: **0 rebuilds** in every part. 1 note: topbar 1, drawer 1. 1 frame: panel 1, hud 1. `online`: 0 sockets at 0.3 s, 2 by 2.5 s. Expiry and refused banners, the "Sign in again" round trip (board id stored, no query), hostile returns dropped: all as round 1. Token: in no URL, storage, console or server log line. Chrome PIDs 17991 and 29739 killed by their own scripts; confirmed gone. |
| **`bun test`** (shared tree) | **1319 pass, 150 skip, 2 fail, 1471 tests.** |
| **The 2 fails: not this job** | (1) `test/core-source.test.js`: herdr-draw's uncommitted core edits, as in round 1. (2) `test/server/gateway.test.js` "the entries subject carries each entry once, after it is durable": fails only in the shared tree, where engine's uncommitted packages/protocol/{ports,room}.js, server/{room-host,bus/port,store/sqlite,store/postgres}.js and test/server/gateway.test.js sit. On HEAD plus this job's 5 files it passes 29 of 29. |

**Still open from round 1, unchanged and not blocking:** MEDIUM-1 (0–2 s jitter at 100k: J3/E-1), LOW-2 to LOW-6.

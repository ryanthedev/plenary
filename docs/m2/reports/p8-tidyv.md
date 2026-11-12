# p8-tidyv (client): verify p8-tidy — report

**FAIL: three HIGHs.**

- **H1 and H2 are test gaps.** The code is correct, but a claimed rule passes with that rule removed (a surviving mutant).
- **H3 is behaviour:** the resume probe replaces a link the Replica's backoff already restored, so the tab sends a second hello. Under "link" as this codebase uses the word (sync.js `openLink`, one per tab), that is two hellos on one live link. **t14k:** if you read "link" as one socket, H3 is a MEDIUM.

**Everything else holds:**

- **Chrome:** jitter is right for every role, with one hello per socket.
- **Emotes:** none silently lost.
- **zoomToFit:** reaches 8× and lists the cluster.
- **dropConnection():** works on the ws transport.
- **Tokens:** none leaked.
- **Changed assertions:** none weakened.
- **One MEDIUM:** a new `regexMayStart` evasion.

- **Verifier:** this session, read-only on main. Mutants and probes ran in a scratch worktree (`git worktree add --detach`, with the job's 13 files copied in), which is now removed.
- **Distributed-systems-design skill, CHECKER mode:** see "Design check (CHECKER)".
- **sdd ensemble:**
  - **Harnesses:** codex (high effort) and grok passed `check_adapter`. agy failed it (quota, 429), as did kimi (no model configured) and mistral (no API key).
  - **Results:** grok found nothing. codex found one MEDIUM, refuted to LOW (L2), and one LOW (L1). No finding had two harnesses agreeing.

## HIGH

| # | Where | Finding |
|---|---|---|
| H1 | web/adapters/dom/app.js:292 | **The pill click's `shouldProbe` gate is untested.**<br>The brief and the builder both claim the pill click is refused while refused, stopped, capped or mid-gesture.<br>Mutant V-1g (`if (S.status !== "live") reconnectNow();`) **survives** all of test/web.<br>The code is right by reading. Without the gate, a refused tab would re-send the same refused token, and a capped tab would skip the cap's backoff.<br>**Fix:** a ui-app case that clicks the pill while refused, while limited and mid-gesture, and expects 0 reopens. |
| H2 | test/web/architecture.test.js:155 and :392 | **`while`, `for` and the `.if(` guard in `closesStatementHead` are untested.**<br>Mutants V-4d (drop `while`), V-4e (drop `for`) and V-4c (drop the `.if` guard) **survive**.<br>The builder's case `while (go) /a\/b/.exec(s); import(spec);` (:392) passes even with `while` removed: read as division, `/a\/b/` never makes a `//`. Only the `if` case really tests the rule.<br>**Fix:** `while (go) /\//.test(s); import(spec)`, `for (;;) /\//.test(c); import(d)`, and `x.if(a) / 2; // import(y)` (must stay 0). |
| H3 | web/adapters/dom/app.js:634-639 | **The resume probe throws away a link the Replica already restored.**<br>The probe fires 0–15 s after `online` and reconnects whatever the status is (`shouldProbe` allows `live`). When the socket really died, rule-12 backoff has reconnected and gone live first, and the probe then replaces that fresh live link.<br>**Chrome, production rig:** viewer, random pinned to 0.99. `online`, then a real drop through `dropConnection()`:<br>• socket 1 opened at +0 ms (backoff) and went live<br>• **the probe closed it at +13.5 s** and opened socket 2<br>That is 2 hellos for one return.<br>**Same mechanism the builder fixed for clicks:** its report calls M1c "a second hello … on a link that was already live". Here the backoff, not a click, gets there first.<br>**Why it matters:** in a correlated return where sockets died (an office Wi-Fi blip), the wave doubles, from about 6.7k to about 13k hellos/s. The 15 s window makes this the common case. It already existed at 2 s (p7-chrome).<br>**Fix:** at fire time, skip when a welcome (or any room event, the `heard` stamp) arrived after the probe was armed. |

The `with` mutant (V-4f) also survives, but it is **equivalent**: `web/` files are ES modules, and modules are strict mode, where `with` is a syntax error.

## MEDIUM

| # | Where | Finding |
|---|---|---|
| M1 | test/web/architecture.test.js:150-155 | **New evasion: `for await (…) /re/`.**<br>The word before the `(` is `await`, not `for`, so the `/` is read as division and `/\//` opens a comment.<br>`for await (const x of y) /\//.test(x); import(d); Date.now();` gives **0 imports and no globals**.<br>Bun parses and runs that line at module top level. It hides a computed import and a global.<br>**Fix:** when the word is `await`, also accept a preceding `for`. |

## LOW

| # | Where | Finding |
|---|---|---|
| L1 | app.js:292 | **(codex, confirmed by reading) A double-click on the pill while `connecting` reconnects twice:** 2 sockets, 1 hello each. User-driven and bounded. A guard against a reconnect still in flight would fix it. |
| L2 | app.js:649-656, session.js:105 | **(codex, refuted as MEDIUM) The sign-in user can differ from the first welcome's user.** The app then treats it as a switch, and the sign-in key's ids are saved under the welcomed user's key.<br>**Probe (scratch ui-app case, `me.user` "zed", token for "cy"):** "zed-note" ended up in cy's stored set. zed's own key was **not** overwritten.<br>**Why only LOW:** in production `me.user` is `signIn.identity.user`, which comes from the hand-off cookie's `u` (server/auth/http.js:208, :226). That is the same auth identity the gateway's token check yields for `c.user`, so the two match by construction. They differ only with the `"me"` fallback (identity missing), and `takeSignIn` always pairs a token with an identity. |
| L3 | sync.js:182 | **A bind whose stream is absent from a snapshot is not reloaded** (by reading, the `Object.hasOwn` check), as the manager's L5 ruling requires.<br>**But it is untested:** mutant V-L5b (reload every bind) survives. It is close to equivalent, because snapshots always carry both streams. Worth one sync test pinning down the ruling. |
| L4 | app.js:658 | **Saving before the first welcome is untested:** mutant V-2g survives. Nearly equivalent: the first save after the welcome writes the whole set. |
| L5 | app.js:292 | **The pill reconnects while `catching-up`,** throwing away a catch-up in progress. Minor and user-driven. |
| L6 | test/web/architecture.test.js:134 | **Pre-existing evasion, not this job's:** `i++ / 2; import(d); Date.now(); // x` gives 0 imports and no globals, because `+` (from `++`) counts as a regex start. The line is unchanged since HEAD. Noted for the file's next owner. |

## Checks, item by item

1. **Jitter by role (Chrome, production rig `test/server/rig.js` port 0, 4 `online` reconnects per role, synthetic `online` as p7-chromev):**

   | Role | Effective | Delays (ms) | Hellos per socket |
   |---|---|---|---|
   | owner | presenter | 1971, 1932, 894, 975 | 1 ×5 |
   | editor | presenter | 970, 1950, 914, 1993 | 1 ×5 |
   | annotator | annotator | 6970, 7943, 2908, 3950 | 1 ×5 |
   | commenter | viewer | 7971, 3926, 10966, 4926 | 1 ×5 |
   | viewer | viewer | 12230, 1483, 294, 4206 | 1 ×5 |

   - **Every tab ended `live`.**
   - **Real pill click with a probe armed (random 0.99), status `connecting`:** 1 new socket, then live; nothing more in 17 s. The probe was cancelled.
   - **Unknown role:** unit-tested (M1f killed).
   - **Hellos per socket:** every socket carried exactly 1, because `reconnect()` always reopens first. Extra hellos on the tab's link: H3 and L1.
2. **L8:**
   - **Switch A→B (unit):** A's key survives and B's notes go under B's key. M2a–c, V-2d, V-2e and V-2f' are all killed. (The first V-2f was mis-built: it wrote the new key, not the old one. It was rebuilt as V-2f', which is killed.)
   - **Switch back (scratch ui-app case cy → di → cy):** **passes.**
     - cy's stored set keeps cy's notes and none of di's.
     - di's set keeps di's.
     - After the switch back, `S.mine` holds cy's note and not di's.
   - **Before the first welcome:** L2 and L4.
3. **Emote cooldown (Chrome, 30 real `Input.dispatchMouseEvent` clicks on a viewer's 👍):**
   - **Outcome:** 5 sent; the other 25 landed while `cooling` showed. **0 silently lost.**
   - **No stuck state:** cooling had cleared by the end.
   - **Freeze and resume, attempted only:** `Page.setWebLifecycleState` frozen for 1.5 s, then active. Cooling was clear after it, but the call's errors were swallowed, so it isn't confirmed that the freeze took.
   - **One clock:** ui.js's gap and gate.js's pacing read the same `C.mono` and the same 250 ms gap.
   - **Mutants:** M3b, M3c, V-3d (sticks), V-3e (no `aria-disabled`), V-3f (a 100 ms gap) and V-3g (no render on send) are all killed.
4. **`regexMayStart`:** 14 evasions tried against this job's rule. All were caught except `for await` (M1):
   - `else`, `do`, nested parens, a `")"` string in the head, a `/\(/` regex in the head
   - comments around the head, no spaces, `for (;;)`
   - a template with `")"` in the head, the do-while tail, `else if`, a newline before the regex, `.if(`

   `return (x) /re/` is division in JS too, so it isn't an evasion. Test gaps: H2. The pre-existing `++` hole: L6.
5. **zoomToFit (Chrome, owner, 320 threads in a 30×20 spot, real clicks):**
   - **First click:** 1× → **8×**. Titles then read "click to list them".
   - **Next click:** stays at 8×; the drawer opens on "49 threads here · Show all" with 49 rows. Further clicks don't zoom: no loop.
   - **Mutants:** M5a–f and V-5g are all killed.
   - **Screenshot:** `/private/tmp/claude-501/-Users-r-repos-plenary/4439f550-0638-4df5-a584-d27446a17ed5/scratchpad/zoom-list.png`
6. **L2–L6:**
   - **L2, dead getters:** gone. The restored merge is killed (V-L2d, 3 tests).
   - **L3, `wrapTransport`:** wraps only what the adapter has. A transport without `reopen` is refused through createSession. L3 and V-L3b are killed.
   - **L4, V7:** V7 and V7b are killed.
   - **L5, V11:** killed.
   - **L6 in Chrome:** `dropConnection()` gives `connecting` at once, then 1 socket closed, 1 new, `live` again.
   - **L6, `fail()` after `close()`:**
     - **Chrome:** `S.connection.close()` then `dropConnection()` gave no throw and 0 new sockets in 3 s.
     - **Unit:** p8-tidy.test.js:105-106.
     - **Mutants:** L6, L6b (closes but never reports) and L2c (onDrop ignores `replica.stopped`) are killed.
7. **Changed assertions: none weakened.**
   - **class-transport:** the old lines asserted made-up defaults. The new ones assert absence and an exact key set, as L3 requires.
   - **ui-app C-17 and K1:** the same assertions, with the fake moved to `S.connection`.
   - **ui-land `stopped`:** the forced status is replaced by real events. The old assertions are kept and new ones added.
   - **collab/perf:** its one removed line, the `mount` helper's `mountCollab` call, was replaced by a superset (adds `maxScale` and `onList`).
8. **No token:**
   - **Chrome:** 57 request and WebSocket URLs, localStorage (empty), the console, and the server log (37 lines). None contains the rig's `S3CR3T` marker.
   - **Architecture tests:** green (test/web/architecture.test.js; test/architecture.test.js 16/16).
9. **Mutants:** 49 run, with all 29 of the builder's re-created from its descriptions.
   - **Real gaps:** V-1g (H1) and V-4c/d/e (H2).
   - **Near-equivalent:** V-L5b (L3) and V-2g (L4).
   - **Equivalent:** V-4f.
   - **Mis-built:** V-2f, rebuilt as V-2f' and killed.
   - **All others killed.**

   Lists and results are in my scratchpad (`tools/muts*.json`, `mut-results.txt`).
10. **`bun test` (full, shared tree):**
    - **Counts:** 1414 pass, 153 skip, 2 fail (1569 tests, 83 files).
    - **Fail 1, known:** test/core-source.test.js.
    - **Fail 2, not this job's:** "M7: hellos waiting on the room when a timed pass runs…" in **test/server/role-cache.test.js**, another track's **untracked** file. It passed 3 runs out of 3 alone in the shared tree, so it looks load-flaky. It doesn't touch this job's files.
    - **Different from the brief's expectation:** test/architecture.test.js now passes (16/16), so the scripts/ fail the brief expected is gone in the current tree. **This job neither passes nor fails because of other tracks.**
    - **test/web in the worktree:** 797 pass.
    - **Flakiness:** p8-tidy, ui-app, collab/perf, ui-land, class-transport and web architecture together gave 117 pass, 0 fail in 6 runs out of 6.

## Design check (CHECKER)

- **Client side is sound in shape, but it can't be the control.**
  - **The numbers:** 100k tabs over 15 s is about 6.7k hellos/s, 8× the 830/s join budget.
  - **The rule:** the rate-limiter chapter's rule is that client-side limiting is unreliable, and gateway admission (t18m) must be the real control. Jitter only smooths the shape.
  - **What else carries the load:** the "heard recently" skip and E-1's heartbeat remove most hellos on a busy board.
  - **What they don't cover:** a return where sockets really died. There, only jitter and admission act, and H3 doubles that wave.
- **What the client should do and doesn't:**
  1. **Don't double the wave (H3):** skip the probe when the link has been heard since the probe was armed.
  2. **Honour a server-given retry delay:** when gateway admission refuses a hello, it should send a retry-after. The client should wait that long (plus jitter) instead of its own rule-12 backoff, the way the writer cap's `limit` already works. Without this, admission can't shape the retry wave. **Engine (t18m) and client should agree the message** (PROTOCOL.md first).
  3. **Scale the window by audience (p7-chromev option 2):** use the last `here.viewers`, e.g. 60 s for a 100k board, which gives about 1.7k/s. It is still the only client-side lever that reaches the budget.
  4. **Count probe-caused reconnects** in the M4 load test.
- **Failure walk:** a viewer whose link died waits up to 15 s; the pill and Retry are the way out, and Chrome shows them working. **The pill is a `span`:** not keyboard reachable (the builder's own risk).

## What I did NOT check

- **Real network events in Chrome:** a real `offline`/`online`, sleep or Wi-Fi switch. The events were synthetic, as the builder's were.
- **L8 in Chrome:** probed in a scratch ui-app case only. The production page gets a new user only by reloading.
- **The freeze actually taking in Chrome** (item 3).
- **The phone path of `onList`** (sheet), "Show all" in Chrome, and `fail()` racing an in-flight `reopen()`.
- **The pill's gate in Chrome** while refused, limited or mid-gesture (H1). Read only.

## Cleanup

- **Chrome:** PID 48115 (recorded in my scratchpad's `pids`). It was gone after the run; nothing was killed by pattern.
- **Rig:** stopped by the driver.
- **sdd jobs:** both done.
- **Scratch worktree:** removed.

# Round 2 (docs/m2/briefs/p8-tidyv2.md)

**FAIL: three HIGHs, all test gaps, plus two MEDIUMs.**

- **The HIGHs:** each is a claimed rule that still passes all of test/web with the rule removed. The code behind each is correct.
- **MEDIUM M1, new evasion:** round 2's L6 fix brings in a regex evasion that HEAD caught.
- **MEDIUM M2, needs t14k's ruling:** the brief's "welcome at fire time" case, reproduced.

**Fixed and holding:**

- **Round 1's findings:** H1, H2, H3, M1 and L1 are fixed.
- **Builder claims on L3 and L4:** both confirmed.
- **Chrome:** one hello per return (viewer and editor), and a double-click opens one socket.

**Round 2 changed only** app.js, ui-app.test.js and architecture.test.js. I checked this by applying round 1's saved diff to HEAD and comparing. Its only removed assertion is the vacuous `while` case, replaced by one that works.

## HIGH

| # | Where | Finding |
|---|---|---|
| R2-H1 | web/adapters/dom/app.js:634 | **"A room event counts as heard" is untested.** Mutant V-H3c (`heardN++` removed from `S.onRoom`) **survives**. The H3 test drives only the welcome path.<br>**This is the path the 100k design leans on:** a live, busy link after a network blip must send no hello.<br>**Probe (scratch ui-app case):** viewer, random 0.99, `online`, a `here` delivered at 3 s on a live link.<br>• with the fix: **0 reopens**<br>• with the mutant: **1 reopen** |
| R2-H2 | web/adapters/dom/app.js:649 | **The L1 guard's 5 s fallback is untested.** Mutant V-L1c (the timer never clears `userReconnect`) **survives**. The builder's round-2 report says it is unit-tested; the L1 test (ui-app.test.js:762-779) only ends the guard through a status change.<br>**Effect if it broke:** a click whose reconnect never changes the status (still `connecting`: offline, or a dead link) leaves the pill and Retry dead until the status moves. |
| R2-H3 | web/adapters/dom/app.js:517, :646-648 | **Retry's route through `reconnectNow()` is no longer pinned.**<br>**Round 1's M1e** (Retry calls `S.reconnect()` directly: no probe cancel, no L1 guard) **was killed in round 1 and now survives.** The old test passes anyway, because the click's welcome bumps `heardN`.<br>**Same for the cancel:** V-L1d (`reconnectNow` without `cancelProbe()`; round 1's M1c moved) survives.<br>**Not equivalent:**<br>• a Retry double-click reconnects twice<br>• without the cancel, a probe firing while the click's hello is still waiting replaces it (the R2-M2 race)<br>**Fix:**<br>• double-click Retry and expect 1 reopen<br>• hold the click's welcome past the armed probe's fire time and expect 1 reopen |

## MEDIUM

| # | Where | Finding |
|---|---|---|
| R2-M1 | test/web/architecture.test.js:135 | **New evasion from the L6 fix: a prefix `++`/`--` on a regex.**<br>`++/\//.lastIndex; import(d); Date.now();` and `x = --/\//.lastIndex; import(d); Date.now();` give **0 imports and no globals**. Bun parses and runs both (a regex's `lastIndex` is an assignable member).<br>**HEAD caught both** (1 import and `Date.now` in a HEAD worktree): its rule read `+`/`-` as a regex start. The new rule's comment ("a prefix one can't take a regex") is wrong.<br>**Fix:** `++`/`--` is postfix only when what precedes it ends a value (a word that isn't a keyword, `)` or `]`); otherwise a regex may start. |
| R2-M2 | web/adapters/dom/app.js:651-658 | **A probe can fire while the backoff's hello is still waiting for its welcome.** Status is `connecting` and nothing has been heard, so the probe reconnects: **2 hellos for one return.**<br>**Reproduced** (scratch ui-app case): viewer, a probe armed for 7.5 s, a real drop at 2 s. The backoff reopened at 2.5 s with every reply held; the probe reopened again at 7 s.<br>**Why MEDIUM, not LOW:** the window is the time to the welcome. That is one round trip normally, but seconds under gateway admission backpressure, which is exactly the mass return the 15 s window exists for.<br>**t14k:** it is round 1's H3 mechanism on a `connecting` link rather than a `live` one. **Rule whether it is a HIGH.**<br>**Fix:** the probe also stands down if a hello went out since it was armed (count reconnects, not only "heard"). |

## LOW

| # | Where | Finding |
|---|---|---|
| R2-L1 | web/core/sync.js:425, app.js:634 | **A local action can count as "heard".**<br>**Records ops (probed, safe):** `record()` → `recordsChanged()` → `onRoom` fires with no room message. Scratch case (silent dead link, `online`, a comment made at once): the op's own 10 s timeout reconnected at 11 s and the op was acknowledged. With no op, the probe reopened at 15 s.<br>**`dismissSetting` (by reading only):** it fires `onRoom` with no op behind it, so a dismissal inside the jitter window could leave a silently dead link unprobed.<br>**Fix:** count only messages from the room. |
| R2-L2 | test/web/architecture.test.js:105 | **Pre-existing, not this job's:** `of` used as a variable name (`const x = of / 2; import(d); const y = 1 / 3;`) gives 0 imports, because `of` is in `REGEX_KEYWORDS` (unchanged since HEAD). |

## Checks

1. **H3, fixed:**
   - **Chrome** (production rig in a scratch worktree with HEAD's server and the job's files, port 0; one viewer tab and one editor tab, random 0.99, `online`, then `dropConnection()`, watched for 17 s):

     | Role | New sockets | New hellos | Status |
     |---|---|---|---|
     | viewer | 1 | 1 | live |
     | editor | 1 | 1 | live |

   - **Unit:** V-H3 and V-H3b are killed. V-H3c survives (R2-H1).
   - **Other paths to two hellos:**
     - **A welcome at fire time:** R2-M2, reproduced.
     - **Probe vs pill, and probe vs Retry:** covered by cancel plus `heardN`, but untested (R2-H3).
     - **Visibility vs online, by reading:** `probe()` cancels the earlier probe, so there is one timer.
     - **A local "heard":** R2-L1.
2. **H1, fixed:** V-1g killed. The case clicks while refused, limited, stopped and mid-gesture (0 reopens each) and while connecting (1).
3. **H2, M1, L6:**
   - **Mutants:** V-4c, V-4c2, V-4d, V-4e, V-4g, V-M1, V-M1b, V-L6 and V-L6b are all killed.
   - **The brief's lines:** the `while`, `for`, `for await` and `i++ / 2` lines are caught, and `x.if(a) / 2; // import(y)` stays 0.
   - **New evasions tried:** 15. Thirteen are caught:
     - `for await` with comments, a newline, or nested parens
     - `while ( (a) )`, `else if` across lines, `i++;` then a regex statement
     - `a[i]++ / 2`, `x-- / 2`, `x./*c*/if(a) / 2`, `x?.if(a) / 2`, `await (p) / 2`
     - a labelled `for`, the do-while tail
   - **The two misses** are the prefix `++` and `--` forms (R2-M1). The `of` hole is pre-existing (R2-L2).
4. **L1:**
   - **Chrome:** a real double-click on the pill while `connecting` opened 1 socket, then `live` (viewer and editor).
   - **Unit:** V-L1 and V-L1b are killed. V-L1c survives (R2-H2), and Retry is not covered (R2-H3).
5. **L3 and L4: the builder's claims are confirmed.**
   - **L3:** `Replica.snapshot` (packages/protocol/replica.js:436-441) reads `msg.streams[s].elements` for every element stream, so a snapshot missing one throws before sync.js's bind loop. V-L5b is equivalent.
   - **L4:** before a welcome, `effective` is `viewer`, so `streamOk("notes")` is false (session.js:166, :180), and session.js:124 can't add to `mine`. V-2g is equivalent.
6. **No regression, with limits:**
   - **Round 1's 49 mutants re-run against round 2's code:**
     - **Still killed:** 42.
     - **Moved:** two patterns (M1c is now V-L1d; V-4c is re-made in round 2 and killed).
     - **Equivalent, as in round 1:** V-2f (mis-built), V-L5b, V-2g and V-4f.
     - **Newly surviving:** M1e (R2-H3).
   - **Re-run in Chrome:** `dropConnection()` (1 closed, 1 new, live), `fail()` after `close()` (0 sockets), and no token in 57 URLs, localStorage (empty), the console or the server log (12 lines).
   - **Not re-run in Chrome:** jitter by role, emotes, zoom. Round 2 didn't touch ui.js or records-model.js, and the jitter code is unchanged apart from the `heardN` gate.
   - **Files:** only the job's files are changed in web/, test/web/ and packages/.
   - **`bun test` (full, shared tree):** 1432 pass, 153 skip, 1 fail (the known test/core-source.test.js; 1586 tests, 83 files).
   - **test/web in the worktree:** 800 pass.
   - **Flakiness:** p8-tidy, ui-app, collab/perf, ui-land, class-transport and web architecture together gave 120 pass, 0 fail in 6 runs out of 6.
7. **Mutants:** 20 new in round 2, plus round 1's 49 re-run. All ran against all of test/web in scratch worktrees.
   - **Of the 20 new:** 14 killed. V-H3c, V-L1c and V-L1d are gaps (R2-H1 to R2-H3). V-L5b and V-2g are equivalent (L3, L4). V-H3d was my own no-op (`const` to `let`).
   - **Files** (my scratchpad): `tools/muts-r2.json` and `mut-r2.txt`; the re-run is `tools/muts-r1-all.json` and `mut-r1-rerun.txt`.

## What I did NOT check (round 2)

- **Real events in Chrome:** a real `offline`/`online`, sleep or `visibilitychange` (synthetic events).
- **R2-M2 in Chrome:** reproduced on the page rig only.
- **The `dismissSetting` half of R2-L1:** by reading only.
- **Chrome re-runs:** jitter by role, emotes and zoom were not re-run.
- **The L1 5 s fallback in Chrome.**
- **No sdd ensemble this round.**

## Cleanup (round 2)

- **Chrome:** PID 10095 (recorded in `pids`), stopped by the driver and confirmed gone.
- **Scratch worktrees:** wt2, wt3 and wt4 removed, and nothing was killed by pattern.

# Round 3 (docs/m2/briefs/p8-tidyv3.md)

**FAIL: one HIGH (a test gap with a small, timing-only effect) and one MEDIUM (a regex evasion HEAD caught).**

- **Fixed:**
  - **R2-M2, ruled HIGH:** fixed, including in Chrome with every welcome held.
  - **R2-H1, R2-H2 and R2-H3:** fixed, and their mutants now die.
  - **R2-L1 and R2-L2:** fixed.
- **V-L1d:** the builder's claim that it is now equivalent is confirmed.
- **Two hellos for one return:** not found on any path.
- **No regressions.**

## HIGH

| # | Where | Finding |
|---|---|---|
| R3-H1 | web/core/sync.js:166-167 | **"`onHeard` fires after the closed and down checks" is untested.** The builder claims it; mutant V-R3a (`onHeard()` moved above `if (closed \|\| down) return;`) **survives** all of test/web.<br>**Why it is observable:** during a resync wait (`goDown()`: down, a backoff timer of `BACKOFF.baseMs·2^fails` armed), the old socket stays open and still delivers messages. With the mutant those count as heard, so a resume probe firing in that window stands down. Recovery then waits for the backoff instead of happening now.<br>**Impact is small:** no extra hello, no lost op, timing only. It is HIGH only by the brief's rule (a claimed rule a mutant survives). **t14k:** downgrade it if you rule timing-only gaps LOW.<br>**Fix:** one ui-app case that sends a resync, delivers a room message on the old socket while down, and expects an armed probe to still reopen. |

## MEDIUM

| # | Where | Finding |
|---|---|---|
| R3-M1 | test/web/architecture.test.js:137, :153 | **The new prefix/postfix rule still misses prefix `++`/`--` after a newline or a `}`.** JS reads `++` as postfix only on the same line as its operand (no line break before postfix `++`/`--`). After a newline, or after a block's `}`, it is prefix, and a regex may follow.<br>**`endsValue` misses both:** it treats a word or `]` before a newline as a value, and treats `}` as a value. These lines give **0 imports and no globals**:<br>• `x\n++/\//.lastIndex; import(d); Date.now();`<br>• `if (x) { x = 2 } ++/\//.lastIndex; import(d); Date.now();`<br>• `const a = [1]\n--/\//.lastIndex; …`<br>• `x = { a: 1 }\n++/\//.lastIndex; …`<br>• `const f = () => {}\n++/\//.lastIndex; …`<br>**All valid JS:** Bun runs the first and second.<br>**Mutant:** V-ev2 (drop `}` from `endsValue`) survives, so no test pins `}`.<br>**HEAD caught all of them** (it read `+`/`-` as a regex start).<br>**Fix:** for `++`/`--`, a line break between the operand and the operator means prefix; and `}` never ends a value there. |

## LOW

| # | Where | Finding |
|---|---|---|
| R3-L1 | test/web/architecture.test.js:145 | **The old `of` hole is narrowed, not closed.** A variable named `of` on a new line after a value (`const z = y\nof / 2; import(d); …; const w = 1 / 3;`, valid JS by ASI, which Bun runs) is still read as the `for…of` keyword and hides the import. It needs a variable named `of` plus a line break. **Fix:** the same line-break rule as R3-M1. |

## Checks

1. **R2-M2, fixed:**
   - **Page rig:** the builder's case (my case) gives 1 reopen; the control reopens. V-M2 and V-M2b are killed, and so is V-M2c (`hellos` read at fire time, 7 tests).
   - **Chrome** (production rig in a scratch worktree with HEAD's server and the job's files, port 0). The page's WebSocket was wrapped to hold every incoming message, and `online` was fired with random 0.5:

     | Case | Before release | After release |
     |---|---|---|
     | Viewer, drop at 1.9 s, backoff socket's replies held past the 7.5 s probe | 1 socket, `connecting` | 1 socket, 1 hello, `live` |
     | Viewer control (silent link, nothing sent) | the probe reconnected: 1 socket | `live` |
     | Editor, drop, held | 1 socket | 1 socket, 1 hello, `live` |

   - **Other paths to two hellos** (all by reading):
     - **Pill and Retry:** guard, cancel and the `hellos` check.
     - **Visibility vs online:** one timer.
     - **A welcome or a hello at fire time:** the `hellos` check covers a hello still waiting. A welcome is a heard message.
     - **A local action:** no longer counts.

     No path to two hellos found.
2. **R2-H1, R2-H2 and R2-H3, fixed:**
   - **Mutants:** V-H3c, V-L1c and M1e are killed.
   - **V-L1d, equivalent (builder's claim confirmed):** `reconnectNow()` → `S.reconnect()` → `reopen()` → `connect()` bumps `hellos` on every path that does anything (`reopen` returns early only when closed), so the probe stands down whether or not it was cancelled.
3. **R2-M1:**
   - **Caught:** the prefix `++`/`--` lines from round 2.
   - **Still pass:** round 2's postfix cases.
   - **Mutants:** V-R2M1, V-R2M1b, V-ev (`]`), V-ev3 and V-ev4 are killed. V-ev2 (`}`) survives (R3-M1).
   - **New evasions of the changed rule:** five (R3-M1).
4. **R2-L1, fixed:**
   - **Mutants:** V-R2L1 is killed.
   - **The welcome and every room message still count:** they reach `transport.onMessage` on the current connection. V-R3b (`onHeard` never fires) kills 2 tests, including C-4.
   - **The visibility check still uses the heard stamp:** V-R3c is killed.
   - **The limit refusal (`error`/`limit`) also counts as heard.** That's harmless: `shouldProbe` refuses `limited` anyway.
   - **Order:** see R3-H1.
5. **R2-L2:**
   - **Caught:** `const x = of / 2; import(d)`.
   - **Not misread:**
     - `for (const x of /\//…)`
     - `for (const { a } of /\//…)`
     - `for (o.p of /\//…)`
     - `return of / 2`
     - `typeof ++/\//…`
   - **Mutants:** V-R2L2 and V-R2L2b are killed.
   - **Remaining:** R3-L1.
6. **No regression:**
   - **Round 1's 49 mutants:** the same 42 killed. M1c and V-4c are moved patterns. V-2f (mis-built), V-L5b, V-2g and V-4f are equivalent, as before.
   - **Round 2's 20:**
     - **Killed:** every gap found in round 2 (V-1g, V-H3c, V-L1c and the rest).
     - **Surviving, equivalent:** V-L1d, V-L5b, V-2g.
     - **Moved (code rewritten by round 3):** V-H3b, V-H3d, V-L1b and V-L6. Re-made for round 3 as V-M2c and V-L1b, and killed.
   - **Round 3:** 19 of mine. 16 killed; V-R3a, V-L1d and V-ev2 survive (above). The builder's 12, re-created from its table, are covered by these and all die except V-L1d.
   - **Chrome re-runs:**
     - **Round 1's H3 case:** 1 socket, 1 hello (viewer and editor).
     - **Double-click on the pill:** 1 socket.
     - **`dropConnection()`:** 1 closed, 1 new, live.
     - **`fail()` after `close()`:** 0 sockets.
     - **No token:** none in 57 URLs, localStorage (empty), the console or the server log (18 lines).
   - **Assertions:** all of round 1's and round 2's test cases are still present. The only line newly removed against HEAD is helper code (the keyword `return` in `regexMayStart`), not an assertion.
   - **Files:** only the job's files are changed in web/, test/web/ and packages/.
   - **`bun test` (full, shared tree):** 1453 pass, 155 skip, 1 fail (the known test/core-source.test.js; 1609 tests, 86 files).
   - **test/web in the worktree:** 805 pass.
   - **Flakiness:** p8-tidy, ui-app, collab/perf, ui-land, class-transport and web architecture together gave 125 pass, 0 fail in 6 runs out of 6.

Files (my scratchpad): `tools/muts-r3.json`, `mut-r3.txt`, `mut-r1-r3.txt`, `mut-r2-r3.txt`, `probe3/`, `drive3.out`.

## What I did NOT check (round 3)

- **Real network events in Chrome:** a real `offline`/`online`, sleep or `visibilitychange` (synthetic events; held messages stand in for a slow welcome).
- **R3-H1 reproduced end to end:** found by mutant and reading. I didn't build the resync-while-down case.
- **Jitter by role, emotes and zoom:** not re-run in Chrome. Round 3 didn't touch them; their mutants still die.
- **No sdd ensemble this round.**

## Cleanup (round 3)

- **Chrome:** PID 51737 (recorded in `pids`), stopped by the driver and confirmed gone.
- **Scratch worktrees:** wt5 and wt6 removed (literal paths), and nothing was killed by pattern.

# Round 4 (docs/m2/briefs/p8-tidyv4.md)

**PASS, with two LOWs.**

- **Fixed:** R3-H1 (ruled MEDIUM), R3-M1 and R3-L1, each tested. The builder's own CR/LS/PS fix holds for `++` and for `//` comments.
- **No regressions** in runtime behaviour, tests or files.
- **Both LOWs are regex-scanner cases,** rated by the brief's rule: LOW unless plain code would write it by accident.
  - **R4-L1 is a regression the round-4 line-terminator change introduced:** a raw U+2028 in a string. The case for MEDIUM is made below; I rate it LOW.
  - **R4-L2 is a test gap.**

## LOW

| # | Where | Finding |
|---|---|---|
| R4-L1 | test/web/architecture.test.js:121 | **A raw U+2028 or U+2029 inside a string literal now ends the string,** so its closing quote opens a new one that hides the rest of the line.<br>**Example:** `const s = 'a<U+2028>'; import(d); Date.now();` gives **0 imports and no globals**.<br>**The cause:** round 4 made the string scan stop at any `isLT`. But since ES2019, U+2028 and U+2029 are **legal inside string literals**, while CR and LF are not. Bun runs `const s = 'a<U+2028>b', u = "c<U+2029>d"; Date.now()`.<br>**A regression:** HEAD's and round 3's string scans stopped only at `\n`, and a HEAD worktree catches this line (1 import, `Date.now`).<br>**The case for MEDIUM:** text pasted from a word processor or a JSON payload can carry U+2028, and ES2019 made it legal for exactly that reason.<br>**Why I rate it LOW:** no file in web/ or packages/ contains U+2028, U+2029 or CR today. It needs both such a string and a forbidden import or global later on the same line. And the parser-based scan replaces this code soon.<br>**Fix:** strings end at `\n` and `\r` only. Comments and regex literals keep ending at all four line terminators. |
| R4-L2 | test/web/architecture.test.js (`endsValue`, `}` branch) | **Untested branch:** `}` counting as a value inside `endsValue` (it now matters only for `of` after an object pattern) has no test. Round 3's mutant V-ev2 (drop `}` from `endsValue`) survives.<br>**What it affects:** `for ({ a } of /\//.exec(s)) f(a); import(d)` is caught today but wouldn't be under the mutant. A destructuring for-of with a regex literal as the iterable is unlikely by accident, so LOW. The `}` rule for `++` (round 4's own) is pinned: V-ev2' is killed. |

## Checks

1. **R3-H1, fixed:** the new ui-app case "p8-tidyv R3-H1: a message on the old socket while the link is down…" **fails with V-R3a** (`onHeard()` above the closed/down check) and passes without it (test/web 806 pass).
2. **R3-M1, fixed:**
   - **All five of my lines are caught:** newline then `++`, a block's `}`, `]` then a newline then `--`, an object literal's `}`, an arrow body's `}`.
   - **Postfix cases still divide:** `i++ / 2`, `i-- / 2`, `a[i]++ / 2`, `(a)++ / 2`, and `x /* c */ ++ / 2`.
   - **Mutants:** V-ev2' (`}` treated as a value for `++`) and V-nl (a line break doesn't make it prefix) are killed. Round 3's V-ev2 targets `endsValue`'s own `}` (R4-L2).
3. **R3-L1: the builder's departure is confirmed right.**
   - **Why:** `for (const x\nof /\//.exec(s)) …` is a legal for head. The line-break rule would read `of` as a name there and hide the import. The for-head rule catches both.
   - **Caught:** `const z = y\nof / 2; import(d)`. So are `f(y, of / 2)` and `for (let i = of / 2; …)`.
   - **Not misread:**
     - `for (const x of /\//…)`
     - `for (const x\nof /\//…)`
     - `for (const { a } of /\//…)`
     - `for await (const x of /\//…)`
     - a nested arrow in the head: `for (const x of f((a) => a))`, which the builder only reasoned
     - `of` used as a name inside an arrow body inside a for head
   - **Mutants:** V-of1, V-of2 and V-of3 are killed. V-of4 (`.for` counts as a head) is equivalent: `o.for(x of y)` isn't valid JS.
4. **The builder's own evasion, fixed:**
   - **`++` after a line break:** CR, CRLF, U+2028 and U+2029 before `++` are all caught.
   - **`//` comments:** a comment ended by CR or U+2028 no longer hides the next statement.
   - **Mutants:** V-LT (only LF), V-LT-CR and V-LT2 (`//` ends only at LF) are killed.
   - **But see R4-L1:** the same change wrongly ends strings at U+2028.
5. **No regression:**
   - **Runtime files:** web/ is unchanged since round 3 (last modified 14:51, before my round-3 run). Round 4 touched only test/web/architecture.test.js and test/web/ui-app.test.js.
   - **Mutants, all three rounds re-run (103):**
     - **Killed:** every gap from rounds 1 to 3.
     - **Survivors:** V-ev2 (R4-L2), V-of4 (equivalent), and the already-judged equivalents V-L1d, V-L5b, V-2g, V-2f and V-4f.
     - **Moved patterns, re-made with unique context and killed:** V-4c, V-M1, V-M1b (now duplicated by `inForHead`), and V-R2M1/V-R2M1b (re-made as V-R2M1'/V-R2M1b').
     - **Other moved patterns:** covered by round 3's and round 4's versions.
   - **Assertions:** none removed. The lines newly removed against HEAD are scanner helper code (the LF-only checks replaced by `isLT`). The architecture test's `expect(n(…))` / `expect(hits(…))` lines went from 58 to 83.
   - **Files:** only the job's files are changed in web/, test/web/ and packages/.
   - **Chrome:** not re-run, because no runtime code changed since round 3's Chrome pass.
   - **`bun test` (full, shared tree, now):** 1459 pass, 155 skip, **1 fail** (the known test/core-source.test.js; 1615 tests, 86 files).
   - **The builder's 7 fails are not in this run:**
     - **test/deploy/cluster-rig.test.js:** 11 pass, 1 skip, 0 fail. The result is the same in a scratch copy of the shared tree with **only the job's files reverted** (other tracks' 19 changed and untracked files copied in), so it doesn't depend on this job either way.
     - **test/server/nats-bus.test.js alone:** 15 pass, 15 skip, 0 fail.
   - **Flakiness:** p8-tidy, ui-app, collab/perf, ui-land, class-transport and web architecture together gave 126 pass, 0 fail in 5 runs out of 5.

Files (my scratchpad): `tools/muts-r4.json`, `tools/muts-r4b.json`, `tools/muts-all-r4.json`, `mut-r4.txt`, `probe4/`.

## What I did NOT check (round 4)

- **Chrome:** no runtime change this round.
- **The builder's cluster-rig and nats-bus fails as they happened:** they didn't reproduce. I can only say that cluster-rig gives the same result with and without the job's files.
- **Template literals containing U+2028 / U+2029:** legal, and the scan should keep them as text. Not probed.

## Cleanup (round 4)

- **Scratch worktrees:** wt7 (mutants) and wt8 (HEAD, then the job-reverted copy) removed, by literal paths.
- **Processes:** no browser or server started by hand. cluster-rig's own processes are managed by its test.

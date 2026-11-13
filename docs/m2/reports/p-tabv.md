# Report: p-tabv (verify p-tab: hello.tab, per-tab counting, writer caps)

Verifier p-tab (engine), for manager engine (t18m). Checker only: no tracked file edited, nothing committed.

## Verdict: PASS (0 HIGH, 1 MEDIUM, 3 LOW)

Repros: every scratch test named below is in docs/m2/reports/p-tabv.attack.js.txt (its header gives the one
instrumentation line the map-size tests need and the V1 mutation).

The code does what the brief decided. No leftover mutation in the real tree, no cap evasion found, no leak after
any churn tried, both caps hold for hellos that wait together. The findings are a spec that now contradicts itself
outside the builder's owned sections, and test gaps.

## Findings

### MEDIUM

**M1. PROTOCOL.md contradicts itself on the writer cap and the per-user write bound.**
- The new § Messages `hello.tab` (PROTOCOL.md:296-305) says 8 writer **tabs** + 2 connections per tab, so
  "16 × 20 ops/s through one gateway".
- These lines still say the old rule:
  - PROTOCOL.md:26 (v1.1 table): "≤ 8 writer connections per (user, board) per gateway".
  - PROTOCOL.md:191 (§ Limits): "≤ 8 per gateway; a ninth writer `hello` gets `limit`".
  - PROTOCOL.md:221-224 (§ Pacing): "at most **8** writer connections … one user writes at most 8 × 20 ops/s".
  - PROTOCOL.md:276 (no-`id` errors): "a ninth writer connection".
  - PROTOCOL.md:785 (§ Bus `.here`): "its number of viewer **connections**", against § Presence (PROTOCOL.md:572),
    which now says viewer **tabs**.
- The new block says "This replaces the count of 8 writer connections in § Limits and § Pacing", so a careful
  reader can reconcile it. But 8 × 20 and 16 × 20 are both stated as the bound. The builder couldn't fix these
  (not owned) and lists the same lines with suggested text in docs/m2/reports/p-tab.md "Risks".
- **Repro:** `grep -n "writer connection\|viewer connections\|8 × 20" PROTOCOL.md`.
- **Fix (manager's call):** apply the builder's suggested replacements table.

### LOW

**L1. "tab is never forwarded to the room" is not tested: the assertion is vacuous.**
- test/server/tab.test.js:40 checks `r.inbox` for a `tab`. But in that test every accepted hello is a viewer
  (never forwarded) and every writer hello is refused, so nothing with a tab ever reaches the inbox.
- **Mutation V1** (server/gateway.js:969: `forward(ws, { …, client: msg.client, tab: msg.tab })`) passes
  all 7 tests in tab.test.js. My scratch test "writer hello with tab: the forwarded hello has no tab" (p-tabv.attack.js.txt; a writer hello with `tab`, then read the forwarded hello in
  `r.inbox`) kills it.
- The code itself is right: `forward` builds a fresh hello without `tab` (server/gateway.js:969).

**L2. The 8-tab refusal still says "connections".**
- server/gateway.js:919: `at most 8 open writer connections per user on a board`, although it now counts tabs.
  Pinned byte-for-byte by test/server/v1.test.js:148 (not the builder's), so the builder kept it. The builder already reported it.

**L3. A per-tab refusal after a network flap shows the client "too many open tabs".**
- Both refusals are `limit` with no `id`. § Pacing (PROTOCOL.md:222) has the client say "too many open tabs on
  this board" for that error. Only `message` differs (`…per tab…` and `…per user…`).
- A user with one tab and a half-open socket can therefore see "too many open tabs". This is in the spec's
  "May happen", and it is cosmetic. The builder already reported it for p7-tab.

## What I checked

### 1. Leftover mutations: none
- I read the gateway.js, replica.js and envelope.js diff hunk by hunk. Nothing is disabled, inverted or off by one:
  - **Format check:** gateway.js:886, `msg.tab !== undefined && !isTab(msg.tab)` → `badFrame`, beside the client and since checks.
  - **Keys:** `tabKey`/`tkey` at :910.
  - **Caps:** `tooMany()` at :915-921. It checks `mine >= maxConnsPerTab` first, then `mine === 0 && writers >= 8`.
  - **Where it runs:** before the awaits (:922) and again in the synchronous go-live step (:942).
  - **Count up:** :951 bumps `writersBy` on a tab's first connection, then `tabConns`.
  - **Count down:** `end()` at :210 drops `tabConns` and, on the tab's last connection, `writersBy`.
  - **Viewers:** `hereCount` at :738 keys viewers `user|tabKey`, and `hv = hvTabs.size`.
  - **Defaults:** `LIMITS` defaults are 8 and 2.
  - **Replica:** it sets `hello.tab` only when given and throws on a bad one.
  - **envelope.js:** `TAB_RE = /^[A-Za-z0-9_-]{1,32}$/`.
- gateway.js, replica.js and envelope.js in the real tree are byte-identical to my worktree copies, and every
  mutation result above was measured against them.

### 2. Cap evasion: none found
- **Review:**
  - Role changes close the connection (1012) and never re-label it, so a connection's `wkey`/`tkey` can't go stale.
  - A user has one role per board, so a viewer and a writer can't share a tab under one user.
  - A refusal in either `tooMany()` call happens before the connection is live, so `end()` decrements nothing that was never counted.
- **Key collisions:**
  - A tab key is `t:<tab>`; a no-tab key is `c:<conn id>`, and conn ids look like `c-<base36>-<n>` (gateway.js:100).
  - A tab can't contain `:` or `|`, so `t:…` never equals `c:…`.
  - Neither kind of tab key contains `|`, so `user|board|tabKey` and `user|tabKey` read back unambiguously from the right.
- **Scratch tests (all pass on the real code):**
  - **Slow sign-in race:** 12 hellos sent together (`verifyDelayMs` 80): 3 on one tab and 9 on new tabs. At most 2 get in on the shared tab, and exactly 8 distinct tabs get in. Caveat: `verifyDelayMs` may not make hellos overlap at the cap checks (the builder's trace found this). The real overlap test is the builder's slowed-`rooms.open` test, which M11 fails.
  - **Viewer and writer on one (user, tab):** a user joins as a viewer on tab X, is re-granted editor with no grants message (so the viewer connection stays), then joins twice more on X. Both writer connections get in, a 3rd gets `limit`, and `viewers` stays 1. So the viewer connection doesn't count toward the per-tab writer cap, and every map is empty after closing.
  - **Mixing:** 4 no-tab and 4 tab writers fill the 8. A 9th of either kind is refused; a 2nd connection of an open tab gets in.
  - **Lookalikes:** tabs `c` and `t` each open a tab of their own next to 6 no-tab writers, and the 9th tab is refused.
  - **Two users:** the same tab string from two users counts as two tabs. The builder's test covers this (tab.test.js:55-57 viewers, :87 writers), and I re-read it.

### 3. Leaks: none found
- **Direct map sizes** (scratch test "MAPS", with the worktree gateway exposing `writersBy.size`, `tabConns.size`,
  the summed `hvTabs.size` and `hv`): after each of these, all four go back to 0: open/close with refusals, closes
  mid-hello behind a slowed rooms.open (writers and viewers), rooms.open failures, token-expiry closes (writers
  and a viewer), and role-change closes.
- Each scratch case ends with `capsClean`: 8 fresh tabs get in and a 9th is refused; then 2 connections on one tab get in and a 3rd is refused.
- **Mid-hello closes after the first cap check:** rooms.open slowed by 150 ms; 3 rounds of 9 hellos (4 tabs) were
  closed while waiting. Caps were clean afterwards.
- **rooms.open failing** (`down("room")`): 12 hellos on 3 tabs were refused 1013. Caps were clean afterwards.
- **Token expiry closes:** 8 tabs, a 2nd connection on one tab, and 3 viewers (2 on one tab, 1 no-tab) with
  `exp` = now + 2 s. All closed on expiry, `here.viewers` went 2 → 0, and caps were clean afterwards.
- **Role-change closes** (editor to annotator, then a grants message): all 8 closed 1012. Caps were clean after the grant was restored.
- **Builder's churn test:** it covers open/close, refusals and closes during sign-in.
- **Mutations:** M4 (no decrement) fails both of my close-path tests, so they do detect a leak.

### 4. here.viewers
- **Code:** distinct `user|tabKey` per board per gateway; a no-tab connection is `c:<id>`, so it counts once. The
  `.here` bus message still carries one number, `viewers: b.hv` (gateway.js:757). Nothing new goes on the bus.
- **Tests:** covered by tab.test.js:44-65. Under expiry closes I saw it return to 0.

### 5. Wire
- **Bad tabs:** wrong type, empty, 33 chars, `é`, `:`, `.` and space all get `bad-op`, 1008 (tab.test.js:33-40; M7 kills it).
- **Not forwarded:** the room never gets `tab` (by code; see L1 for the test gap).
- **Replica:** sends `tab` only when given; the key is absent otherwise (test/replica.test.js:468-482).
- **Spec against code:** caps 8 and 2, code `limit`, close 1008, no `id`, and both messages match. The spec does
  contradict itself outside the new sections (M1).

### 6. Mutations (scratch worktree only)
Run in a `git worktree` in the session scratchpad with the uncommitted diff applied (no `.env`). The worktree and every scratch file were removed at the end.

| Mutation | tab.test.js | my scratch tests |
|---|---|---|
| M7 format check removed (builder's) | **killed** (format test) | survives (not its job) |
| M11 go-live re-check removed (builder's) | **killed** (wait-together test) | survives |
| M2 per-tab cap removed (builder's) | **killed** (3 tests) | killed (5) |
| M4 no decrement on close (builder's) | **killed** (4 tests) | killed (2) |
| V1 forward `tab` to the room (mine) | **survives**: L1 | killed |
| V2 decrement `writersBy` on every close, not only a tab's last (mine) | **killed** (writer cap test) | survives |
| V3 per-tab cap off by one, `>` (mine) | **killed** (3 tests) | killed (5) |

### 7. Gates (real tree)
- **`bun test test/server` 5×:** 276 pass, 0 fail each run. The v1.test.js pacing flake did not show.
- **`bun test` once:** 1533 pass, 1 fail. The failure is `packages/core is still herdr-draw's core`, the known
  drift. test/server/main.test.js passed in this run.
- **test/purity.test.js and test/architecture.test.js:** 17 pass, 0 fail.
- **Machine load:** other agents' suites (test/load, test/deploy, another test/server) were running at the same time.

## Ensemble review (sdd, BRIEF-BASE)

The p-tab diff only, reviewed in a scratch copy (no `.env`).

| Harness | Result | My check |
|---|---|---|
| codex (effort high) | No HIGH. **MEDIUM:** web/core/sync.js:77 builds `new Replica({ client, now, random })` without `tab`, so browsers don't send it yet. **LOW:** stale cap text in PROTOCOL.md (= my M1) | **Confirmed, but not p-tab's.** web/core/sync.js:64 and :76 say "Kept, NOT sent yet… add `tab` when PROTOCOL.md has it". That is the client's p7-tab, which waits on this job. Until it lands, browsers count one tab per connection, as before |
| agy | Failed: quota (`RESOURCE_EXHAUSTED`, resets in about 44 h) | n/a |
| grok (check_adapter ok) | Claims 2 HIGH, 1 MEDIUM, 2 LOW | **All refuted (below).** No two harnesses agree on any HIGH |

grok's claims, refuted:
- **"Hellos that wait together evade the caps":** the second `tooMany()` (gateway.js:942) and the increment (:951)
  run in one synchronous step with no await between them. M11 (removing that check) fails the builder's test, and
  my mid-hello and slow-open probes held the caps.
- **"A viewer closed mid-hello leaks `hvTabs` through an unset `c.tabKey`":** `hereCount(c, -1)` runs only inside
  `if (wasLive)` (gateway.js:208-211), and `tabKey` is set in the same `Object.assign` that makes the connection
  live (:944-945). The MAPS probe closed viewers mid-hello and `hvTabs` was 0.
- **"`|` in conn ids or user/board ids makes keys collide":** conn ids are `c-<base36><base36>-<base36>`
  (gateway.js:100), so they contain no `|`. Board ids match `/^[a-z0-9][a-z0-9-]{0,63}$/` (server/ids.js:4). Tab
  keys contain no `|`. So `user|board|tabKey` and `user|tabKey` read back unambiguously from the right, even if a
  user id contains `|`.
- **LOWs:** the stale spec text is already M1. The "fragile" order in `end()` is not a defect: `hereCounted`
  guards it.

## Not verified
- **Cluster:** the cross-gateway double count on Postgres + NATS. The spec states it as "may happen"; no rig was run.
- **Real browser:** a real browser client (p7-tab) sending `tab`.
- **Replica mutations:** M8 and M9 were not re-run. I read the test (it checks both the key being present and its absence), and it looks sufficient.

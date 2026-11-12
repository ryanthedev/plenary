# Round 2 (fix round 1), 2026-11-11

**PASS** — all 4 round-1 HIGHs fixed; each HIGH's mutant now fails a contract test. 0 HIGH, 1 MEDIUM, 4 LOW (none blocks).

Checked against the files, not the builder's "Fix round 1" map. Method:
- `diff -ru` of the job's four folders against my round-1 snapshots (`scratchpad/m/web.r1`, `test.r1`).
- Every round-1 mutant re-run, plus 17 new ones (`scratchpad/m2/mut.sh`, a fresh copy, restored by copying `orig/`).
- My localRoom scratch tests re-run with my own `hold()` driver (`scratchpad/p2/local.contract.test.js`), written before reading the builder's.

## Tests and scope

- **Full suite:** `bun test` gives **507 pass, 78 skip, 0 fail**. The job's own tests: 113 pass, 0 fail.
- **What changed:** the four ports, `adapters/auth/fake.js`, `adapters/clock/{browser,virtual}.js`, all four contracts, `reference-transport.js` (adds `hold`), and `test/web/adapters/{auth,clock}.test.js`.
- **Unchanged:** the storage adapters, `test/web/adapters/storage.test.js`, and `reference-transport.test.js`.
- **Still untracked and new:** no tracked web/ or test/web file changed.
- **Imports:** only the three storage adapters import anything (`../../ports/storage.js`). Ports import nothing and touch no browser globals.

## Each round-1 finding

| Round 1 | Now | Evidence |
|---|---|---|
| **H1** transport: late traffic on an old connection | **Fixed** | REQUIRED `hold()` → `emit(i)`, plus 5 tests (`transport-contract.js:134-217`). localRoom with my driver (`Room.prototype.connect` captured; `emit` calls the room-side `conn.send` directly, bypassing Room's `closed` guard): unmutated 18/18 pass; **M1 (`link.gen === gen` removed): 3 fail; M9 (also no `room.disconnect`): 3 fail**. M2, M3, M4, M6 and M7 are killed too. `stale.test.js` still fails under M9 and passes unmutated. Reference transport: TR4 (no gen check on the hold path) gives 3 fail. |
| **H2** auth field types | **Fixed** | `web/ports/auth.js:7-12, 32` matches auth-exchange.md "Field types": `user` a non-empty string; `name`, `email`, `domain` string or null; `exp` integer. `expectAuthResult` (`auth-contract.js:21-33`) requires non-empty `token`/`user` and nullable fields. New tests mint nulls and check strings pass through unchanged. Mutants killed by the contract: AU5 (null name/email becomes `""`), AU8 (null domain becomes `""`), AU9 (empty `user`). |
| **H3** auth errors collapsed or rejected | **Fixed (when `force` is wired; see MEDIUM R2-M1)** | `force(kind)` plus 5 tests (`auth-contract.js:95-121`). Killed by the contract: AU1 (all become `unavailable`, 4 fail), AU3 (rejects, 6 fail), AU4 (`network` becomes `unavailable`, 3 fail), AU7 (`malformed` leaks as its own value). |
| **H4** storage key collisions | **Fixed** | A 20-key test (`storage-contract.js:66-78`) kills: SL1 (case-fold), SL2 (truncate to 8), SL9 (memory case-fold), SL10 (NFC), SL11 (trim), SL12 (truncate to 1000), SL13 (`.`/`_` become `-`). |
| **M1** virtual exact-boundary timer | **Fixed** | Contract test `clock-contract.js:38-43`; CK6 (`<=` becomes `<`) is killed by the contract. |
| **M2** monotonic clock | **Fixed in the port** | `mono()` added (`web/ports/clock.js:5-11, 26`). browser: `performance.now`, else a never-backwards clamp over `Date.now`. virtual: `t`. Contract: never backwards, moves with time. Killed: CK8 (virtual mono frozen), CK9 (browser mono decreasing), CK13 (virtual mono dips). Killed by the adapter test only: CK10, CK12 (fallback unclamped). Frames stay out of the port (DOM adapters own them), matching p6-hex.md. **Still open for p6-hex/engine:** the Replica (`replica.js:90, 351, 364, 423`) and `presenceLimiter` still take one `now` for deadlines; the port comment says so. |
| L1 logging | **Fixed** | A console spy in the storage and auth contracts, checked in `afterEach`. SL6 (session logs the value): 11 fail. AU6 (fake logs the token): 4 fail. |
| L2 shared instances | **Fixed** | `storage-contract.js:80-87`; SL8 is killed. |
| L3 auth retry jitter | **Fixed (documented)** | `web/ports/auth.js:19-21`. |
| L7 Net / Blobs port | **Open** | Not in this round; carried to p6-hex. |

Round-1 mutants that still die: SL3, SL4, SL5, SL7, CK1–CK5, CK7, AU2, TR1–TR3.

## Round 2 findings

**MEDIUM**

- **R2-M1. The auth failure tests silently pass when the adapter gives no `force`.** `test/web/contracts/auth-contract.js:100, 109`.
  - Each test does `if (!force) return;`, which counts as a pass, not a skip.
  - So p6-hex's `auth/http.js` registered without a fake-`fetch` `force` would pass `authContract` while collapsing or rejecting errors, which is the H3 gap again, by wiring.
  - The transport side guards against the same mistake with a "hold() is provided" test; auth has no equivalent.
  - **Fix:** a test "force is provided" unless `opts.live` (a real server), or `test.skipIf` on an option known at registration.
  - Found by codex; I confirmed it by reading. No run is needed: the early return is unconditional.

**LOW**

- **R2-L1. Nothing tests that the browser clock uses `performance.now` when present.** CK11 (always use the `Date.now` clamp) survives. The clamp is still monotonic, so the contract rule holds. The cost is that after a backward NTP step `mono` freezes and deadlines run late. Add an adapter test that `mono` follows a stubbed `performance.now`.
- **R2-L2. `exp` in seconds is checked only by the fake's own test.** AU10 (`exp * 1000`) is caught by `auth.test.js:11-15`, not by the contract. An HTTP adapter returning ms (or the server sending ms) passes `authContract`. Add a sanity bound in `expectAuthResult` (for example `exp < 1e11`).
- **R2-L3. Equivalent mutants, all accepted:**
  - localRoom M5 (`close` doesn't set `done`): the link is already removed from `links`.
  - localRoom M8 (room never told): the gen check hides it from the client. It is a far-side leak, not a transport rule.
  - TR5 (hold path ignores `done`): `close()` bumps `gen` anyway.
- **R2-L4. Still for p6-hex** (not this job's files):
  - Replica and `presenceLimiter` onto `mono`.
  - A UI fallback for a null `name` (`app.js:251` crash; collab's "null" text at `collab/ui.js:124, 177`).
  - The localRoom driver as a real test. It needs a seam for the room-side connection; my scratch driver patches `Room.prototype.connect`.
  - The Net/Blobs port (L7).

## sdd: single harness (codex, effort high, on the round's diff in `scratchpad/cx`)

- **Verdict:** FAIL, with 2 MEDIUM findings. This time the prompt was neutral and named no suspected defects.
  - **Refuted:** "reference-transport.js:50, `hold()` filters old traffic itself, so a broken generation check passes". The check codex cites *is* the reference transport's own generation check, the adapter under test there; `hold` only queues the far side's send. Removing it (TR4) fails 3 contract tests. And on localRoom my driver's `emit` has no filter, and M1/M9 are killed.
  - **Confirmed:** the `force` early return, which is R2-M1 above.

## Not checked in round 2

- No real browser, sharedNet against the contract, or HTTP auth adapter (same as round 1).
- I did not read the builder's localRoom driver. I wrote my own, and it reaches the same M1/M9 result.

---

# Round 1

**FAIL** — 4 HIGH (three contracts pass adapters that break their own rule; the auth port can't express the real wire shape), 2 MEDIUM, 7 LOW.

# Verify: p6-portsv (web ports, adapters, contract tests)

Verifier p6-portsv (client), 2026-11-11. Read only; nothing in the repo changed except this report. All mutation
work ran in scratch copies under
`/private/tmp/claude-501/-Users-r-repos-plenary/e7060f2f-6c24-4afc-b622-93512ab109d8/scratchpad/` (`m/` = copy of
the job's files + `mut.sh`; `p2/` = copy of plenary-p2's web/ + packages/ with `local.contract.test.js` and
`stale.test.js`; `cx/` = git copy given to codex).

## Check 1: tests and scope

- `bun test` (full): **478 pass, 78 skip, 0 fail** (556 tests, 32 files). Job only: 86 pass, 0 fail.
- My own runs left the repo and p2 untouched. `diff -r` of the job's four folders against my pre-mutation snapshots (`scratchpad/m/web.orig`, `test.orig`) is empty, and `git status` in /Users/r/repos/plenary-p2 is clean.
- The job's files are all new and untracked (`web/ports/`, `web/adapters/`, `test/web/contracts/`, `test/web/adapters/`).
  No tracked web/ or test/web file is modified. Other modified files in the tree (server/auth/http.js,
  test/auth/*, docs) belong to platform/manager work and are not referenced by this job; I could not attribute
  them by timestamp alone, but none is imported by or imports the job's files.

## HIGH

**H1. Transport contract cannot see late far-side traffic on an old connection (the `link.gen === gen` mutation survives).**
`test/web/contracts/transport-contract.js:11-16, 76-105`.
- Ran `transportContract` against a scratch copy of p2's real `localRoom` using the builder's §7.2 driver: 13/13 pass (reproduces the builder's dry run).
- Mutated localRoom (`/Users/r/repos/plenary-p2/web/sync.js:354`, scratch copy):

  | Mutant | Contract |
  |---|---|
  | M1: `link.gen === gen` removed | **13/13 pass (survives)** |
  | M8: `room.disconnect(link.conn)` removed from `drop` | 13/13 pass (survives) |
  | M9: both removed | **13/13 pass (survives)** |
  | M2/M3: drop keeps the down queue | 3 fail (killed) |
  | M4: drop keeps the up queue | 1 fail (killed) |
  | M6: fail reports onDrop twice / M7: reopen reports onDrop | killed |
  | M5: `close` doesn't set `link.done` | survives (equivalent: the link is already removed from `links`, so nothing is delivered) |

- **M9 is a real bug the contract misses.** In `scratchpad/p2/stale.test.js`: A and B say hello; A reopens (new connection, no hello yet); B commits an op. Under M9 the room broadcasts `entries` to A's old, still-registered connection, and A's handler receives it on the new generation (`A [ "entries" ]`, test fails). Unmutated: `A []`.
- M1 alone is close to equivalent today, because `Room` skips `c.closed` connections (`packages/protocol/room.js:246, 317, 405`). The generation check is the only guard when the far side doesn't know the connection is gone. That is the normal case for a WebSocket or SharedWorker (a gateway that hasn't seen the close yet keeps sending).
- **Why the contract misses it:** the driver can only queue *answers to requests* before reopen (`serve()`). localRoom puts those in `link.down`, and `drop()` clears that queue, so the check is never reached. There is no driver hook for "the far side sends on the old connection after the client reopened". The reference transport catches TR1 only because its far side is a `setTimeout` keyed by gen.
- **Fix (p6-hex, or a p6-ports follow-up):** add a driver hook such as `hold()`, which returns `emit(i)` bound to the current far-side connection. Add a test: `const old = d.hold(); reopen(); old(7); await d.flush(); expect(got).toEqual([])`, plus the same after `drop()`+`reopen()` and after `close()`. For localRoom, the hook needs a test seam that keeps the room-side `send` of the connection. Then re-run M1 and M9; both must die.

**H2. Auth port and contract use the wrong shape: `name`/`email` may be null (now in auth-exchange.md "Field types").**
`web/ports/auth.js:8-10, 28`; `test/web/contracts/auth-contract.js:23-24`.
- Real shape: `user` is a non-empty string; `name`, `email` and `domain` are each a string or null; `exp` is integer seconds.
- The port types `name` and `email` as `string`. `expectAuthResult` requires them to be strings, so **a correct HTTP adapter fails the contract** on any consumer Google account (no authoritative email) or any user with no name. Shown in scratch: `fakeAuth().mint({ name: null, email: null, domain: null })` gives `Expected "string", Received "object"`.
- The contract also accepts `user: ""` (only `token` is checked non-empty).
- **Would the UI cope? Not yet.**
  - **App chrome crashes.** p2 `web/app.js:251` calls `me.name.slice(0, 2)`. Today `me` comes from `tokenIdentity` with a `"You"` fallback (`app.js:34`). Once p6-hex takes identity from the exchange result, a null name throws there.
  - **Collab doesn't crash but shows "null".** `records-model.js:46` falls back to "Someone" only for other users; for your own records it returns `me.name`. Checked in scratch (`scratchpad/p2/nullname.test.js`): a self-authored thread with `me.name: null` gives thread name `null` and comment name `null`.
  - Avatars cope: `initials(null)` is `"?"`.
  - Text does not: `web/collab/ui.js:124` (`${t.name}: …`) and `:177` (`Resolved by ${t.resolved.name}`) render the literal "null", and the author line at `:150` is blank.
  - `presence-model.js:74` already accepts null names for others. No p2 UI code reads `email` yet.
- **Fix:** typedef `{ token: string, user: string, name: string|null, email: string|null, domain: string|null, exp: number }`. Update the comment at :8-10 (no longer ASSUMED: cite "Field types"). In `expectAuthResult`, require `user` to be non-empty and `name`/`email` to be string or null. Add a contract case minting null name/email/domain (the contract's `mint()` needs an optional fields argument). p6-hex: when building `me`, give `name` one fallback (for example the email's local part, else "You"), and show email only if present.

**H3. Auth contract cannot catch errors being collapsed or rejected.** `test/web/contracts/auth-contract.js:34-64`.
- `authContract` only exercises valid, used, unknown and malformed codes. It never provokes `bad-origin`, `unavailable` or `network`, and it never checks "never rejects" on a failure path.
- These mutants of `web/adapters/auth/fake.js` are killed **only by the fake's own test** (`test/web/adapters/auth.test.js:29`), never by the contract:
  - AU1: every forced error becomes `unavailable`.
  - AU3: the promise rejects on failure.
  - AU4: `network` becomes `unavailable`.
- So p6-hex's `auth/http.js` could collapse 403/503/fetch-throw into one value, or reject on a network error, and still pass the contract it is meant to be held to.
- **Fix:** `makeAuth()` also returns an optional `force(kind)` (fake: `setFail`; http: a fake `fetch` answering 403, 503, a throw, or a non-shape 200). The contract asserts each maps to its own value and resolves. Optional for a live server: skip those tests when `force` is absent.

**H4. Storage contract misses key collisions (a value readable or clobbered through another key).** `test/web/contracts/storage-contract.js:43-49`.
- Two mutants pass all 35 storage contract runs and every adapter test:
  - SL1: session.js case-folds keys.
  - SL2: local.js truncates keys to 8 characters.
- SL2 makes `plenary.panel`, `plenary.library` and `plenary.mine.<board>.<user>` one key (p2's real keys all share `plenary.`). Writing the panel would overwrite the library, and any of them reads another's value.
- The independence test only uses `a`, `b` and `""`.
- **Fix:** test independence with keys that differ only in case, keys sharing a long prefix (`plenary.session` vs `plenary.session.x` vs `plenary.sessio`), unicode keys, and a long key. Assert that each round-trips and that removing one leaves the others alone.

## MEDIUM

**M1. Virtual clock: a timer due exactly at the advance target may not fire, and nothing checks it.**
- `test/web/contracts/clock-contract.js:34-44` always advances past the due time. The adapter test (`test/web/adapters/clock.test.js:17-31`) never lands exactly on one either.
- Mutant CK6 (`x.at <= until` changed to `x.at < until`, `web/adapters/clock/virtual.js:16`) survives everything.
- The code is correct today. But every deterministic sync test will drive this clock (`advance(10_000)` for the per-op timeout), and a regression there makes timeouts silently not fire.
- **Fix:** add "set(fn, 20); advance(20) fires it" to the contract (`advance` lands exactly for virtual; the browser driver already adds 2 ms).

**M2. The Clock port has no monotonic time, and collab/ui.js's clock shape doesn't match it.** `web/ports/clock.js:5-6, 17-23`.
- **Monotonic time:** the port says `now()` is wall time and may jump. Core deadlines are deltas of it: Replica `helloAt`/`progressAt`/`timeLeft(this.now())` (`packages/protocol/replica.js:90, 351, 364, 423`) and `presenceLimiter` (`presence.js:60-62`).
  - By reading only, not run: a forward step (laptop wake, NTP) can fire a watchdog early, causing a spurious resync. A backward step delays it. `presenceLimiter` clamps negative gaps.
  - The UI side already uses `performance.now()` (`app.js:110, 431`; `dev.js:47`).
- **Shape mismatch:** p2 `web/collab/ui.js:34-35` takes `{ now, setTimer, clearTimer, raf }`; the port is `{ now, set, clear, random }`.
- **Why MEDIUM, not HIGH:** frames are the one thing the port truly can't express. Per p6-hex.md's table (row "adapters", `dom/`: "collab renderers"), collab/ui.js becomes a DOM adapter, and a DOM adapter may use `requestAnimationFrame` directly (`web/dev.js:122`, `web/app.js:475` do). The core collab models need only `now` and `random`, which the port has. If p6-hex instead keeps collab/ui.js in core, this becomes HIGH.
- **Fix (p6-hex):**
  - Rename collab/ui.js's calls to `set`/`clear`, and keep `raf` as a DOM-adapter concern (or add an optional `frame` to the virtual clock for its tests).
  - Either add `mono()` (performance.now) for deadlines, or document in the port why wall-time deltas are acceptable for the Replica.

## LOW

- **L1. Logging is not checked.** No contract or test catches an adapter that logs a value: mutant SL6 (`console.log(key, value)` in session.js `set`) survives. Today's adapters are clean (grep: no `console` in web/adapters or web/ports). A spy on `console.*` in `storageContract` and `authContract` (token and code never logged) would pin it.
- **L2. Separate instances sharing state is not caught.** Mutant SL8 (memoryStore's map shared through `globalThis`) survives. "A fresh adapter per test" is never checked to be independent of another instance. That matters if the root uses `memoryStore()` as the fallback for both session and local.
- **L3. Auth retry has no jitter.** The port says "ONE retry after a short wait" (`web/ports/auth.js:16-18`). At 100k joins in 2 min (~830 exchanges/s), a 503 wave retries in lockstep. Say "after a jittered wait (clock.random)", as transport backoff already does.
- **L4. `close?` in bindEditor.** p2 `web/sync.js:48` types `close?` as optional and `:252` calls `transport.close?.()`. The port is right to require it: `close` is final, and the contract tests it. p6-hex: type sync.js's `transport` as `import("../ports/transport.js").Transport` and drop the `?.`.
- **L5. In-flight answers after an unasked drop are not pinned. I agree with the builder:** sync.js ignores input while `down` (`web/sync.js:191-194` sets `down` through `connectionFailed`/resync, and `:174` returns early), so a late answer before `reopen` is harmless to the core. Only "none after reopen" matters, and H1's new hook should also cover "none after drop+reopen".
- **L7. No port for the transport factory and the blobs stand-in.** p2 `web/ui/net.js:14-58` hands the core a `{ kind, join() → Transport, put(file), onFile(fn) }` object; `web/ui/session.js:31` calls `join` once per stream. The Transport port types one connection only. p6-hex should add a `Net` typedef (`join(): Transport`) and a web Blobs port (`put`/`onFile`), so session.js depends on ports, not on net.js.
- **L6. Ownership and an accepted mutant.** `web/adapters/auth/fake.js` sits outside the builder's ownership list but is named by the brief's Build step 3, so it's fine. The surviving `/ 4294967295` random mutant is accepted (unobservable).

## Mutation results (my own mutants, beyond the builder's 27)

Killed by a contract test:
- SL3: session `set` swallows errors.
- SL4: `remove` swallows errors.
- SL5: wrong `err.code`.
- SL7: local returns null when the global is missing (killed by the adapter test).
- CK3: virtual `clear` clears all timers.
- CK4: browser `clear` is a no-op.
- CK5: `set` returns the same handle every time.
- AU2: bad input gives `unavailable`.
- TR1, TR2, TR3: replayed builder transport mutants, all killed.

Killed only by an adapter-specific test:
- CK1: virtual `now` uses wall time.
- CK2: virtual random is unseeded ("clock not deterministic").
- CK7: `now` is not moved to the advance target.
- AU1, AU3, AU4: see H3.

Survived: SL1, SL2 (H4), SL6 (L1), SL8 (L2), CK6 (M1), and localRoom M1, M8, M9 (H1).

The clock's determinism is properly a property of the virtual adapter, not the port, so an adapter test killing CK1 and CK2 is acceptable. Auth error mapping is part of the port, so for AU1, AU3 and AU4 it is not (H3).

## Check 4: do the ports cover what p2-land's web/ needs?

Method: a grep survey of p2's web/ for storage, timers, randomness, transport and identity, then reading the hits plus
`web/ui/net.js`, `web/ui/token.js`, the top of `web/collab/port.js`, `web/collab/ui.js:25-48` and
`records-model.js:36-80`. I did not read every line of web/ui/*.js or web/collab/*.js.

| Need in p2 web/ | Port | Covered? |
|---|---|---|
| Token in sessionStorage (`token.js:11, 40-50`; key `plenary.session`) | Storage | Yes. token.js swallows errors today; p6-hex catches `STORAGE_UNAVAILABLE` instead |
| Library, panel, mine-notes in localStorage (`panel.js:64-66`, `app.js:35-45`) | Storage | Yes. Keys share the `plenary.` prefix, which makes H4 matter |
| sync.js `timers`, `now`, `random` | Clock | Yes (`set`/`clear` match `timers`) |
| collab/ui.js `setTimer`/`clearTimer`/`raf`; `performance.now` | Clock | Partly (M2) |
| `newRecordId(rand)`, net.js link ids (`Date.now`, `Math.random`) | Clock `random` | Yes |
| Transport send/onMessage/reopen/close/onDrop (sync.js, net.js shared and local) | Transport | Yes, but the contract misses late old-connection traffic (H1) |
| `net.join()` factory, `put`/`onFile` blobs | — | No port (L7) |
| Sign-in exchange | Auth | Shape wrong (H2) |

## Check 3: hexagonal

- **Pass.** Ports import nothing (grep: no `import` statements in web/ports; `clock.js`/`transport.js` export `{}`, `storage.js`/`auth.js` export only constants).
- Storage adapters import only `../../ports/storage.js`. Clock and auth adapters import nothing (JSDoc type imports of their own port only). No adapter imports another.
- No browser globals in ports (the only `sessionStorage` mention is a comment, `auth.js:20`).
- Contract modules follow `test/auth/registry-contract.js`: an exported `xContract(name, make, opts)`, `describe.skipIf(!!opts.skip)`, and a fresh adapter in `beforeEach`.

## Check 5: storage security

- **No logging:** pass. No adapter logs keys or values (but see L1: nothing enforces it).
- **Not readable through another key:** pass for the current adapters, which pass the key straight to `getItem`/`setItem`. **Not enforced:** see H4.
- **Quota and unavailable storage reported, not swallowed:** pass. A missing global, a throwing getter, throwing methods and quota each throw `STORAGE_UNAVAILABLE` with `cause`, and the old value is kept on quota (adapter tests). Mutants SL3, SL4, SL5 and SL7 are all killed.

## Design check (CHECKER)

distributed-systems-design skill v0.1.0, CHECKER mode, on the four client ports.

- **Infrastructure checklist:** mostly N/A for per-browser ports (no LB, DB, cache or CDN on the client side). Two points apply:
  - **Rate limiting / thundering herd:** transport backoff is jittered from `clock.random` in the core, which is good. The auth retry is not jittered (L3).
  - **Monitoring:** none in these ports. The connection pill is the only signal. A telemetry port can come later; acceptable for M2.
- **Failure scenarios per component:**
  - **Transport:** drops and reopens are covered. Stale delivery from a far side that hasn't seen the close is **not** covered (H1). This is the main failure for a 100k-viewer gateway loss, where many clients reopen while the old gateway connection may still flush.
  - **Storage:** unavailable or full is covered. Key collisions are not tested (H4).
  - **Clock:** wall-clock jumps are named, but deadlines still run on wall time and frames have no port (M2).
  - **Auth:** final and retryable errors are well split, but the contract doesn't hold adapters to the split (H3), and the success shape is wrong (H2).
- **At 10x:** the ports don't change. Reconnect spreading stays in the core's jitter. Fine.
- **Ch12 (WebSocket, stateful connections):** the generation-per-connection model is the right one. The test gap in H1 is exactly where a real WebSocket adapter differs from localRoom.

**The builder's four flagged points, judged:**

| Point | Verdict | p6-hex must |
|---|---|---|
| bindEditor `close?` optional vs port required | The port is right | Type sync.js's transport from the port; drop `close?.()` (L4) |
| collab/ui.js clock `{ now, setTimer, clearTimer, raf }` vs port `{ now, set, clear, random }` | A real mismatch, and the port also lacks `raf` | Rename the calls to `set`/`clear`; add frames to the port, or a Frame port (M2) |
| In-flight answers after an unasked drop not pinned | Fine: sync.js ignores input while down | Cover "none after drop+reopen" with H1's hook |
| `network` failure value | **Closed:** agreed with platform (auth-exchange.md "Field types") | Nothing; drop "my choice" wording from the builder notes |

## sdd review: single harness

- **Run:** codex (`effort: high`) on a scratch git copy (`scratchpad/cx`). Usage beforehand was 11% of the 5-hour window and 8% of the weekly. The tree was left clean.
- **Verdict:** FAIL, with 5 findings: transport old-connection delivery (HIGH), auth null name/email (HIGH), auth contract never exercises the errors (MEDIUM), storage case-folding (MEDIUM), virtual clock exact boundary (MEDIUM).
- **Confirmation:** all five are confirmed by my own mutants or scratch tests (H1, H2, H3, H4, M1). I rate H3 and H4 HIGH, not MEDIUM, because the brief defines HIGH as "a contract that doesn't catch its rule being broken / storage leaking a value".
- **Caveat:** my prompt to codex named the areas to probe (late messages, key collisions, collapsed errors, the exact boundary, null fields). So its agreement is **not** independent confirmation. The independent evidence is the mutation runs.
- **Refuted:** none. Codex found nothing I hadn't.

## What p6-hex (or a p6-ports fix round) must change

1. **H1:** a transport driver `hold()` hook plus three tests (after reopen, after drop+reopen, after close). Then mutate localRoom's `link.gen === gen` with `room.disconnect` removed (M9): it must fail.
2. **H2:** auth typedef and contract to the real field types; a null-fields contract case; non-empty `user`; a UI fallback for a null `name` (`app.js:251`).
3. **H3:** an `authContract` `force(kind)` hook; each error maps to its own value and resolves.
4. **H4:** storage key-independence cases (case, shared prefix, unicode, long).
5. **M1:** exact-boundary timer test. **M2:** collab/ui.js onto `set`/`clear` (raf stays in the DOM adapter); decide on monotonic time for deadlines.
6. **L1–L3:** console spy in the storage and auth contracts; an instance-isolation test; jitter on the auth retry.
7. **L7:** a `Net` typedef (`join(): Transport`) and a web Blobs port.

## NOT checked

- **No real browser.** I did not check Chrome's sessionStorage/localStorage, private mode, a real QuotaExceededError, or real `setTimeout` clamping in a background tab.
- **sharedNet not run against the contract.** I didn't build a fake worker port; p6-hex's job.
- **The auth HTTP adapter doesn't exist yet,** so H3's risk is about what it *could* get away with, not a demonstrated bug.
- **Collision demo is in-process only.** I did not demonstrate H1's stale broadcast on the real SharedWorker room host (room-host.js), only on localRoom with M9.
- **I did not replay all 27 of the builder's mutants.** I replayed TR1–TR3 and wrote my own: 19 adapter mutants (SL1–8, CK1–7, AU1–4) and 9 localRoom mutants (M1–M9).
- **The Replica's behaviour on a wall-clock jump** (M2) is from reading replica.js, not from a run.
- **Platform's modified files** (server/auth/http.js, test/auth/*) were not reviewed. They are out of this job's scope.

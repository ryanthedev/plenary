# Report: p6-ports (web/ ports, storage/clock/auth adapters, contract tests)

Worker p6-ports (client), 2026-11-11. Status: **done**, `bun test` green (478 pass, 78 skip, 0 fail on the last run; the count includes other sessions' new tests; baseline
before this job 376 pass, 78 skip, 0 fail). Nothing committed (manager commits). Only new files; no existing file
touched.

## 1. Design (distributed-systems-design skill v0.1.0, APPLIER mode)

**Scope (phase 1).** Taken from CLAUDE.md and the brief, not asked (the brief settles it; the CEO is not a gate).
- Features: four driven ports for web/'s core (transport to a board, a small key/value store, time and randomness,
  sign-in code exchange), with contract tests every adapter must pass.
- Scale: per board ~5 editors, ~2k annotators, 100k viewers. Each browser runs one client, so these ports are
  per-client: one transport link per board, a handful of storage keys, one exchange per sign-in.
- Latency: editors < 150 ms in the home region, viewers < 1 s worldwide, 60–120 fps. So nothing in a port may
  block the frame: storage is synchronous but tiny; the transport never throws on a dead link.

**Estimate (phase 2).** Per client: storage < 10 ops per page load (token, library, preferences), well under any
quota except the library (multi-MB `.excalidrawlib` possible, hence the quota path). Exchange: 1 per sign-in; at
100k joins in 2 min that is ~830 exchanges/s at the server (platform's concern; the client side must not retry in a
loop, hence "one retry" below). Clock: one armed timer per binding (sync.js's design), so a virtual clock with a
linear scan of pending timers is fine.

**High level (phase 3).** Core (sync, session, collab models) → ports → adapters; only roots wire adapters.

```
 web/core (p6-hex)  ──uses──▶  web/ports/{transport,storage,clock,auth}.js   (types + constants; import nothing)
                                     ▲ implements
 web/adapters/storage/{memory,session,local}.js   clock/{browser,virtual}.js   auth/fake.js
 (p6-hex: transport/{shared-worker,local}.js, auth/http.js, later transport/ws.js)
```

**Deep dive (phase 4): each port's contract and failure behaviour.**

| Port | Contract | Failure behaviour | Reference (skill) |
|---|---|---|---|
| **Transport** (`web/ports/transport.js`) | The p2-land header (`send`, `onMessage` current connection in order, `reopen` required with a new generation and nothing of an older one ever delivered, `close` final, optional `onDrop` for unasked drops of the current connection), **plus rules marked [added]** in the port file: one handler (a later `onMessage` replaces it), unsent messages not carried over a reopen, send/reopen no-ops after close, each drop reported at most once, never throws for a network reason. p2's localRoom passes all of them (dry run, §5). | Never throws for a network reason; a dead link is `onDrop` or silence (the Replica's watchdog turns silence into a resync). Backoff and jitter live in the core (`Replica.reconnectWait` with the clock's `random`), never in an adapter, so 100k clients reconnecting after a gateway loss spread out the same way whatever the adapter. Messages already in flight when the far side drops may or may not arrive (a WebSocket delivers what it got before `onclose`); after `reopen` none may. | Ch12 (WebSocket: persistent, stateful connections). |
| **Storage** (`web/ports/storage.js`) | `get` → string or null (absent), `set` strings only (TypeError otherwise, never coerced), `remove` idempotent, keys independent. | Unavailable (private mode, blocked data, missing global, getter throwing SecurityError) or full (QuotaExceededError) → **throws** `err.code === STORAGE_UNAVAILABLE` with `cause`. Never a null for "could not read": null means absent, and a silent null would sign someone out or drop their library without saying so. Resolved per call, so a store that comes back is seen. Callers that can live without it fall back to `memoryStore`. | None (client-local). |
| **Clock** (`web/ports/clock.js`) | `now()` ms (wall time, **not** assumed monotonic), `set(fn, ms)` once, never synchronously, never early (ms ≤ 0 or NaN = 0), `clear` a no-op on fired/unknown handles, `random()` in [0,1), due order, all methods work detached (the object is also sync.js's `timers`). | Cannot fail. A throwing callback must not stop other timers (virtual: rethrows the first error after the advance). | Ch7 (clock drift: never rely on wall-clock order). |
| **Auth** (`web/ports/auth.js`) | `exchange(code)` **always resolves** to exactly `{token, user, name, email, domain, exp}` (exp in seconds; **assumed**, not in auth-exchange.md: the four are strings and domain may be null) or `{error}` with error in `AUTH_ERRORS`: `invalid-code` (unknown, expired, used, wrong browser, or not a non-empty string: one answer, no oracle), `bad-origin` (403), `unavailable` (503 or a malformed reply), `network` (no answer; my choice of value). | Every failure is a value, so the sign-in path has no try/catch. `invalid-code` and `bad-origin` are final (sign in again / deployment error). `unavailable` and `network`: the code may still be good for its 60 s, so **one** retry after a short wait, no loop (830/s at peak joins; a retry loop would double it). The token is never logged or put in a URL; kept in memory + sessionStorage. | Wire shape: docs/m2/contracts/auth-exchange.md. |

**Wrap-up (phase 5).**
- **Bottlenecks:** (1) a transport adapter that forgets the generation check delivers a stale `welcome`/`ops` into
  a new connection: the most likely real bug, so it has the most contract tests (4 generation tests, L3 from
  p6-landv). (2) The exchange endpoint at 100k joins (~830/s): the one-retry rule keeps clients from doubling it. (3) localStorage quota for the library: the
  quota path throws with the cause so the UI can say "library full".
- **Failure scenario:** gateway dies with 100k viewers → every transport reports `onDrop` once → the core waits
  `reconnectWait()` (jittered from `clock.random`) → `reopen` → new generation; old in-flight frames are discarded.
- **Monitoring:** not in these ports; the core's `onStatus` (connection pill) is the user-visible signal. A future
  telemetry port could count drops and exchange errors.
- **At 10x:** nothing in the client ports changes; reconnect spreading is the core's jitter, already behind the
  clock port.

## 2. Files (all new)

| File | What |
|---|---|
| `web/ports/transport.js` | Transport typedef + contract (p2-land header). Imports nothing. |
| `web/ports/storage.js` | Storage typedef + contract; exports `STORAGE_UNAVAILABLE`. |
| `web/ports/clock.js` | Clock typedef + contract. |
| `web/ports/auth.js` | Auth typedefs + contract; exports `AUTH_ERRORS`. Shape from docs/m2/contracts/auth-exchange.md. |
| `web/adapters/storage/memory.js` | `memoryStore({ unavailable })`. |
| `web/adapters/storage/session.js` | `sessionStore({ backing })`, default `globalThis.sessionStorage`, all failures → `STORAGE_UNAVAILABLE`. |
| `web/adapters/storage/local.js` | `localStore({ backing })`, same lines as session.js (adapters may not import each other). |
| `web/adapters/clock/browser.js` | `browserClock()`: Date.now, setTimeout, Math.random. |
| `web/adapters/clock/virtual.js` | `virtualClock({ t0, seed })`: `advance(ms)`, `pending`, seeded mulberry32. |
| `web/adapters/auth/fake.js` | `fakeAuth({ now, ttlMs, fail })`: single use, 60 s, `mint()` and `setFail()` test hooks. **Not in my ownership list** (the brief's Build step 3 names it); created as a new file, flagged here. |
| `test/web/contracts/{transport,storage,clock,auth}-contract.js` | `transportContract`, `storageContract`, `clockContract`, `authContract` (+ `expectAuthResult`). Not `.test.js`, so they only run when called. Each takes `{ skip }` → `describe.skipIf`. |
| `test/web/contracts/reference-transport.js` + `.test.js` | The tiny reference transport; the transport contract runs against it. |
| `test/web/adapters/{storage,clock,auth}.test.js` | Each adapter against its contract, plus adapter-specific tests (fake Web Storage with a quota; virtual clock order, seed, errors; fake auth single use, expiry, forced errors). |
| `docs/m2/reports/p6-ports.md` | This report. |

Imports checked by grep: ports import nothing; each storage adapter imports only `../../ports/storage.js`; no
adapter imports another.

## 3. Tests

86 new tests in 4 files, all passing. Full suite: 478 pass, 78 skip, 0 fail (last run). One earlier full run had 1 fail in test/auth/http.test.js
("replay guard: pruning visits O(1) entries…"), a file platform is editing now; it passed alone (22/22) and on the
rerun. Not mine; it looks like the known load-sensitive timing test.
- Transport contract: 13 tests (send/answer, order, handler replace, reopen works, **3 generation tests**: queued
  answer after reopen, message sent before reopen not carried, reopen twice; close final; reopen/close never
  report onDrop; onDrop once, recover after drop, old-generation drop never reported after reopen, none after close).
- Storage contract: 7 tests × 5 runs (memory; session and local each with a throwing getter and with throwing
  methods), plus missing global, quota with cause and old value kept, per-call resolution, the real
  `globalThis.*Storage` default.
- Clock contract: 7 tests × 2 (virtual, browser with real ≤ 60 ms waits), plus 6 virtual-clock tests.
- Auth contract: 5 tests (fake; single use is in the contract, since auth-exchange.md fixes it), plus 4 fake tests.

## 4. Mutation check

Script: `/private/tmp/claude-501/-Users-r-repos-plenary/57f809d2-c155-42fb-a970-36cc0aced811/scratchpad/mutate.sh`
(copy file to scratchpad, apply one perl substitution, run the tests, restore, `cmp` the restore). 27 distinct
mutants (28 runs: one rerun after strengthening a test). The scratchpad is session-private, so the substitutions
are listed in full under the table for a verifier to replay.

| Rule broken | Killed by |
|---|---|
| reference: no generation check on delivery | 3 generation tests |
| reference: no generation check on onDrop | old-generation drop test |
| reference: close not final | close test |
| reference: reopen carries the old connection's unsent messages | "not carried" test (survived first; test strengthened, now killed) |
| reference: send order reversed / onMessage adds instead of replacing / onDrop twice / reopen reports onDrop | order / replace / once / never-report tests |
| memory: absent → "" / unavailable get → null | absent-is-null, unavailable tests |
| session: method failure → null / getter failure → null | unavailable (methods throw / getter throws) tests, quota test |
| local: value coerced / remove writes "" | TypeError test, remove/independence tests |
| virtual: ignore due time / clear no-op / fire synchronously for ms ≤ 0 / ignore seed / now() = target inside callbacks | due order, clear, never-inside-set, seed, now()-in-callback tests |
| browser: ignore ms / constant random | not-before-ms, random-varies tests |
| fake auth: not single use / throws on bad input / extra field / wrong error value / no expiry | single-use, never-rejects, exact-shape, invalid-code, expiry tests |

<details><summary>Substitutions (file :: perl -0pi -e expression :: test path)</summary>

```
R=test/web/contracts/reference-transport.js  (tests: test/web/contracts)
$R :: s/if \(c\.gen === gen && !done\) onMsg/if (!done) onMsg/
$R :: s/if \(c\.gen === gen && !done\) onDrop/if (!done) onDrop/
$R :: s/close\(\) \{ done = true; open\(\); \}/close() { open(); }/
$R :: s/conn = \{ gen, up: \[\], open: true \};/conn = { gen, up: conn0?.up ?? [], open: true };/; s/if \(conn\) conn\.open = false;/var conn0 = conn; if (conn) conn.open = false;/
$R :: s/c\.up\.push\(m\);/c.up.unshift(m);/
$R :: s/onMessage\(fn\) \{ onMsg = fn; \}/onMessage(fn) { const o = onMsg; onMsg = m => { o(m); fn(m); }; }/
$R :: s/if \(c\.gen === gen && !done\) onDrop\(\);/if (c.gen === gen \&\& !done) { onDrop(); onDrop(); }/
$R :: s/reopen: open,/reopen() { onDrop(); open(); },/
web/adapters/storage/memory.js :: s/map\.has\(key\) \? map\.get\(key\) : null/map.get(key) ?? ""/                    (test/web/adapters/storage.test.js)
web/adapters/storage/memory.js :: s/get\(key\) \{ check\(key\);/get(key) { if (unavailable) return null; check(key);/
web/adapters/storage/session.js :: s/try \{ return op\(s\); \} catch \(e\) \{ throw fail\(e\); \}/try { return op(s); } catch (e) { return null; }/
web/adapters/storage/session.js :: s/try \{ s = backing\(\); \} catch \(e\) \{ throw fail\(e\); \}/try { s = backing(); } catch (e) { return null; }/
web/adapters/storage/local.js :: s/if \(typeof value !== "string"\) throw new TypeError\("storage: value must be a string"\);//
web/adapters/storage/local.js :: s/s\.removeItem\(key\);/s.setItem(key, "");/
web/adapters/clock/virtual.js :: s/x\.at < best\.at \|\| \(x\.at === best\.at && x\.h < best\.h\)/x.h < best.h/      (test/web/adapters/clock.test.js)
web/adapters/clock/virtual.js :: s/clear: h => \{ q = q\.filter\(x => x\.h !== h\); \},/clear: h => {},/
web/adapters/clock/virtual.js :: s/return \(\(r \^ \(r >>> 14\)\) >>> 0\) \/ 4294967296;/return ((r ^ (r >>> 14)) >>> 0) \/ 4294967295;/   (survives)
web/adapters/clock/virtual.js :: s/set: \(fn, ms\) => \{ const h = \+\+n;/set: (fn, ms) => { if (!(ms > 0)) { fn(); return 0; } const h = ++n;/
web/adapters/clock/virtual.js :: s/s = seed >>> 0;/s = 1;/
web/adapters/clock/virtual.js :: s/t = x\.at;/t = until;/
web/adapters/clock/browser.js :: s/Number\.isFinite\(ms\) && ms > 0 \? ms : 0/0/
web/adapters/clock/browser.js :: s/random: \(\) => Math\.random\(\),/random: () => 0.5,/
web/adapters/auth/fake.js :: s/codes\.delete\(code\);/;/                                                         (test/web/adapters/auth.test.js)
web/adapters/auth/fake.js :: s/if \(typeof code !== "string" \|\| code === ""\) return \{ error: "invalid-code" \};/if (typeof code !== "string" || code === "") throw new Error("bad code");/
web/adapters/auth/fake.js :: s/return \{ \.\.\.c\.session \};/return { ...c.session, ok: true };/
web/adapters/auth/fake.js :: s/if \(\!c \|\| now\(\) - c\.at > ttlMs\) return \{ error: "invalid-code" \};/if (!c) return { error: "not-found" }; if (now() - c.at > ttlMs) return { error: "invalid-code" };/
web/adapters/auth/fake.js :: s/now\(\) - c\.at > ttlMs/false/
```
</details>

One mutant survives and is accepted: virtual random dividing by 2³²−1 instead of 2³² (returns 1.0 only for one
state in 2³²; no test can catch it).

## 5. NOT verified

- **No real browser.** browserClock ran under bun's timers; session/local ran against a fake Storage and a
  `globalThis` stand-in, not Chrome's sessionStorage/localStorage, private mode or a real QuotaExceededError.
- **Transport contract dry run against p2's real `localRoom`: 13/13 pass** (scratchpad test importing
  /Users/r/repos/plenary-p2/web/sync.js read-only; the driver is in §7.2). NOT verified: that it *depends* on
  localRoom's generation check (`link.gen === gen`). The mutation run on a scratch copy of p2 was denied by the
  permission prompt, so L3 is closed only for the reference transport, not yet for localRoom. sharedNet: not run
  (needs a fake worker port; p6-hex).
- **Auth HTTP adapter does not exist** (p6-hex). The contract is shape-only; the 60 s expiry and single use are
  pinned only on the fake. `network` as the no-answer value is my choice; platform has not seen it.
- **Question for platform (via manager):** are `user`, `name`, `email` always strings, and is `domain` null for a
  user outside any Workspace (invite / share link)? The port and contract assume yes.
- No sdd ensemble review was run (optional for builders).

## 6. Risks and open points

- **Discrepancy:** the transport header says `close()` is final and required, but `bindEditor`'s typedef in p2-land
  web/sync.js has `close?` optional. The port makes `close` required. p6-hex should make sync.js's typedef import
  the port's.
- **Shape mismatch to fix in p6-hex:** p2 `web/collab/ui.js:34` uses a clock of shape `{ now, setTimer, clearTimer }`;
  the port is `{ now, set, clear, random }`.
- **In-flight answers after an unasked drop** are deliberately not pinned (a WebSocket delivers what it received
  before `onclose`); only "none after reopen" is. If the team wants the stricter rule, add one test.
- **serve() timing assumption:** the transport driver's `serve()` must hold answers for a task, not a microtask
  (the contract awaits it); a SharedWorker fake port must post on a task to be a fair test.
- **Duplicate code** in session.js and local.js (~15 lines) is the price of "adapters never import each other".
  A shared helper would have to live in a non-adapter place (ports may not hold code beyond constants).
- `test/arch-scan.js` is not on main yet, so there is no boundary test for these files; the import rules were
  checked by grep only.

## 7. What p6-hex must do to move existing code onto these ports

1. **sync.js → web/core/sync.js:** take a `clock: Clock` in place of `timers`, `now`, `random` (the virtual clock
   already fits `timers` shape); type `transport` as `import("../ports/transport.js").Transport`; drop the
   `REAL_TIMERS` and `Date.now`/`Math.random` defaults (the roots pass `browserClock()`); remove the contract text
   from its header and point at web/ports/transport.js.
2. **localRoom → web/adapters/transport/local.js:** its own `time` queue becomes a `virtualClock` passed in by the
   root/test. Run `transportContract("local", …)` with the driver that already passes (dry run, 13/13):
   `localRoom({ auto: false })`, one `join()`; `request(i)` = `{ t: "probe", id: "probe:" + i }` (before a hello the
   Room answers any non-hello message once with `{ t: "error", id, code: "auth" }`, so no hello is needed);
   `answerOf` = that error's id; `serve()` = `net.step(() => 0)` once per unserved send (rng 0 takes the up queue
   first; the driver counts sends and resets the count on reopen/close by wrapping the handle); `flush()` =
   `settle()`; `drop()` = `fail()` (reports onDrop synchronously: allowed, the test counts only drops after reopen).
   Then mutate `link.gen === gen` and confirm a generation test fails (closes p6-landv L3).
3. **net.js `sharedNet` → web/adapters/transport/shared-worker.js:** replace `Date.now()`/`Math.random()` in the link
   id with an injected clock (or `crypto.randomUUID`); run the contract with a fake `{ port }` whose far side
   answers on a task; `drop()` = `fail()`. `localNet` imports localRoom (an adapter importing an adapter): move that
   choice into the composition root.
4. **app.js `store` (localStorage) and token.js `storage` (sessionStorage):** pass `localStore()` /
   `sessionStore()` from the root. token.js today uses `getItem/setItem/removeItem` and swallows errors: switch it
   to `get/set/remove` and catch `err.code === STORAGE_UNAVAILABLE` (keep the token in memory then). Library code in
   ui/panel.js likewise; show "library full" on a quota failure.
5. **Sign-in:** token.js reads `#code` (not `#token`) per docs/m2/contracts/auth-exchange.md, clears the fragment,
   then `auth.exchange(code)`; build `web/adapters/auth/http.js` (POST /auth/exchange, same-origin, JSON body;
   map 400/403/503 to the errors, a thrown fetch to `network`, a non-shape 200 to `unavailable`) and run
   `authContract("http", …, { skip: !env })` against a live server. One retry on `unavailable`/`network`.
6. **collab:** `web/collab/ui.js` clock (`setTimer`/`clearTimer`) → the Clock port; `records-model.js
   newRecordId(rand = Math.random)` and `collab/dev.js`'s `Date.now`/`setInterval` → the clock from the root.
7. **room-host.js / room-worker.js** `created: Date.now()` → a clock passed in by the worker's root.
8. **Boundary test** test/web/architecture.test.js on `test/arch-scan.js` once engine lands it: ports import
   nothing from web/ (constants only), adapters import only ports and core, only roots import adapters.
9. Carried LOWs from p6-landv (L2, L4, L5) are untouched here; L3 is now covered by the transport contract's
   generation tests once localRoom runs it.

## Fix round 1 (from docs/m2/reports/p6-portsv.md, FAIL: 4 HIGH, 2 MEDIUM, 7 LOW)

Same files only (all still new and untracked). `bun test`: **507 pass, 78 skip, 0 fail** (full suite; the count
includes other sessions' tests). Job tests: 113 pass, 0 fail (was 86).

| Finding | Fix | Check |
|---|---|---|
| **H1** late far-side traffic on an old connection | Transport driver gets a REQUIRED `hold()` → `emit(i)` bound to the far side's current connection. 5 new contract tests: late traffic after reopen, after two reopens, after close, after drop + reopen, plus "hold is provided". Reference transport implements it. | localRoom (scratch copy of p2, see below): unmutated 18/18 pass; **M1 (`link.gen === gen` removed): 3 fail; M9 (also no `room.disconnect`): 3 fail**; M2, M4, M6, M7 also killed. M8 alone (room never told) survives: the gen check still hides it from the client, so it is a far-side leak, not a transport-contract rule. M5 equivalent (as the verifier found). |
| **H2** auth field types | Port typedef: `user` non-empty string; `name`, `email`, `domain` string or null (cites auth-exchange.md "Field types"; "ASSUMED" removed). `expectAuthResult` requires non-empty `token`/`user`, nullable the rest. `mint(fields)` in the contract; null-fields and pass-through tests. Fake passes nulls through. | Mutants: null → "" (AU6), empty user (AU7): killed by the contract. |
| **H3** collapsed or rejected errors | `makeAuth()` returns optional `force(kind)` (`bad-origin`, `unavailable`, `network`, `malformed` → `unavailable`, `null`). Contract: each kind resolves (never throws) to its own value; all four errors distinct. Skipped when `force` is absent (a live server). Fake: `setFail`, plus `malformed`. | AU1, AU3, AU4 and a new AU5 (malformed not mapped) now killed **by the contract**. |
| **H4** key collisions | Contract test with 20 distinct keys: case only, shared `plenary.` prefix (p2's real keys), prefix/suffix, leading/trailing space, NFC vs NFD, 1000 vs 1001 chars. Each round-trips; removing half leaves the other half. | Case-fold (SL1), truncate to 8 (SL2), NFC-normalise, trim, truncate to 1000, memory case-fold: all killed. My first attempt at SL1/SL2 reassigned `key` inside `run()`, which the closures never read (a no-op mutant); re-aimed at the `getItem`/`setItem`/`removeItem` calls. |
| **M1** exact boundary | Contract: `set(fn, 20); advance(20)` fires. | CK6 (`<=` → `<`) killed. |
| **M2** monotonic time | Added `mono()` to the Clock port: browser `performance.now`, falling back to a never-backwards clamp over `Date.now` where `performance` is missing (Herdr's QuickJS); virtual = its `t`. `now()` stays wall time for stamps other machines read (sentAt, created). Contract: mono never goes backwards and moves with time. Frames (`raf`) stay out of the port: DOM adapters own them. | Virtual mono frozen, browser mono decreasing: killed; fallback has its own adapter test (wall clock stepped back, mono holds). |
| **L1** logging | Storage and auth contracts replace `console.*` for every test and fail if anything was logged. | SL6 (`console.log(key, value)`) killed (14 tests); auth logging the code killed. |
| **L2** instance independence | Contract: two fresh instances share nothing (opt out with `{ shared: true }` for a real browser store, which is shared by design). | SL8 (map on `globalThis`) killed. |
| **L3** retry jitter | Auth port: ONE retry after a jittered wait from `clock.random` (e.g. 0.5–2 s), never a loop. `network` is noted as agreed with platform (client-only). | Wording only. |
| **L7** factory and blobs | No port added here (not in this job's file list); listed for p6-hex below. | — |

Mutants were rebuilt from the verifier's descriptions (its `mut.sh` keeps no expression list) and run with
`/private/tmp/claude-501/-Users-r-repos-plenary/57f809d2-c155-42fb-a970-36cc0aced811/scratchpad/mutate.sh <file> <perl-expr> test/web`;
the localRoom ones with `…/scratchpad/mut-p2.sh <label> <perl-expr>...` on a copy of p2 at `…/scratchpad/p2/`.
The key expressions, for replay:

```
localRoom (web/sync.js copy):
  M1  s/if \(link\.gen === gen\) \{ link\.down\.push/if (true) { link.down.push/
  M8  s/if \(link\.conn\) \{ leave\(link\); room\.disconnect\(link\.conn\); \}/if (link.conn) { leave(link); }/
  M9  M1 + M8
storage: SL1 session  s/s\.getItem\(key\)/s.getItem(key.toLowerCase())/ (same for setItem/removeItem)
         SL2 local    ... key.slice(0, 8) ...      SL6 session  console.log(key, value) before set
         SL8 memory   s/const map = new Map\(\);/const map = (globalThis.__sharedMap ??= new Map());/
clock:   CK6 virtual  s/x\.at <= until/x.at < until/
auth:    AU1 every forced error → "unavailable"; AU3 `if (fail) throw`; AU4 network → unavailable
```

**The localRoom driver** (scratch test, `…/scratchpad/p2/local.contract.test.js`; p6-hex copies it into
`test/web/adapters/transport-local.test.js`). `hold()` needs the ROOM-SIDE handle of the current connection, the
same thing a gateway that has not seen the close yet holds. localRoom doesn't expose it, so the scratch test wraps
`Room.prototype.connect` (the same module localRoom imports) to capture the latest connection, and `emit(i)` calls
its `send` directly:

```js
let lastConn = null;
const connect = Room.prototype.connect;
Room.prototype.connect = function (...a) { return (lastConn = connect.apply(this, a)); };
// driver: localRoom({ auto: false, users: {} }), one join(); request(i) = { t: "probe", id: "probe:" + i } (the Room
// answers any non-hello message before a hello with { t: "error", id }); answerOf = that id; serve() = net.step(() => 0)
// once per unserved send; flush() = settle(); drop() = fail();
// hold() { const c = lastConn; return i => c.send({ t: "error", id: "probe:" + i, code: "auth", message: "late" }); }
```

p6-hex: give `web/adapters/transport/local.js` a test seam for this instead of the prototype wrap (for example
`join({ onConnect })`, or the handle exposing a test-only `far()`), and the shared-worker fake port an equivalent
(post a `msg` tagged with an old link id).

### Added to the p6-hex list (from p6-portsv)

10. **Clock `mono` split (M2):** deadlines on `clock.mono` (Replica `helloAt`/`progressAt`/`timeLeft`,
    `presenceLimiter`), stamps on `clock.now` (`sentAt`, `created`). The Replica takes one `now` today, so this is
    an engine change in packages/protocol (a `mono` option, defaulting to `now`); raise it with engine, don't edit it.
11. **collab/ui.js clock shape:** it takes `{ now, setTimer, clearTimer, raf }`; rename its calls to `set`/`clear`
    and pass the Clock port; `raf` stays a DOM-adapter concern (collab/ui.js becomes a `dom/` adapter per the p6-hex
    table). If p6-hex keeps collab/ui.js in core instead, a Frame port is needed (that would be HIGH).
12. **Null identity fields (H2):** when building `me` from the exchange, give a null `name` one fallback (the
    email's local part, else "You"): p2 `web/app.js:251` calls `me.name.slice(0, 2)`, and `records-model.js:46`,
    `collab/ui.js:124, 150, 177` would show "null". Show `email` only if present.
13. **Auth HTTP adapter:** `force(kind)` via an injected fake `fetch` (403, 503, throw, non-shape 200); one jittered
    retry on `unavailable`/`network` in the caller, never in the adapter.
14. **Net and Blobs ports (L7):** a `Net` typedef (`kind`, `join(): Transport`) and a web Blobs port (`put(file)`,
    `onFile(fn)`), so `web/ui/session.js` depends on ports, not on net.js.
15. **`close?.()` (L4):** type sync.js's transport from `web/ports/transport.js` and drop the optional chaining.

### Still NOT verified

- No real browser (as before). The localRoom run is on a scratch copy of p2 with a prototype wrap, not on a moved
  adapter. sharedNet is still not run against the contract.
- The live-server path of `authContract` (no `force`, `mint` handing over the `__Host-plen_xchg` cookie) is untested.

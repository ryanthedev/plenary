**PASS**: no HIGH. Two MEDIUM (design, for p6-hex and the manager), three LOW. Verifier p6-edge2v, 2026-11-12.

Job checked: p6-edge2 (ws backpressure and sign-in test gaps), as the uncommitted `git diff -- web test/web` on main at
6e198b0. It closes p6-edgev M1 (backpressure) and M2 (sign-in rules not pinned by tests). I worked read only: the only
file I changed in the repo is this report. Mutations, scratch tests and the sdd reviews ran in scratch copies under
`/private/tmp/claude-501/-Users-r-repos-plenary/6fe11144-13da-4a8b-ab7c-1c265fc4fcd9/scratchpad/`.

## What I did

| Check | How | Result |
|---|---|---|
| `bun test` | whole repo, on main | **677 pass, 78 skip, 0 fail** |
| Contract not weakened | read the diff of transport-contract.js, reference-transport{,.test}.js, transport-ws.test.js, signin.test.js | Nothing removed or loosened (section 1) |
| Mutations | `mutate.py` in a scratch copy: 27 mutants plus 3 generation re-checks, the target test file re-run for each, files restored and `diff -r` clean afterwards | Every mutant the brief lists is killed. Three survivors, none a bug (section 2) |
| Timing | 7 scratch tests (`scratch-v.test.js`) on a timer-free fake socket | 1 byte per sample for 10 min is never dropped; a stall drops; no global timer or time is used when a clock is given (section 3) |
| Flakiness | `bun test --rerun-each 30` on the 3 changed test files; then 30 separate processes, 8 at a time | 4650/4650 pass; 30/30 processes pass |
| CHECKER | `distributed-systems-design` skill, CHECKER mode (SKILL.md §3 and the ch.12 WebSocket/presence review criteria), on the port text against web/sync.js and PROTOCOL.md | 2 MEDIUM (section 4) |
| Builder's risks | grep of web/, test/ and server/ for `localRoom`, `sharedNet`, `transportContract(`, `wsTransport(`, `congested` | Confirmed (section 5) |
| sdd review | codex (effort high) and grok, each in its own scratch copy. agy failed `check_adapter` (quota, 429, resets in about 62 h); kimi is not logged in | codex: 1 LOW, which I confirmed with a mutant (L1); its 3 real-socket failures were its sandbox failing to bind a port, not the code (they pass here). grok: no findings. No finding was raised by two harnesses, so there is no HIGH candidate |

## 1. Tests pass; nothing weakened

- **transport-contract.js** only adds tests: the backpressure section and the optional driver hooks in the typedef.
  No existing test, assertion or `opts.skip` path changed.
- **The bufferless branch** lets the buffered tests return early (`if (!buffered()) return;`, transport-contract.js:210 and
  after). This is a declared opt-out, not a silent one:
  - a driver must declare `bufferless: true` or provide all four hooks (a test checks this);
  - a bufferless transport is asserted to keep `congested()` false;
  - the bufferless branch is exercised by a second reference run.
- **Two existing ws tests changed** (count overflow; a throwing `ws.send`). Before, they expected `drops === 1`
  synchronously. Now they expect 0 on the caller's stack, the socket closed at once, and 1 after a microtask. This
  is p6-edgev LOW-2 (no drop reported on the caller's stack). It is stricter, not weaker: each still requires exactly
  one drop, and adds two assertions.
- **reference-transport.js** `serve()` now skips a stalled connection, and `drop()` and `open()` now go through
  `retire()`, which empties `up`. A driver that empties its queues on drop can mask stale-delivery failures (p2's
  localRoom did, per p6-portsv), so I re-ran p6-edgev's generation mutants in the scratch copy. All are still killed:
  - **reference, generation check removed from answers:** 12 fail;
  - **reference, generation check removed from the drop report:** 2 fail;
  - **ws, generation check and handler detach both removed:** 8 fail.
  The contract still bites: `hold()` keeps its own handle on the old connection, so emptying `up` does not hide a
  late answer.

## 2. Mutation check (scratch copy)

| Mutation (the brief's list first) | Result | Killed by |
|---|---|---|
| No watermark (any backlog counts as congested) | KILLED (2) | contract "watermark: under it not congested…" |
| `congested()` always false (ws / reference) | KILLED (6 / 4) | contract "watermark…" |
| Pre-open queue capped by count only | KILLED | ws "the pre-open queue holds HARD_CAP_BYTES exactly" |
| Drop on bytes alone, progress ignored, so a slow link drops (ws / reference) | KILLED (3 / 3) | contract "a slow link that … keeps draining is never dropped" |
| No drop when fully stalled (ws / reference) | KILLED (5 / 4) | contract "a stalled backlog over the cap … is one drop" |
| Zero drain counts as progress (`>= 0`), so a stalled link never drops | KILLED (5) | same |
| Progress = "backlog went down" (adds ignored) | KILLED | contract "draining while the client adds more…" |
| Drop counted for an old connection: sample guard (ws.js:123) removed, and the report bypasses `fail()`'s guards | SURVIVED (redundant guard, see below) | — |
| Same, and `retire()` also keeps the timer (ws.js:86) | KILLED (2) | contract "reopen or close during the hold cancels it" |
| `retire()` keeps the timer, alone | KILLED | ws "reopen and close … clear its timer" |
| A drop found in `send()` reported even after a reopen | KILLED | ws "a drop found inside send() and a reopen in the same tick" |
| signin: `console.log` of the code / `console.debug` of the token / `console.warn` on the retry only | KILLED (24 / 14 / 6) | console trap |
| signin: `Math.random` for the jitter | KILLED | "the jitter comes from clock.random…" |
| signin: random drawn twice | KILLED | same |
| signin: percent-decoding, so `#code=%41%42` is accepted | KILLED | hostile "escaped, valid once decoded" |
| signin: MAX_FRAGMENT cap removed | KILLED | hostile "over MAX_FRAGMENT only by padding" |
| Hold on global `setTimeout` instead of the clock | KILLED (6) | contract "hard cap…" |
| Hold measured with `Date.now` | KILLED (5) | contract "hard cap…" |
| `bufferedAmount` left out of the backlog | KILLED (11) | contract "watermark…" |
| `congested()` true after close | KILLED | contract "hard cap…" |
| `watchCap` not called after the open flush (ws.js:155) | SURVIVED (equivalent, see below) | — |
| An extra global timer beside the clock timer | SURVIVED (L1) | — (my scratch test kills it) |

Why the three survivors are not HIGH:

- **Old connection: two independent guards.** `retire()` always clears the hold's timer (ws.js:86). Every path that
  retires a socket goes through it: reopen, close and fail. So the sample callback can never run for an old socket,
  and its own guard (ws.js:123) is a second line. Removing both is killed. No single edit made a drop for an old
  connection, and my scratch test confirms it: socket 1's buffer keeps growing after reopen, and 60 s later there is
  still no drop.
- **`watchCap` after the open flush: equivalent.**
  - A pre-open queue over `hardCapBytes` is already a drop with the defaults, since `maxQueuedBytes = hardCapBytes`.
  - With a larger `maxQueuedBytes`, the pre-open `send()` path has already started the timer (ws.js:185), because
    the queue counts in the backlog.
  - So the call at ws.js:155 never starts a hold the send path has not already started.
- **The extra global timer** is a test gap, not a bug (L1).

## 3. Timing

- **Hold on the injected clock:**
  - **Reading:** the hold uses only `clock.set`/`clock.clear`/`clock.mono` (ws.js:86, 118-132). `globalClock` is the
    default argument only (ws.js:69).
  - **Scratch test:** with a clock given, I wrapped `setTimeout`, `setInterval`, `clearTimeout`, `Date.now` and
    `performance.now`. I sent past the cap, advanced 11 s, reopened, sent past the cap again, reopened and closed.
    There was exactly one drop and **zero** global calls.
- **Slow drain:**
  - **1 byte drained per 1 s sample**, 10 minutes over the cap: no drop, the socket stays open, `congested()` stays
    true.
  - **1 byte every 9 s** (fewer drains than samples, but progress inside every 10 s window): no drop.
  - **1 byte every 11 s:** a drop. This only repeats the stalled case: the drop comes in the first 11 s, before any
  byte drains.
- **Quiet core:** a stalled link with no further sends still drops at 10 s (the sampler runs on its own), and leaves no
  pending timer.
- **No clock passed (the fallback):** with global timers (a 30 ms hold), the adapter still drops. So the fallback
  works, as the builder said.
- **Flakiness:** 30 reruns in one process, then 30 separate processes run 8 at a time: 0 failures. The new tests run
  on virtual clocks. The only real-time parts are `setTimeout(0)` ticks in the fake socket, and the real-socket tests
  that p6-edge already had.

## 4. Design check (CHECKER, distributed-systems-design)

CHECKER criteria applied: SKILL.md §3 (failure scenarios for every component; back-of-envelope numbers that check the
design), and ch.12 (WebSocket transport; presence treated as lossy, apart from durable messages).

- **Failure scenarios: covered.** The stalled link drops at 10 s. The slow link is never dropped, so it cannot loop
  on resends. Reopen and close cancel the hold. A drop is reported once per socket, never for an old one. A resync
  resends unacked ops after `welcome`. I read this in web/sync.js:61-66 and 157-161. Before open, only the hello goes
  out, and ops wait in `held` until live (sync.js:187). So the pre-open byte cap, which drops on bytes alone and is
  the one exception to the manager's rule, cannot hit a resend burst. I confirmed this by reading main, not by
  trusting the builder's claim.
- **Presence and ops kept apart: right in principle.** The transport cannot tell them apart, so the core decides.
  Ops are never skipped, so "an acknowledged op is never lost" holds. The port tells the core enough to do this.
  MEDIUM-1 and MEDIUM-2 are the exceptions.
- **Back-of-envelope against the < 150 ms editor target:**

  | Backlog ahead of an op | 1 Mbit/s uplink | 10 Mbit/s | Uplink needed to clear it in 150 ms |
  |---|---|---|---|
  | 256 KB (the watermark) | 2.1 s | 210 ms | 14 Mbit/s |
  | 64 KB (one `preview`, PROTOCOL.md:330) | 524 ms | 52 ms | 3.5 Mbit/s |

  **Verdict on the builder's residual ("ops still wait behind the backlog"):** it is acceptable for the transport,
  because the transport cannot reorder. It is **not** acceptable as the core's presence gate. If presence is gated
  only at 256 KB, presence alone can put up to 256 KB ahead of every op, which misses 150 ms on any uplink under
  about 14 Mbit/s. This is MEDIUM-1.

- **What p6-hex must do:** gate presence low (MEDIUM-1), treat v0 `transient` ops as presence, re-check kept presence
  on a clock tick (L2), call `congested` guarded until every transport has it (MEDIUM-2), and wire `clock` and
  `onDrop` in the root (the builder's report, section 7, lists the rest; I agree with it).
- **What engine must do (the pacer and presence limiter, PROTOCOL.md:89 and :327-330; neither is on main):**
  - **They are now the only bound on a slow link's backlog.** Since a moving link is never dropped, only the core's
    rates stop it growing.
  - **The preview rate is too loose for a slow uplink.** 20/s × 64 KB is about 1.3 MB/s (10.5 Mbit/s). That fills
    256 KB in about 0.2 s, and saturates any uplink under about 10 Mbit/s on previews alone.
  - **Suggestion:** pace previews by bytes as well as count (for example a byte budget per second, or one preview in
    flight as in MEDIUM-1). Keep the op pacer (20/s, burst 100) as specified: ops are small and never skipped.
    This is a suggestion for engine; it is not a defect in this job.

## 5. The builder's named risks

- **Other transports lack `congested()`: confirmed.** `localRoom` (web/sync.js:257) and `sharedNet` (web/ui/net.js:10)
  have no `congested`. Neither runs `transportContract` in this repo: the port says localRoom's run is "outside the
  repo" (web/ports/transport.js:5), and the only callers are reference and ws. Nothing breaks today, because sync.js
  never calls `congested()`. But p6-hex will fail on these transports the moment it calls `transport.congested()`
  unguarded (MEDIUM-2).
- **Clock fallback: confirmed, harmless today.** No composition root constructs `wsTransport` yet: the only callers are
  tests, and web/app.js still uses `sharedNet`/`localNet`. So no root can forget the clock yet. The fallback works
  (section 3).

## Findings

### HIGH

None. No mutant from the brief's list survives, no contract was weakened, no slow link is dropped, every stalled link
is dropped, and no new test was flaky in 60 runs.

### MEDIUM

- **M1. The presence gate at 256 KB is too high for the < 150 ms editor target, and the port text leaves out today's
  previews (web/ports/transport.js:26-35).**
  - **The numbers:** the port tells the core to stop presence only above `CONGESTED_BYTES` (256 KB). The table in
    section 4 shows that much backlog delays the next op by 2.1 s at 1 Mbit/s, and still by 210 ms at 10 Mbit/s.
  - **Previews today are not `presence`:** web/sync.js:176-179 sends drag previews as `op` with `transient: true`,
    the v0 form (PROTOCOL.md:17). Read literally, the port's "NEVER skip … any `op`" forbids skipping the largest
    presence-like traffic there is.
  - **Not a transport bug:** the adapter does what its brief fixed (256 KB). This is a decision for the manager and
    p6-hex.
  - **Fix (port text, plus p6-hex in sync.js):**
    - say that v0 `transient: true` ops count as presence for this rule;
    - gate presence much lower than the congested flag. Two ways: allow at most one presence frame in flight (send
      the next only when the backlog is back near 0, e.g. ≤ 16 KB), or have the port expose `backlogBytes()` so the
      core can choose its own threshold;
    - keep 256 KB as the "congested" signal for the status pill.
- **M2. `congested()` is REQUIRED by the port, but two in-repo transports lack it and no test enforces it
  (web/sync.js:257 localRoom, web/ui/net.js:10 sharedNet).**
  - **Failure case:** p6-hex adds `if (transport.congested()) skip` to sync.js. Then `web/dev.js` and `web/app.js`
    (both on localRoom/sharedNet) throw a TypeError on the first cursor.
  - **The builder named this risk.** I confirm it, and rate it MEDIUM because the hexagonal rule ("every adapter passes
    its port's contract") is not checked for these two in the repo.
  - **Fix (p2/p6-hex, before sync.js calls it):** add `congested: () => false` to localRoom and decide sharedNet's
    buffer. Run `transportContract` on localRoom inside the repo, with `bufferless: true`. Until then, sync.js should
    call `transport.congested?.() === true`.

### LOW

- **L1. No test proves that no global timer runs when a clock is given (test/web/adapters/transport-ws.test.js:275).**
  codex raised this; I confirmed it with a mutant. Adding `setTimeout(() => {}, hardCapMs)` beside the clock timer
  passes the whole ws file. The code is correct today: my scratch test, with global timers and time wrapped, sees
  zero calls. Fix: add that wrapped-globals test. It is "with a clock given…" in `/private/tmp/claude-501/-Users-r-repos-plenary/6fe11144-13da-4a8b-ab7c-1c265fc4fcd9/scratchpad/scratch-v.test.js`; its imports are relative,
  so it runs only when copied into `test/web/`.
- **L2. Kept presence needs its own flush tick (for p6-hex).** `congested()` is polled, and nothing tells the core
  when it clears. If the person stops moving while congested, the kept latest cursor or selection is never sent
  unless the core re-checks on a clock timer, for example every 100–250 ms while something is kept. The port says
  "send it once congested() is false" but not who checks.
- **L3. The reference transport counts UTF-16 characters, not bytes
  (test/web/contracts/reference-transport.js:65).** It is a test double, and the contract uses ASCII padding, so no
  test is affected. ws.js counts real UTF-8 bytes (its own test pins this).

## Not checked

- **A real browser.** Not checked: `bufferedAmount` in Chrome, Safari or Firefox, or whether it falls in coarse steps
  on a very slow link rather than smoothly. A browser that updates it rarely, or in large chunks, could look like
  "no progress" for 10 s on a link that is moving. The fake drains byte by byte. Note that grok's statement that the
  fake "matches real browsers" was not tested by grok either; I did not rely on it. I also did not check
  `bufferedAmount` after `close()`.
- **A real congested socket.** I did not use a real socket or a live gateway for the backpressure path; the p6-edge
  real-socket tests still pass in the full run.
- **The core side.** It does not exist yet (p6-hex), so nothing proves presence is actually skipped.
- **localRoom and sharedNet against the contract.** I found by grep that they lack `congested()`; I did not run the
  contract on them.
- **Harness coverage.** The ensemble had only two harnesses (codex and grok): agy is out of quota and kimi is not
  logged in.

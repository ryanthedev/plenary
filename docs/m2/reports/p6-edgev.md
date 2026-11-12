**PASS** — no HIGH. Two MEDIUM (outbound backpressure; three security rules not pinned by tests), five LOW. Verifier p6-edgev, 2026-11-11.

Job checked: p6-edge (web/adapters/auth/http.js, web/adapters/transport/ws.js, web/core/signin.js, their tests, and the
change to test/web/contracts/auth-contract.js). Read only; nothing in the repo changed except this report.

## What I did

| Check | How | Result |
|---|---|---|
| `bun test` | full suite on main | 606 pass, 78 skip, 0 fail. The job's 4 files: 112 pass, 0 skip |
| Contract runs | grep for contract callers | `authContract` runs on fake + http (fake fetch); `transportContract` runs on ws (fake WebSocket). http also runs against platform's real `/auth/exchange` route in-process; ws also against a real Bun socket |
| Mutation check | 38 mutations in a scratch git copy (script: scratchpad `mutate.js`), job tests re-run per mutation | Every mutation the brief lists is caught (table below) |
| authContract diff | `git diff test/web/contracts/auth-contract.js` | R2-M1 and R2-L2 closed; nothing weakened |
| Real gateway | `server/main.js` `start()` in-process, port 0, a temp data dir, dev token, driven by `wsTransport` over Bun's WebSocket | the gateway accepts the adapter's frames: hello → welcome; after reopen, a new hello → welcome; a second hello → `error:bad-op` and exactly 1 onDrop; a bad token → `error:auth` and exactly 1 onDrop; after close(), no further drop |
| Hexagonal | read imports and globals | Clean (section 5) |
| sdd review | codex (effort high) on the scratch copy. agy failed `check_adapter`: quota exhausted (429, resets in ~63 h). Single harness | 2 MEDIUM, no HIGH; one confirmed, one refuted to LOW (below) |

### Mutation results (brief's list first)

| Mutation | Result | Caught by |
|---|---|---|
| ws: old socket's message delivered after reopen (generation check and handler detach both removed) | KILLED | contract "generation: an answer the old connection already queued…" (8 fail) |
| ws: old socket's drop reported after reopen | KILLED | contract "reopen and close never report onDrop" (11 fail) |
| ws: token in the URL | KILLED | unit + real-socket test |
| ws: token as a subprotocol (header) | KILLED | unit + real-socket test |
| http: errors collapsed (403 → invalid-code; 503 → network) | KILLED (both) | contract "forced …" and "four failures stay distinct" |
| http: `exp` converted to ms | KILLED | contract `exp < 1e11` and pass-through test |
| signin: token written to localStorage | KILLED | tripwire on `globalThis.localStorage` (14 fail) |
| signin: retry on invalid-code / on bad-origin | KILLED (both) | "… is final: no retry, no wait" |
| signin: no jitter on the retry | KILLED | "the wait is jittered" |
| signin: fragment cleared after the exchange / one microtask late / only when a code is present | KILLED (all three) | "replaceFragment runs first, synchronously…" |
| Others killed | KILLED | ws queue carried across reopen; close() not final; codec bypassed; http code in URL; code logged; token logged; `credentials: "include"`; signin no wait; retry loop; any code accepted; two `code=` takes first; Date.now in core; exp compared wrongly; null name refused; dev name unchecked |

Survivors (none is a bug in today's code; each is a test gap or a redundant second guard):

| Survivor | Why it survives | Severity |
|---|---|---|
| ws: generation check in onmessage removed (handlers still detached) | Detaching handlers alone already stops delivery: two independent guards. Fine | none |
| ws: `c.dropped` check in fail() removed | Same: handlers are detached on the first event | none |
| signin: `replaceFragment` moved to just before the exchange | Equivalent mutant (still first and synchronous) | none |
| signin: `console.log` of the code or the token in the core | test/web/core/signin.test.js does not watch console (the auth contract does, for adapters) | LOW-1 |
| signin: `Math.random()` instead of `clock.random()` | The "two seeds, two moments" test also passes with Math.random | LOW-1 |
| signin: percent-decoding the code (`#code=%41%42` → `AB`) | No hostile case where the decoded value is valid; `a%20b` decodes to an invalid value anyway | LOW-1 |
| signin: MAX_FRAGMENT cap removed | The "huge" case is also rejected by the 256-char code rule, so the cap's own outcome is never pinned | LOW-1 |

I confirmed by hand that today's core rejects `#code=%41%42` with `bad-fragment` and no request, and grep finds no
`console`, `Math.random`, `Date.` or browser global in web/core/signin.js.

## 1. Tests and mutations

`bun test` passes. Every new adapter runs its port's contract. The mutation table above shows each rule the brief lists caught by at least one test.

## 2. authContract change

- **R2-M1 closed**, measured against p6-portsv.md:39-44 ("failure tests silently pass when the adapter gives no
  `force`; fix: a 'force is provided' test"). Both `if (!force) return;` guards are gone (auth-contract.js:114-135),
  and a new test requires `force` (auth-contract.js:108). Run in the scratch copy: http registered **without**
  `force` gives 6 failures (the "provided" test, the 4 forced tests, and "distinct"). With a **no-op** `force` it gives
  5 failures (the 4 forced tests and "distinct"). Neither passes silently. The portsv fix offered a `live` opt-out;
  the builder dropped live servers from the contract instead (header, auth-contract.js:13-14), which is stricter.
- **R2-L2 closed** (p6-portsv.md:49 asked for "a sanity bound in `expectAuthResult`, e.g. `exp < 1e11`"): `expectAuthResult` asserts `exp < 1e11` (auth-contract.js:37), and a new test pins
  `mint({ exp: 1_900_000_000 })` coming back unchanged (auth-contract.js:75-80). The ms mutation is killed.
- **Nothing weakened:** the diff only removes the two silent-skip guards, adds two tests and one assertion, and
  rewrites the header comment. `opts.skip` is still accepted, but no caller passes it.

## 3. Security

- **Code and token never logged:** the adapters are watched by the contract's console trap (mutations killed). The core has no logging (grep), but no test guards it (LOW-1).
- **Never in a URL:** http posts `{code}` only in the JSON body to `/auth/exchange`. ws opens exactly the given URL
  with one constructor argument; the real-socket test checks the upgrade URL and headers.
- **Never in localStorage:** the core reaches storage only through the port (tripwire test). Choosing session
  storage is the composition root's job (p6-hex).
- **Hostile fragments:** over 2048 characters, two `code=`, escaped, `<script>`, a dot, unicode, empty, over 256 characters and a newline: each gives `bad-fragment` with no request (signin.test.js:87-118). The fragment is
  cleared first and synchronously, whatever it held.
- **Identity is display-only:** name, email and domain may be null. A bad display field becomes null and never blocks sign-in.

## 4. ws adapter vs the real gateway

Driven live, as in the table above: the gateway accepts the adapter's hello and answers welcome, and each refusal
is exactly one onDrop. "One hello, token only in hello" comes from reading ws.js (the adapter never builds a frame or
touches the URL; only the core's `send({t:"hello",…})` carries the token) and from the builder's real-socket test,
which inspects the upgrade URL and headers. It was not observed on the real gateway's upgrade request. jsonCodec gives
text frames (codec.js:8), as the gateway requires (gateway.js:429). One
socket per generation; the gateway's "second hello" close shows up as exactly one onDrop.

## 5. Hexagonal

- `web/core/signin.js` imports only `../ports/auth.js`. It uses no browser globals, no fetch, no `Date.now` and no `Math.random`, only language built-ins such as `JSON`, `Math.floor`, `Promise` and `Number`. Time, timers and randomness come from the clock port.
- `web/adapters/auth/http.js` imports nothing. fetch is injected; it falls back to the global
  `setTimeout` and `AbortController` when they are not injected, which is fine in an adapter.
- `web/adapters/transport/ws.js` imports only `packages/protocol/codec.js`, as the brief allows. No adapter imports another.
- There is no boundary test in the repo yet (ws.js:4 refers to "the boundary test's allowlist"). Per OFFICE.md that is
  p6-hex's or p-arch's work. Until it lands, this rule is checked by reading only.

## Findings

### HIGH

None.

### MEDIUM

- **M1 — No outbound backpressure (ws.js:97-103).** Once a socket is OPEN, `send()` calls `ws.send()` with no
  `bufferedAmount` check. Before open, the queue is capped by message count (1024), not by bytes. Failure case: an
  editor on a slow uplink streams cursor or laser presence at frame rate. The browser's send buffer grows without
  grows, and every later op waits behind stale presence, which breaks the < 150 ms editor target. PROTOCOL.md does bound
  the volume: ops are paced at 20/s with a burst of 100 (PROTOCOL.md:104), cursors at 20/s (PROTOCOL.md:327), and rule 12's
  10 s silence watchdog forces a reconnect (PROTOCOL.md:200). With those, the buffer holds at most about 10 s of paced
  traffic. **But neither the pacer nor the presence limiter is on main** (grep finds them only in comments:
  web/ports/clock.js:10, web/ports/transport.js:27). Until engine's p2-land lands, nothing bounds it. Even with them,
  the latency problem (stale presence queued ahead of ops) remains. codex flagged it on its own; I confirm it by reading. The builder listed it as a risk.
  Fix (adapter or core, p6-hex/engine to decide): expose `bufferedAmount` or a `congested()` signal. Have the core
  drop presence, which may be lost, above a watermark (e.g. 256 KB) and keep ops. Optionally treat a buffer that
  stays over a hard cap as a drop.
- **M2 — The test gaps in LOW-1 together leave three of the brief's security rules unpinned in the core
  (test/web/core/signin.test.js:20-36 has no console trap; :87-98 has no decodable `%` case; :161-183 cannot tell
  clock.random from Math.random):** no
  logging, no Math.random, and percent-encoded codes. The code is right today, but a later edit could break any of them silently.
  Cheap fix (test/web/core/signin.test.js): add the console trap from auth-contract.js to beforeEach/afterEach;
  add `#code=%41%42` to the hostile list; replace the jitter test's second half with a clock whose `random`
  is a spy (assert it was called) or stub `Math.random` to throw. I rank this MEDIUM only because these are rules the brief names explicitly.

### LOW

- **LOW-1 — Test gaps:** see the survivors table above (signin.test.js). The MAX_FRAGMENT test should use a
  fragment that the cap alone rejects, e.g. 3000 characters of `&x=1` plus a valid `code=`.
- **LOW-2 — `onDrop` can run synchronously inside `send()` (ws.js:102).** When the pre-open queue passes maxQueued, `fail(c)` calls
  the core's onDrop on the caller's stack. Confirmed with a script: a core whose onDrop reopens at once gets a new socket mid-loop. Its
  later sends from the same loop would follow its new hello, which is harmless. But a core that sends a non-hello first would be refused by the gateway. The constructor-throw path already defers its drop to a microtask (ws.js:67). Make overflow defer too, for one rule.
- **LOW-3 — Exchange POST follows redirects (http.js:47-54).** codex flagged this as MEDIUM (a cross-origin 307 could forward the code). I refute it as MEDIUM: the code is useless without the HttpOnly `__Host-plen_xchg` cookie, which
  is never sent cross-origin (server/auth/http.js:53). Also, a JSON POST to another origin needs a CORS preflight, and only someone who controls our own origin's routing can issue the redirect. Still, `redirect: "error"` costs one line, so I keep it as defence in depth.
- **LOW-4 — A network timeout then retry can mislabel the outcome (signin.js:149-153, http.js:73-75).** If the first POST reached the server and only
  the answer was lost (or timed out at 10 s), the retry gets `invalid-code`, which is final. The person is told to sign in again
  although the cause was the network. That is correct and safe; p6-hex's message for `invalid-code` should not blame the person.
- **LOW-5 — The fallback session may be someone else's.** On a failed exchange, `takeSignIn` returns the
  tab's stored session (signin.js:162) with the error as `outcome`. If B signs in in a tab that holds A's session and the
  exchange fails, the tab is still A. The outcome says so, so p6-hex must show it, e.g. "sign-in failed; still signed in as A".

## Design check (CHECKER, `distributed-systems-design` skill v0.1.0)

I loaded the skill and ran its CHECKER mode on the design these files carry: the client's sign-in exchange and
the client end of the WebSocket link. I used SKILL.md §3 (correctness, scalability and reliability checks) and
references/checklists.md (Reliability: "retry mechanism with limits", "graceful degradation"; API: "Retry-After";
the WebSocket entry). Server-side boxes (load balancer, database replication, cache, CDN, sharding) belong to other jobs and are marked N/A.

**Scope (step 1).** NFRs from CLAUDE.md: 100k joins in 2 minutes, viewers < 1 s, editors < 150 ms in the home region,
and an acknowledged op is never lost. The client sends one exchange per sign-in, then holds one socket per tab.

**Estimation (Ch2).** 100k ÷ 120 s ≈ 833 exchanges/s on average. Each request is about 100 B and each response about 1 KB, so about 1 MB/s,
which is trivial. The server side is stateless HMAC plus a used-code set (server/auth/http.js:49-56), cheap per request and fine on any node.

| Check (skill) | Finding |
|---|---|
| Retry mechanism with limits (checklists Reliability) | ✅ At most one retry, only on `unavailable`/`network`, never on final errors (mutations killed). Worst case is 2× load, never a loop |
| Thundering herd (techniques: mass retry) | ⚠️ Jittered, but narrow. The retry waits 500–2000 ms (signin.js:26). A 10k-client 503 wave comes back at about 6.7k/s for 1.5 s, about 8× the average rate, while the server is struggling. The worst path is about 22 s (10 s timeout + up to 2 s + 10 s) against a 60 s code life, so a 0.5–15 s spread fits. LOW: widen it, or honour a `Retry-After` header if platform adds one (checklists API: "Retry-After") |
| Timeouts | ✅ 10 s per attempt, aborted with AbortController when present (http.js:71-75). Without one, the request is abandoned, not cancelled, which is harmless because its answer is ignored |
| Graceful degradation (checklists Reliability) | ✅ Each failure is a distinct value. A failed exchange falls back to the stored session; an unavailable store keeps the token in memory. ⚠️ LOW-5 (the fallback session may be another person's) |
| Failure scenario per component (§3 Correctness) | ✅ Exchange: 4 outcomes plus a malformed answer. Socket: refused, server close, bad frame and constructor throw each give exactly one onDrop (live and fake). Lost exchange answer: LOW-4 |
| WebSocket reconnect storm (techniques: "reconnection storm on server failure") | ⚠️ **Not on main.** The adapter rightly has no backoff: one onDrop per unasked close, none for reopen or close, so there are no double reconnects. Herd control is PROTOCOL.md rule 12: min(30 s, 0.5 s × 2^k) × [0.5, 1) jitter, capped (PROTOCOL.md:200-205). That is sound by design, but `Replica.reconnectWait` does not exist on main yet (grep: comments only), so I could not check it. It is engine's p2-land; its verifier must check the jitter and the cap |
| Backpressure | ❌ M1 above. Volume is bounded only by the pacer and the watchdog, and neither is on main |
| Single points of failure (§3 Reliability) | N/A to these files. The session token verifies on any node and the gateway re-checks it on every hello (PROTOCOL.md rule 8), so the client's identity is only for display |
| CAP / consistency | N/A. Delivery is eventually consistent by decision (CLAUDE.md); the adapter preserves per-connection order and drops old generations |
| 10× load (§3 Scalability) | ✅ for the client side: nothing in it is shared or central. Load on the exchange route is platform's to measure (not measured here) |

**Wrap-up (step 4).** The bottlenecks this client design can cause are a retry burst after a 503 wave (narrow jitter)
and editor latency on congested uplinks (no backpressure). Both are tunable and neither blocks a PASS.

## What I did NOT check

- **No real browser:** close/error event order, `binaryType`, `close(1000)` on a CONNECTING socket, a browser's
  fetch with real cookies, Origin and redirects. Bun's WebSocket and fetch stand in for them.
- **Not run against a live Google sign-in:** platform's route was run in-process with the fake IdP, through the builder's test.
- **Not tested:** the composition root's wiring (replaceState, choosing session storage, ws URL from origin), which belongs to p6-hex.
- **Not reviewed by a second harness:** agy was out of quota, so codex was the only reviewer and no finding had two agreeing harnesses.
- **Not measured:** no load test of the exchange at 833/s, so the retry-burst numbers above are arithmetic.
- **Core backoff and pacing:** `Replica.reconnectWait`, the op pacer and the presence limiter are not on main (p2-land), so they were not checked.
- **Reading:** PROTOCOL.md v1 was read only where it bears on these files (hello and the token, rules 8, 11 and 12, presence rates, error codes),
  not end to end. Engram recall returned only earlier p6 notes, consistent with these findings.

Scratch files (outside the repo): mutate.js, repo/live-gw.js, repo/reent.js in
/private/tmp/claude-501/-Users-r-repos-plenary/18a0db6e-35c5-4e45-8618-2baf69e7561c/scratchpad.

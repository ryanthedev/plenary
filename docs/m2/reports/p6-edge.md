# Report: p6-edge (web/ edge adapters and the sign-in core)

Worker p6-edge (client), manager client (t14k). Base: main at 3f6b489 (p5-code landed). Not committed.

## 1. Design (distributed-systems-design, APPLIER mode, applied before coding)

### Scope
- **Features:** (a) trade the one-time sign-in code for a session token (POST /auth/exchange, one origin);
  (b) keep the token for reloads (sessionStorage via the storage port), the dev path and sign-out;
  (c) one browser WebSocket per board connection behind the transport port, with generations.
- **Users:** NFR 100k live viewers per board, 100k joins in 2 min; ~2k annotators; a handful of editors.
- **Latency:** sign-in is off the hot path (once per tab); the transport adds nothing beyond one encode/decode per
  message and one queue while CONNECTING. Editors < 150 ms home region, viewers < 1 s worldwide (NFR).
- **Existing infra:** p5-code's stateless exchange (signed `__Host-plen_xchg` cookie + 43-char code, any node may
  answer), the gateway's `/ws`, protocol v1 `hello` (token in the first message only, rule 11: one hello per
  connection, so every resync is a new socket).

### Estimate
- **Exchange load:** 100k joins / 120 s ≈ 833 POST/s if every join were a fresh sign-in (most are reloads or
  restored sessions, so this is the ceiling). One retry at most, so the worst case is 2× ≈ 1,700 POST/s, and only
  for answers that were already `unavailable`/`network`.
- **Retry spread:** jitter 0.5–2.0 s (`clock.random`), so a 503 wave of N clients lands over 1.5 s, not one
  instant: at 833 failures/s the retries arrive at ≈ 555/s, below the first wave.
- **Code lifetime budget:** the code lives 60 s. Worst path = request timeout 10 s + wait ≤ 2 s + retry timeout
  10 s = 22 s, inside 60 s, so the retry can still succeed.
- **Transport:** one socket per tab per board; the pre-open queue holds at most 1,024 messages (hello + a few
  ops in practice); a burst beyond that is treated as a dead link (onDrop), never unbounded memory.

### High-level shape (hexagonal)
```
 web entry (p6-hex, composition root)
   ├─ takeSignIn (web/core/signin.js, core: ports only)
   │     ├─ Auth port ── http adapter (web/adapters/auth/http.js) ── fetch POST /auth/exchange (same origin)
   │     ├─ Storage port ── sessionStore (root picks it; never localStore)
   │     └─ Clock port ── jittered wait, expiry check
   └─ sync.js (core) ── Transport port ── ws adapter (web/adapters/transport/ws.js) ── WebSocket /ws
                                               └─ protocol codec (the one protocol import)
```
Use cases walked: fresh sign-in (fragment → exchange → store), reload (stored token, expiry checked), 503 wave
(one jittered retry), share-link outcome (`&link=`), dev `?as=`, sign-out; WebSocket open → hello → resync
(reopen: old generation silenced) → drop (onDrop once) → close (final).

### Deep dive 1: retry and thundering herd (Ch4 rate limiting, Ch1 thundering herd)
- **Choice:** retry lives in the core (signin.js), never in the adapter, so every auth adapter behaves the same
  (as the transport port already does for reconnects). One retry only, jittered, only on `unavailable`/`network`;
  `invalid-code` and `bad-origin` are final (retrying a spent code gives the same answer; a bad origin is a
  deployment error).
- **Trade-off:** one retry lets a short 503 blip pass without user action; a loop would turn an outage into a
  self-made DoS at 100k clients. After the retry the person sees the failure and signs in again.
- **Timeout:** fetch can hang with no answer; the adapter aborts after 10 s (injected timers) and reports
  `network`, so the worst path stays inside the code's 60 s life.

### Deep dive 2: connection generations (Ch12 chat: WebSocket, stateful connections)
- **Choice:** each socket is a generation; every event handler checks "is this still the current socket" and old
  sockets are detached and closed on reopen. A gateway that has not seen the close yet keeps flushing (normal for
  a WebSocket), so the check is what keeps a stale `welcome`/`entries` out of the Replica.
- **Failure modes:** connect refused / DNS / TLS → `error` + `close` → onDrop once; a frame the codec rejects
  (binary for the JSON codec, invalid JSON) → that socket is treated as broken: closed, onDrop once, never a
  throw from the event handler (the core then backs off and reopens, rule 12); constructor throws (bad URL) →
  onDrop on a later microtask. Retry/backoff stays in the core (Replica.reconnectWait).
- **Security:** the adapter has no token parameter at all: the URL is used as configured and no subprotocol is
  passed (Sec-WebSocket-Protocol is a header). The token reaches the server only inside `hello`, which the core
  sends with `send()`.

### Wrap-up
- **Bottlenecks:** (1) the exchange under a 503 wave: bounded by one jittered retry; (2) the gateway's socket
  accept rate at 100k joins: not this job (gateway/LB), the core's reconnect jitter spreads it; (3) per-socket
  send buffering (`bufferedAmount`) is not watched by this adapter: a slow viewer's outbound queue is small
  (viewers send little), but an editor on a bad link could buffer. Recorded under risks.
- **Monitoring:** no logs from either adapter (the token and code are secrets); outcomes are values the UI can
  count (signin `outcome`, transport `onDrop`).
- **10×:** at 1M joins the exchange is still stateless per node (p5-code), so it scales with nodes; the client
  side does not change.

## 2. Files

| File | What |
|---|---|
| `web/adapters/auth/http.js` (new) | `httpAuth({ fetch, base = "", timeoutMs = 10_000, timers })`: POST `/auth/exchange` (relative by default: one origin, per p5-code), `credentials: "same-origin"`, JSON `{code}`, `cache: "no-store"`. Maps on the **status**, with a JSON body required for 200/400/403: JSON 400 → invalid-code, JSON 403 → bad-origin, 200 + session shape → session (exp untouched), 200 + JSON of another shape → unavailable, a non-JSON 200/400/403 (a proxy or WAF page) → network, every other status (503, 502, 504, 404, 500, the route's 503 `sign-in-unavailable`) → unavailable; fetch throws / no answer in 10 s (aborted) → network. Imports nothing; never logs. |
| `web/adapters/transport/ws.js` (new) | `wsTransport({ url, WebSocket, codec = jsonCodec, maxQueued = 1024 })`. One socket per generation; handlers check "still current" and old sockets are detached and closed; queue while CONNECTING (dropped with the socket on reopen; over maxQueued → dead link); onDrop once for the current socket's unasked close/error/undecodable frame/throwing send/throwing constructor; close() final. No token parameter, URL used verbatim, no subprotocol. Header comment states its one protocol import (`packages/protocol/codec.js`) for the boundary test's allowlist. |
| `web/core/signin.js` (new, core) | `takeSignIn({ fragment, replaceFragment, storage, auth, clock })` → `{ token, identity, exp, outcome, link }`; plus `readStored`, `devSignIn`, `signOut`, `SESSION_KEY = "plenary.session"`. Imports only `web/ports/auth.js` (AUTH_ERRORS); no globals (fragment hand-parsed, no URLSearchParams). |
| `test/web/contracts/auth-contract.js` (changed) | R2-M1: `force` is REQUIRED (a test asserts it; the two `if (!force) return` guards are gone; header updated, the live-server `skip` example removed). R2-L2: `expectAuthResult` asserts `exp < 1e11`, and a new test mints an explicit `exp: 1_900_000_000` and asserts it comes back identical (catches ×1000 and ÷1000). |
| `test/web/adapters/auth-http.test.js` (new) | authContract over a fake same-origin server (404 to any request of the wrong shape, so the happy path fails if the adapter sends anything else); request shape; status mapping; non-JSON; timeout + abort on the virtual clock; **4 tests against platform's real route in-process** (server/auth/http.js via httpRoutes + fakeIdp, set up as test/auth/exchange.test.js): real code → token that `sessions.verify` accepts, single use, consumer account domain null, foreign Origin → bad-origin without spending the code, missing cookie → invalid-code. |
| `test/web/adapters/transport-ws.test.js` (new) | transportContract over a hostile fake WebSocket (it dispatches late messages/closes to whatever handlers a socket still has, so only the adapter's generation rule stops them; serve/hold wait for open so the "already queued" test is not vacuous); adapter rules (URL verbatim, no subprotocols, token only in the hello frame, queue-before-open, maxQueued, codec rejects text and binary, refused connect, throwing constructor, throwing send, close detaches); **real socket** (Bun.serve on port 0, `describe.skipIf` without Bun): hello first, token absent from the upgrade URL and every header, no Sec-WebSocket-Protocol, reopen = new connection + old one closed, server close = one onDrop, close final, nothing listening = one drop. |
| `test/web/core/signin.test.js` (new) | 37 tests: exchange once + stored; null name/email; replaceFragment first and synchronous, for every fragment, survives a throw; link outcome; real-shaped (43-char) and fake-shaped codes both accepted; 10 hostile fragments rejected with zero requests; one jittered retry on unavailable/network (never before 500 ms; pending timer on the injected clock), never a second retry, none on invalid-code/bad-origin; jitter differs by seed; unknown adapter errors → unavailable (retried); a session-shaped answer with a bad token/user/exp → unavailable and FINAL (the code is spent); bad display fields (empty, control characters, too long) become null and never block sign-in, on exchange and on read-back; failed exchange falls back to the stored session; restore, expiry by exp seconds, malformed stored values dropped, unavailable store survived (and a failed read removes nothing), signOut; dev path. **Tripwire `localStorage`/`sessionStorage` globals** are installed for every test and must stay untouched. |

## 3. Tests

- `bun test` (whole repo, real tree, after all changes): **606 pass, 78 skip, 0 fail** (baseline before this job: 510 pass,
  78 skip, 0 fail; the skips are other tracks' live tests).
- Mine alone: auth-http 28, transport-ws 29, signin 37, auth (fake, with the stricter contract) 18: all pass.

## 4. Mutation check

Each row: one rule broken, the named test file run, then restored.

**Incident:** my first mutation run edited the files in the SHARED tree (one at a time, restoring each). That is
what made the manager see 8 failures in transport-ws.test.js in other tracks' `bun test` runs. I stopped it,
restored all four files from a scratchpad backup (diffed: identical), and reran every mutation in a copy of the repo
under the scratchpad. The table is from the copy. The copy's `.env` (rsync took it) was deleted afterwards.

| Mutation | Result: first failing test |
|---|---|
| ws: old socket's messages delivered (generation check AND handler detach removed) | caught (8): "generation: an answer the old connection already queued is never delivered after reopen" |
| ws: token-capable URL (`url + "?t=1"`) | caught (2): "the socket gets exactly the configured URL and no subprotocols…" (+ real-socket upgrade URL test) |
| ws: a subprotocol passed (header) | caught (2): same test |
| ws: reopen reported as onDrop | caught (3): "reopen and close never report onDrop" |
| ws: drop reported twice (dropped flag AND detach removed) | caught (6): "an unasked drop of the current connection is reported once" |
| ws: queue carried onto the new socket | caught (1): "a message sent before reopen is not carried onto the new connection" |
| http: 403 collapsed into unavailable | caught (4): "forced bad-origin: resolves … to exactly { error: "bad-origin" }" |
| http: exp turned into ms | caught (6): "a valid code resolves to { token, user, … }" (exp < 1e11) and the explicit-exp test |
| http: code in the URL | caught (10) |
| http: logs while exchanging | caught (11): the contract's console watch |
| signin: localStorage used | caught (13): the tripwire globals |
| signin: retry on invalid-code | caught (4) |
| signin: retries in a loop | caught (2): "never more than one retry" |
| signin: no jitter (fixed wait) | caught (1): "the wait is jittered" |
| signin: fragment replaced after the exchange | caught (1): "replaceFragment runs first…" |
| signin: two `code=` → take the first | caught (3): "two code=" |
| signin: expired stored token kept | caught (2): "expired by exp (seconds) → dropped" |
| signin: a failed storage read treated as signed out (removes) | caught (1) |
| contract: `force` optional again, adapter without force | caught (2): "force() is provided (required…)" |
| http: a non-JSON 400 treated as final invalid-code | caught (1): "a 400 or 403 that is not JSON … is network" |
| signin: a display field (name) gates sign-in again | caught (2): "display fields never gate sign-in…", "on read-back too…" |
| signin: a malformed session-shaped answer retried | caught (1): "…unavailable and FINAL (the server spent the code)" |

A first run of the "drop twice" mutation broke only the dropped flag and was not caught, because the handler detach
also enforces the rule (two guards on purpose); breaking the whole rule is caught. A first "force optional" probe
was badly built (it forced failures on every call) and was redone with a normal adapter.

## 5. Decisions and differences from the brief (for the verifier)

- **takeSignIn returns more than `{ token, identity, outcome }`:** also `exp` (so the UI can prompt before expiry) and
  `link` (the share-link outcome; token.js returned it too). outcome ∈ signed-in · restored · none · bad-fragment ·
  invalid-code · bad-origin · unavailable · network. The dev path is a separate export (`devSignIn({ query, allowed })`),
  as are `readStored` and `signOut`, mirroring token.js's split; the root picks dev vs takeSignIn.
- **A failed exchange falls back to the stored session** (still signed in as before) with the error as `outcome`.
- **A fresh session is not checked against the browser's clock** (a clock running ahead must not refuse a token the
  server just issued); the stored copy is checked on read-back, so a reload with a wrong clock drops it.
- **Non-JSON body → network** for 200, 400 and 403 (so a proxy's HTML 400/403 never ends sign-in as a final error);
  **JSON of the wrong shape on a 200 → unavailable** (brief vs port wording; both retry the same way). Every other
  status → unavailable, body ignored (an LB's HTML 502/503 page is `unavailable`, not `network`).
- **Display fields never gate sign-in:** name/email/domain that are empty, too long or hold control characters
  become null. Only token/user/exp are hard checks; a session-shaped answer failing them is `unavailable` but not
  retried, since the server has already spent the code.
- **Codes accepted by the fragment check:** 1–256 base64url characters (the server mints 43; the fake mints `c-1-0`).
- **Exchange timeout 10 s** in the adapter (not in the brief): a hung fetch would otherwise block sign-in forever;
  10 + ≤2 + 10 s fits the code's 60 s.
- **ws pre-open queue cap** 1,024 messages; past it the link counts as dead (onDrop) rather than growing.

## 6. NOT verified

- **No browser.** The ws adapter ran against a fake WebSocket and Bun's WebSocket client, not Chrome/Safari/Firefox;
  browser close/error ordering and `binaryType` behaviour are assumed from the spec.
- **No browser fetch.** Same-origin cookie sending and the Origin header were simulated by the test's `browserFetch`
  wrapper; the real route was called in-process, not over HTTP from a page.
- **Not against the real gateway** (`server/gateway.js` `/ws`): the real-socket test used a tiny echo server, so hello
  → welcome over the adapter with sync.js was not run (that is p6-hex's wiring).
- `history.replaceState` as `replaceFragment` is p6-hex's; only the call order was tested.
- No sdd ensemble review of this diff (optional for builders; left to the verifier).
- Tab name `plenary-p6-edge`: not set by me in this session; manager, rename if needed.

## 7. Risks

- **No backpressure:** the adapter does not watch `bufferedAmount`; an editor on a slow link can buffer in the
  browser. The pacer in the Replica bounds the send rate; a watermark could be added later.
- **Fragment hand-parsing** accepts only raw (unescaped) values: if the server ever percent-encodes the code or the
  link, sign-in breaks with `bad-fragment` (today it mints base64url, which needs no escaping).
- **AbortController** is used when present (browsers, Bun); in a runtime without it the timeout still resolves
  `network`, but the request is not cancelled.
- The ws adapter's onMessage handler is the core's: if it throws, that propagates out of the socket's event
  (intended: a core bug should be loud).

## 8. What p6-hex must wire

- **Sign-in (web entry, composition root):**
  `takeSignIn({ fragment: location.hash, replaceFragment: () => history.replaceState(history.state, "", location.pathname + location.search), storage: sessionStore(), auth: httpAuth({ fetch: globalThis.fetch.bind(globalThis) }), clock: browserClock() })`,
  and `devSignIn({ query: location.search, allowed: Object.keys(devUsers).map(k => k.slice(4)) })` first if the dev
  path is on. **On the dev path, still call `replaceFragment()`**: devSignIn does not touch the fragment, so a
  `#code=` would otherwise stay in the address bar. Then delete web/ui/token.js's use (takeToken/chooseSignIn/tokenIdentity; identity now comes from the
  exchange, not a token decode). `signOut(storage)` on sign-out or a final `auth` error.
- **Transport:** `wsTransport({ url: (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws", WebSocket: globalThis.WebSocket })`
  per board stream, with sync.js's onDrop → `replica.connectionFailed()`.
- **Boundary test (test/architecture.test.js, engine owns it; client adds web/ rules):** allowlist
  `web/adapters/transport/ws.js → packages/protocol/codec.js`; `web/core/signin.js` may import only `web/ports/*`;
  `web/adapters/auth/http.js` imports nothing.

## 9. Open question

None blocking. Manager: confirm the extra `exp`/`link` fields on takeSignIn's result and the "fall back to the
stored session on a failed exchange" choice (section 5).

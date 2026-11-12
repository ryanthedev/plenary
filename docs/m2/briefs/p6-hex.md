# Brief: p6-hex (web/ into hexagonal shape) — on main after the phase-2 merge (dcbdae6)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** (hexagonal) and the **systems design skill**. Read
docs/m2/OFFICE.md ("Architecture"), CLAUDE.md, PROTOCOL.md first.

- **Your tab:** `worker p6-hex (client): web/ ports and adapters`. Manager: `manager client` (t14k).
- **Where:** main (/Users/r/repos/plenary), after engine merges p2-land (phase 2 + v1.1 + p6-land + p7-collab). Your manager commits.
- **You own:** web/** and test/web/** in the worktree, plus your report docs/m2/reports/p6-hex.md. The web/ rules
  in the architecture test: see "Boundary test" (coordinated with engine, which owns test/architecture.test.js).
- **Design first (required):** apply the `distributed-systems-design` skill in **APPLIER** mode before moving code
  (if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/
  SKILL.md and its references/). Write the result as the first section of your report: the ports, their contracts,
  failure behaviour (drops, reconnects, backoff, storage unavailable), and what is core vs adapter.

## Goal (CEO, 2026-11-11: "hexagonal application architecture")

No behaviour change. Same tests green, more tests added. Move web/ to ports and adapters:

| Layer | What | Rule |
|---|---|---|
| **core** `web/core/` | sync (Editor ↔ Replica binding), session and roles (UI state, role gating), collab models (presence, records) | imports only packages/*, web/ports/, other web/core files. No DOM, Worker, WebSocket, localStorage/sessionStorage, location/history, `Date.now`/`setTimeout`/`Math.random` direct |
| **ports** `web/ports/` | `transport.js` (the contract now at the top of sync.js: send, onMessage, reopen required, close final, onDrop), `storage.js` (get/set/remove, may throw or be unavailable), `clock.js` (now, set/clear timer, random) | JSDoc + an exported contract test function per port |
| **adapters** `web/adapters/` | `transport/shared-worker.js` (+ its worker host), `transport/local.js` (localRoom, moved out of sync.js), later `transport/ws.js` (phase-3 server); `storage/session.js`, `storage/local.js`, `storage/memory.js`; `clock/browser.js`, `clock/virtual.js`; `dom/` (app chrome, panel, export, canvas paint, collab renderers) | an adapter imports core and ports only, never another adapter |
| **composition roots** | `web/main.js` (index.html's entry; today's app.js wiring), `web/dev.js`, `web/collab/dev` page | the only files that import adapters and wire them |

- Sign-in token (web/ui/token.js) reads location/history/storage: those become the storage port plus a small
  `location` port or a parameter from the root.
- Keep the protocol seam: only web/core/sync.js imports packages/protocol (the local transport adapter may import
  the reference Room for the dev/in-browser room; say so in the rules).
- **Contract tests:** test/web/contracts/: every transport adapter (shared-worker via a fake port, local) passes the
  transport contract (generation per connection, no old-connection delivery after reopen, onDrop only for the
  current connection, close final); every storage adapter passes the storage contract; both clocks pass the clock
  contract.
- **Contract test shape (agreed with engine):** mirror test/auth/registry-contract.js: a module
  `test/web/contracts/transport-contract.js` exporting `transportContract(name, makeAdapter)` that registers
  describe/test blocks against a fresh adapter per test (same for `storageContract`, `clockContract`); each
  adapter's own test file calls it, with adapter-specific tests beside it; a real-service adapter (the future ws.js)
  skips via `describe.skipIf` when its env is unset.
- **Boundary test (agreed with engine):** your own file test/web/architecture.test.js (never engine's
  test/architecture.test.js). It reuses engine's `test/arch-scan.js` (`importsOf(file)`, `checkBoundaries({ files,
  isCore, isAdapter, adapterGroup, compositionRoots, allowed, allowlist })` → violations; API at its top). Rules:
  core imports no adapter and no browser global; adapters don't import each other; only roots import adapters. An
  allowlist is explicit, commented and shrink-only (fails on new violations and on stale entries). If arch-scan.js
  isn't in the worktree yet when you get there, ask your manager; don't write your own scanner.

## Done when

- `bun test` passes in the worktree (all of it); no existing test/web assertion weakened; contract and boundary
  tests added and each fails when its rule is broken (mutation check).
- Headless browser: web/index.html (three tabs, SharedWorker room), `?net=local`, web/dev.html behave as before.
- Report: the design section (skill, APPLIER), the file move map (old → new), ports, contract tests, how you checked,
  NOT verified, risks. Processes: never pkill/killall, PIDs only, port 0.

## Carried from p6-landv (docs/m2/reports/p6-landv.md)

LOW L2 (the `?as=` dev path still stores a fragment token), L3 (localRoom's generation check has no test that
depends on it: add one in the transport contract), L4 (offline banner says "0 edits wait" when nothing waits), L5 (the
unverified identity from the token payload reaches non-display code: keep it display-only).

## Sign-in code exchange (platform p5-code; proxy, 2026-11-11)

The post-login fragment will carry a single-use code (≤ 60 s), not the session token. web/ exchanges it by
`POST /auth/exchange` for the session token, then keeps the token in memory and sessionStorage as today; the fragment
is still cleared at once. Wire it as an `auth` port with an HTTP adapter (and a fake for tests), so core never calls
fetch. Exact shape: docs/m2/contracts/auth-exchange.md (`#code=`, POST /auth/exchange, credentials same-origin). The
auth port and fake come from p6-ports; you add `web/adapters/auth/http.js` (fetch) and wire it in the root.

## Carried from p6-portsv round 2 (docs/m2/reports/p6-portsv.md)

- R2-M1: authContract's failure tests silently pass when an adapter offers no `force`: make `force` required for
  adapters run under the contract, or give the HTTP adapter a fake-fetch hook the contract drives (your http.js must
  not slip through).
- R2-L2: add an `exp`-in-seconds sanity check to authContract (an HTTP adapter returning ms must fail).
- R2-L1 (browser clock uses performance.now when present) and R2-L4 (items listed there for you).

## Carried from p6-edgev (docs/m2/reports/p6-edgev.md)

- **M1 backpressure:** ws.js sends with no `bufferedAmount` check. Add a `congested()` (or `bufferedAmount`) signal to
  the transport port; the core drops presence (never ops) above a watermark (about 256 KB); a buffer stuck over a hard
  cap counts as a drop. Contract test for it.
- **M2 test gaps in test/web/core/signin.test.js:** a console trap (no logging), a percent-encoded `#code=%41%42`
  hostile case, and a spy on clock.random (or Math.random stubbed to throw) for the retry jitter.
- The LOWs listed there.

## Carried from p6-edge2v (docs/m2/reports/p6-edge2v.md) — manager decisions

- **M1 presence gate (DECISION, t14k):** add `backlogBytes()` to the transport port (ws.js: bufferedAmount + pre-open
  queue bytes; bufferless transports: 0). The core sends presence only when the backlog is ≤ ~16 KB (about one frame
  in flight), and v0 `transient: true` ops count as presence for this rule (skip them, never real ops). Keep
  `congested()` (256 KB) for the status pill only. Contract test for backlogBytes.
- **M2:** localRoom (`congested: () => false`, `backlogBytes: () => 0`, `bufferless: true`) and sharedNet (decide its
  buffer: a worker-side cap or report the MessagePort backlog) implement the full port; run `transportContract` on
  localRoom in-repo. Until both do, sync.js calls them optionally (`?.()`), never assuming they exist.
- LOW L1 (a wrapped-globals test proving no global timer runs when a clock is given; the verifier's scratch test is in
  its report), L2, L3.

## State at start (manager, 2026-11-12)

- main at dcbdae6 (phase 2 merged: p6-land and p7-collab are in web/). Already on main from earlier jobs:
  web/ports/{transport,storage,clock,auth}.js, web/adapters/{storage,clock,auth,transport/ws.js}, web/core/signin.js,
  test/web/contracts/*, test/web/adapters/*, test/web/core/*. Build on them; don't redo them.
- Name `plenary-p6-hex`; tab `worker p6-hex (client) · <id>: web ports and adapters`. Report to your manager only.
- The /Users/r/repos/plenary-p2 worktree is retired: never use it.
- **test/arch-scan.js is not on main yet** (engine's p-arch). Do the move first; write test/web/architecture.test.js
  last. If arch-scan.js still isn't there, stop at that step and say so in your report; don't write your own scanner.
- web/collab moves too: models (presence, records, notes, gate, limits, flags) to web/core/collab/, renderers (ui.js,
  draw.js, dom.js, collab.css) to web/adapters/dom/collab/, fake-port.js to web/adapters/collab/fake.js, port.js to
  web/ports/collab.js. Keep p7-wire's job (the real collab adapter) out of scope.

## Fix-round item from engine's p-serve (manager DECISION, 2026-11-12)

The served page can't boot: main.js statically imports the dev rooms (transport/shared-worker/client.js, local.js),
which p-serve denies (404 → the module graph fails). **web/main.js is the production root:** ws.js transport (same-origin
`/ws`, token only in hello), HTTP auth, sign-in via `#code`; no dev rooms, no web/core/dev-users.js, no `?as=`.
**web/dev-main.js** (new, dev-only root) with its own dev page wires the in-browser rooms and DEV_USERS; index.html never
loads it. Add a test that main.js's import graph contains no dev module (use arch-scan importsOf). Tell your manager when
done so engine re-runs p-serve's crawl.

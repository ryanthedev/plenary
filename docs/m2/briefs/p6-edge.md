# Brief: p6-edge (web/ edge adapters and the sign-in core) — new files only, on main, before the p2-land merge

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** (hexagonal) and the **systems design skill**: apply
`distributed-systems-design` in **APPLIER** mode before coding (if it isn't in your skill list, read
/Users/r/repos/systems-design.skill/skills/distributed-systems-design/SKILL.md and its references/) and write the
result as the first section of your report. Read docs/m2/OFFICE.md ("Architecture"), CLAUDE.md, PROTOCOL.md v1.

- **Your tab:** `worker p6-edge (client) · <id>: edge adapters + sign-in`. Name `plenary-p6-edge`. Manager:
  `manager client` (t14k).
- **Where:** main, /Users/r/repos/plenary. Don't commit; your manager commits.
- **You own only NEW files:** `web/adapters/auth/http.js`, `web/adapters/transport/ws.js`, `web/core/signin.js`,
  `test/web/adapters/auth-http.test.js`, `test/web/adapters/transport-ws.test.js`, `test/web/core/signin.test.js`,
  your report docs/m2/reports/p6-edge.md. **Plus** `test/web/contracts/auth-contract.js` (committed in p6-ports;
  yours for R2-M1/R2-L2 below; no other contract file).
- **Never touch:** web/sync.js, web/app.js, web/index.html, web/ui/**, web/collab/**, web/paint.js, web/dev.*,
  other existing test/web files (engine's p2-land changes them and merges soon), packages/**, server/**.

## Build

1. **`web/adapters/auth/http.js`**: implements web/ports/auth.js over `fetch` exactly as
   docs/m2/contracts/auth-exchange.md says (POST /auth/exchange, same origin, `credentials: "same-origin"`, JSON
   body `{code}`; 200/400/403/503 mapped to the port; no answer, a network error or a non-JSON body →
   `{error: "network"}`; `exp` stays seconds). `fetch` and the base URL are injected (the composition root passes
   `globalThis.fetch`); it never logs the code or the token. Its test runs `authContract` against it with a fake fetch
   driven by the contract.
2. **authContract fixes (p6-portsv round 2):** R2-M1, the failure tests must not pass silently when an adapter has
   no way to be forced into an error: make the hook required for every adapter under the contract (fake and http);
   R2-L2, a sanity check that `exp` is in seconds (an adapter returning ms fails).
3. **`web/core/signin.js`** (core: ports only, no globals): `takeSignIn({ fragment, replaceFragment, storage, auth,
   clock })` reads `#code=` (and `&link=invalid|unavailable`), calls `replaceFragment()` at once whatever the
   fragment held, exchanges the code once via the auth port (one retry after a **jittered** wait from the clock on
   `unavailable` or `network`, never on `invalid-code`/`bad-origin`), keeps the token in the storage port
   (session storage at the root, never local), and returns `{ token, identity, outcome }`. Also: read back a stored
   token (expired by `exp` → dropped), the dev path (`?as=` → `dev-<as>`), and sign-out (clear it). The identity is
   display-only: `name`/`email` may be null. Hostile fragments (huge, two `code=`, odd characters) are rejected
   before any request. It replaces web/ui/token.js's job after the merge (p6-hex wires it).
4. **`web/adapters/transport/ws.js`**: implements web/ports/transport.js over a browser `WebSocket` (constructor
   injected) and the protocol codec (`packages/protocol/codec.js`, the one protocol import an adapter may make; say
   so in a header comment for the boundary test's allowlist): one socket per connection, a generation per socket,
   `reopen()` closes the old socket and opens a new one, nothing from an old socket is delivered after reopen,
   `onDrop` only for the current socket's unasked close/error, `close()` final. The token goes in `hello`, never a
   header or the URL. Its test runs `transportContract` against it over a fake WebSocket that the contract drives,
   plus one real-socket test against a tiny Bun WebSocket echo/room server started in the test on port 0 (skip it
   with `describe.skipIf` if Bun's server isn't available).

## Done when

- `bun test` passes (all of it). Every contract test runs against the new adapters and passes; mutation check: break
  each adapter's rule (old-socket delivery, token in URL, error collapsed, ms exp, local storage used) and see a test
  fail.
- Report: design section (APPLIER), files, tests, mutation check, NOT verified, risks, what p6-hex must wire.
- Processes: never pkill/killall; PIDs only; port 0. sdd helpers allowed; you own every line.

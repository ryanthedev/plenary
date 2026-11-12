# Brief: p5-http (HTTP handlers for sign-in and admin, ready to mount)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p5-http.md.
Never pkill/killall; servers on port 0, started from a command that records the PID; kill only that PID.

## Goal (PLAN.md phase 5)

"Google sign-in, tenants = Workspace domain, invites and share links (role per link), admin API." The modules exist
(server/auth, server/admin; committed 91fb274, 4e16752). This job adds the HTTP layer as standalone handlers that take
a `Request` and return a `Response`, so engine's server can mount them after phase 3 with one line. Tested end to end
against the fake IdP (test/auth/fake-idp.js). No real Google credentials anywhere.

## Files you own

`server/auth/`, `server/admin/`, `test/auth/`. Not server/main.js or anything else in server/ (engine's).

## Mount point (proposed to engine, t14j; follow their answer if the manager relays one)

`server/auth/http.js` exports `httpRoutes(deps) → async (req: Request) => Response | null`: `null` means "not my
route", so main.js can do `const r = await platformRoutes(req); if (r) return r;` before its own routes. `deps` =
`{ registry, sessions, oidc, tenancy, now, config }`, built by the caller. Keep that shape unless the manager
relays a change.

## Routes

| Route | Does |
|---|---|
| `GET /auth/login` | builds the PKCE + state + nonce request (oidc `begin()`), stores `{state, nonce, verifier}` in a signed, short-lived (≤10 min), `HttpOnly`, `Secure`, `SameSite=Lax` cookie, 302 to Google |
| `GET /auth/callback` | checks the cookie and `state`, `finish()`es the code exchange, issues a session token (sessions.issue), clears the login cookie, and hands the token to the web client: 302 to a configured post-login URL with the token in the URL **fragment** (`#token=…`), never the query (fragments don't reach servers or logs). Refuses an open redirect: the post-login URL is config only, never from the request |
| `GET /auth/logout` | clears cookies, 302 to a configured URL (stateless sessions: say in the report that a token stays valid until `exp`) |
| `POST /boards` | `createBoard` (admin) |
| invites | create, list, revoke on a board |
| share links | create, list, revoke on a board; `GET /links/:id` redeems a link for the signed-in user (`tenancy.redeemLink`) and redirects to the board |
| grants | set a user's role on a board |

- **Auth on API routes:** `Authorization: Bearer <session token>` (the same token that goes in `hello`). No cookie
  auth on mutating routes, so no CSRF surface. `GET /links/:id` needs a signed-in user: if none, redirect to
  `/auth/login` with the link remembered in the login cookie (not a URL parameter).
- **Errors:** JSON `{error: code}` with the right status; an unknown board and a board the caller can't manage give
  the same answer (no existence leak, as the admin layer already does). Infrastructure errors → 503.
- **Bodies:** JSON only, size-capped (e.g. 16 KB), unknown fields refused.
- **Fold in:** p5-fixv MEDIUM 1. `createBoard` must report the board id if the owner grant fails (PROTOCOL.md §
  Registry 7e834d2: retry or report the failure with the board id, never success for an ownerless board).

## Tests (test/auth/, `bun test`, no network)

End to end against the fake IdP through the handler (call it with `new Request(...)`; optionally a `Bun.serve` on
port 0): full login → callback → token → `POST /boards` → invite → link → redeem by another user → role resolves;
tampered/expired/missing login cookie; state mismatch; nonce replay; open-redirect attempts; Bearer missing/bad;
non-admin refused; unknown board == forbidden board; body too big / bad JSON / unknown field; a Registry throw →
503; the createBoard id-on-failure fix.

## Done when

All routes built and tested, full `bun test` passes, report lists files, tests, the mount hook, what you did NOT
verify (real Google, browser cookie behaviour), risks. Then stop. Do not commit.

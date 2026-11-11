# Brief: p5-auth (OIDC module + tenancy model)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (terminal t14q). Report: docs/m2/reports/p5-auth.md.

## Goal (CEO's words, CLAUDE.md M2 decisions)

"Sign-in: dev tokens, then Google (OIDC) ... Tenant = Google Workspace domain; anyone else by invite or share link.
Boards are created by an admin endpoint (`POST /boards`), never by a hello."

This job builds the server-independent half: the sign-in module, the tenancy model and the admin handler as plain
functions, all tested against a **fake IdP**. Wiring into the HTTP server waits for phase 3 (engine's server/).

## Files you own (touch nothing else, including package.json)

- `server/auth/` — OIDC module, dev-token verifier, tenancy/invite/link model, the Auth port adapter.
- `server/admin/` — `createBoard` (the `POST /boards` handler as a function), invite/link admin functions.
- `test/auth/` — every test, the fake IdP (local keypair + local JWKS), a fake Store.

Plain JS + JSDoc, ES modules, no build step. **No new dependencies**: use Bun's WebCrypto (`crypto.subtle`) for
RS256 verification and PKCE (S256). No network in tests.

## Contract to implement (PROTOCOL.md § Auth, § Tenancy, § Bus ids)

Read the **working-tree** PROTOCOL.md (v1 is being verified). If § Auth changes when it is committed, follow the
committed shape; keep the port adapter in one file (`server/auth/port.js`) so a change is cheap.
`packages/protocol/ports.js` still has the old sync `check`: it is engine-owned and NOT your target.

- `verify(token) → Promise<{ user, name, email, domain } | null>`
- `role(identity, board) → Promise<role | null>`
- The gateway awaits both, plus `Store.board(board)`, before it forwards hello; the room sees only
  `{user, role, client}`. This replaces v0's sync `auth.check` (confirmed by the proxy, t14h, 2026-11-11).
- Roles are the protocol's: `owner`, `editor`, `annotator`, `commenter`, `viewer`. Share links carry only
  `editor`, `annotator` or `viewer`.
- **No existence leak:** an unknown board and a board the identity has no role on give the same answer (null).

## Pieces

1. **OIDC (Google)**, `server/auth/oidc.js`: authorization-code + PKCE (S256) helpers (build the auth URL with
   `state`, `nonce`, `code_challenge`; exchange the code via an injected `fetch`), ID-token verification against
   JWKS (injected fetch, cached by `kid`, refetched once on unknown `kid`). Check: signature (RS256 only), `iss`
   (`https://accounts.google.com` or `accounts.google.com`), `aud` = client id, `exp`/`iat` with small skew,
   `nonce`. Workspace domain = the `hd` claim, **never parsed from the email**. No `hd` = no tenant: guest only.
   Client id/secret come from config passed in (read from env by the caller); **no real credentials anywhere**.
   The session token the server issues after sign-in is your choice (e.g. an HMAC-signed session token, key from
   config); document it.
2. **Dev tokens**, `server/auth/dev.js`: same `verify` shape; enabled only when explicitly configured (off by
   default; a config flag/table must be passed in).
3. **Tenancy model**, `server/auth/tenancy.js` (+ an in-memory store for it):
   - Tenant id is server-minted, `[a-z0-9-]`, never the domain; a registry maps Workspace domain → tenant id.
   - A board belongs to one tenant (from `Store.board(id)`).
   - Role resolution: explicit per-board grant (owner/editor/…), invite, share link, else Workspace member of the
     board's tenant gets the board's `memberRole` (set at creation; **default `viewer`**, a manager decision,
     reversible). Highest role wins. A user from another domain gets a role only by invite or link.
   - Invites (to an email, a role, a board, optional expiry) and share links (random unguessable id, role, expiry,
     revoke). Expiry and revoke take effect on the next `role()` call.
   - Cross-tenant: nothing in tenant A resolves a role on a board of tenant B (except an explicit invite/link to
     that board).
4. **Admin**, `server/admin/boards.js`: `createBoard({ caller, tenant, memberRole, … }, deps)` mints a board id
   (`[a-z0-9-]`), writes the registry, makes the caller owner; refuses callers who aren't a tenant admin. Admin
   functions for invites/links (create, list, revoke). Hello never creates a board.

**Seam gap (raised to the proxy):** the Store port has `board(id)` but no create call and no home for invites,
links and grants. Define a small platform-local port (`server/auth/registry.js`: JSDoc typedef + in-memory impl)
for tenants, boards registry writes, grants, invites, links; the engine will back it with SQLite/Postgres later.
Note it in your report.

## Tests (test/auth/, `bun test`)

- Fake IdP: generate an RS256 keypair in the test, serve its JWKS via an injected fetch, mint ID tokens.
- ID-token refusals: bad signature, wrong `iss`, wrong `aud`, expired, `nonce` mismatch, `alg: none`,
  HS256-with-public-key confusion, unknown `kid` (after one refetch), malformed token. `hd` taken from the claim
  (an email `x@a.com` with `hd: b.com` → domain `b.com`; no `hd` → no tenant).
- PKCE: verifier/challenge per RFC 7636 test vector.
- Dev tokens: off by default; on only with config.
- Model: member default role; grant beats default; invite works cross-domain; link role, expiry, revoke (next
  `role()` call); unknown board == no-role board (both null); cross-tenant refused; tenant ids never contain a
  domain or `.`.
- Admin: createBoard by admin works, by non-admin refused, ids match `[a-z0-9-]`.

## Done when (subset of phase 5; say so in the report)

All of the above pass under `bun test` with the fake IdP, and the full `bun test` still passes. **Not done here,
and must be stated:** end-to-end with the real Google client (waits for the CEO's credentials), HTTP wiring into
server/ (waits for phase 3), persistence beyond memory.

Report to docs/m2/reports/p5-auth.md per BRIEF-BASE.md, then stop. Do not commit.

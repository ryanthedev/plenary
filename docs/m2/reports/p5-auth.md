# Report: p5-auth (OIDC module + tenancy model)

2026-11-11. Outcome: **done for the brief's subset of phase 5.** Google OIDC (PKCE S256 + ID-token
verification), dev tokens, server session tokens, the tenancy/role model, the Registry port (in memory) and the
admin functions are built as plain functions and tested against a fake IdP with no network. `bun test`: full suite
82 pass, 0 fail (28 of them are the new test/auth tests). Not committed.

**For the manager to relay (registry):** method names follow the engine's request (`board(id)`,
`createBoard({tenant, title, memberRole})` minting the id; `server/admin/boards.js` calls it after the admin
check). No name has changed since the first draft. Final signatures are below; treat them as stable.
The working-tree PROTOCOL.md § Registry already lists exactly these names (checked 2026-11-11).

## Registry port: final signatures (`server/auth/registry.js`)

Every method is async. Ids are server-minted over `[a-z0-9-]`: tenants `t-` + 12, boards `b-` + 16, invites
`i-` + 16, links 26 chars (about 134 bits).

| Method | Returns | Notes |
|---|---|---|
| `createTenant({ domain, admins? })` | `Tenant` | throws if the domain already has a tenant; `domain` may be null |
| `tenant(id)` | `Tenant \| null` | `{ id, domain, admins: user[], createdAt }` |
| `tenantByDomain(domain)` | `Tenant \| null` | case-insensitive |
| `addTenantAdmin(tenant, user)` | `void` | |
| `createBoard({ tenant, title?, memberRole? })` | `Board` | mints the id; `memberRole` defaults to `viewer`; null = members get nothing |
| `board(id)` | `Board \| null` | `{ id, tenant, title, memberRole, createdAt }`; replaces `Store.board` |
| `setGrant(board, user, role \| null)` | `void` | null removes the grant |
| `grant(board, user)` | `Role \| null` | |
| `grants(board)` | `{ user, role }[]` | |
| `createInvite({ board, email, role, expiresAt?, by })` | `Invite` | email lower-cased |
| `invite(id)`, `invites(board)`, `invitesFor(board, email)` | `Invite \| null`, `Invite[]` | `{ id, board, email, role, expiresAt, revoked, by, createdAt }` |
| `revokeInvite(id)` | `boolean` | |
| `createLink({ board, role, expiresAt?, by })` | `Link` | |
| `link(id)`, `links(board)` | `Link \| null`, `Link[]` | `{ id, board, role, expiresAt, revoked, by, createdAt }` |
| `revokeLink(id)` | `boolean` | |
| `addLinkUse(link, user)` | `void` | records that a user redeemed a link |
| `linkUses(board, user)` | `linkId[]` | |

`memoryRegistry({ now })` is the in-memory implementation. The engine backs the same calls with SQLite/Postgres.

## What changed (files, all new)

| File | What |
|---|---|
| `server/auth/util.js` | base64url, unbiased random `[a-z0-9]` ids, the role order, `higher()` |
| `server/auth/oidc.js` | `newVerifier`, `challengeS256`, `parseJwt`, `jwksCache`, `verifyIdToken`, `googleOidc({clientId, clientSecret, redirectUri, fetch})` → `begin()` / `finish()` |
| `server/auth/session.js` | `sessions({ key, ttlSec, now })` → `issue(identity)` / `verify(token)` |
| `server/auth/dev.js` | `devAuth(config)`: off unless `{ enabled: true, tokens }` |
| `server/auth/registry.js` | Registry typedef + `memoryRegistry` + `mint` |
| `server/auth/tenancy.js` | `tenancy({ registry, now })` → `role(identity, board)`, `redeemLink(identity, linkId)`, `tenantOf(identity)` |
| `server/auth/port.js` | `authPort({ sessions, dev, tenancy })` → `verify(token)`, `role(identity, board)` (PROTOCOL.md § Auth) |
| `server/admin/boards.js` | `createBoard`, `setGrant`, `createInvite` / `listInvites` / `revokeInvite`, `createLink` / `listLinks` / `revokeLink`, `AdminError` |
| `test/auth/fake-idp.js`, `fake-store.js` | the fake IdP (local RS256 keypair, JWKS and token endpoint through an injected fetch); a fake Store plus a stand-in gateway hello |
| `test/auth/oidc.test.js`, `tenancy.test.js`, `port.test.js` | 28 tests |

No other files were touched: not package.json, PROTOCOL.md or packages/. No dependencies were added; everything
uses Bun's WebCrypto.

## Design decisions

- **Identity:** `{ user, name, email, domain }`.
  - **user:** `google:<sub>`, the stable Google id, never the email. Dev users are `dev:<name>`, so the two can't collide.
  - **domain:** the `hd` claim only, lower-cased. No `hd` means a guest with no tenant.
  - **email:** carried only when `email_verified === true`, so an unverified email can't claim an invite.
- **Session token** (the server issues it after Google sign-in; it is what goes in `hello.token`):
  - **Format:** `s1.<base64url(JSON {u,n,e,d,iat,exp})>.<base64url(HMAC-SHA256(key, "s1."+payload))>`.
  - **Key:** from config, at least 32 bytes. Rotating it signs everyone out.
  - **Lifetime:** 12 hours by default.
  - **Contents:** no roles. Roles are resolved per board on every hello.
- **The port's `verify`** accepts a session token, or a dev token when dev tokens are configured. It never
  accepts a Google ID token, makes no network call, and returns null instead of throwing.
- **ID-token checks:**
  - **Algorithm:** the header must say exactly `RS256`, and the JWK is imported with a hard-coded algorithm, so
    `none`, `HS256` key confusion, `RS512` and `rs256` are all refused.
  - **Required claims:** `exp`, `iat`, `aud`, `sub` and the expected nonce must all be present; a missing one is
    a refusal.
  - **Clock skew:** 60 s.
  - **Array `aud`:** must contain the client id, and if it has more than one entry, `azp` must equal the client id.
- **JWKS (Google's published signing keys):** cached by `kid` (key id). An unknown `kid` causes one refetch, and
  refetches are at least 30 s apart (the clock is injected), so a flood of made-up kids can't hammer Google.
  Callers that arrive during a fetch wait for it. A failed fetch retries after 5 s instead of 30 s.
- **Role resolution is the highest of:**
  - an explicit grant (the board's creator gets `owner`);
  - a live invite to the user's verified email;
  - a live share link the user has redeemed;
  - the board's `memberRole`, when the user's `hd` equals the board tenant's domain.
- **No demotion:** a grant lower than `memberRole` doesn't lower a Workspace member, because the highest role wins.
- **Live reads:** invites and links are read again on every `role()`, so expiry and revoke apply on the next call.
- **Share links:** `hello` has no link field, so a link is bound by `tenancy.redeemLink(identity, linkId)`, which
  the share-URL handler (phase 3) calls after sign-in. It records only that the user used the link; the role
  always comes from the live link record.
- **Admin rights:**
  - **createBoard:** callers must be listed in the tenant's `admins` (matched by user id).
  - **Invites, links and grants:** the board's owner or a tenant admin.
  - **No existence leak:** an unknown board and a board the caller can't manage give the same `forbidden`.
  - **Role limits:** links carry only editor, annotator or viewer. Invites carry anything below owner, and
    `memberRole` can't be owner.

## Tests added (test/auth/, 28)

| Area | What they show |
|---|---|
| ID token | good token gives an identity; `hd` from the claim (`x@a.com` + `hd: b.com` gives `b.com`; no `hd` gives null; a non-string `hd` gives null); unverified email dropped; both issuer spellings; refusals: bad signature, swapped payload, wrong/missing/array `aud`, expired (and within skew passes), future `iat`, missing `exp`/`iat`/`sub`, nonce mismatch/missing, empty expected nonce, `alg: none`/`None`, HS256 keyed with the public key (SPKI and JWK), `RS512`/`rs256` headers, 12 malformed shapes |
| JWKS | cached; unknown kid gives one refetch and is then refused; 20 more bogus tokens cause no fetches (cooldown); key rotation picked up; four concurrent sign-ins on a cold cache share one fetch and all pass; a failed fetch refuses, does not hammer, and retries after 5 s |
| PKCE | RFC 7636 appendix B vector; verifier format |
| Flow | auth URL has state, nonce, S256 challenge, openid scope; `finish` checks state, sends the verifier, refuses another sign-in's nonce and unknown codes; missing client config throws |
| Dev / session | dev off by default (no config, no `enabled`, `enabled` not true, or no table); session round-trip, tamper, wrong key, expiry, short key |
| Model | member default `viewer`; an `@acme.com` email without `hd` is not a member; per-board `memberRole`; grant beats default; no demotion; cross-domain invite; invite and link expiry and revoke on the next call; link roles limited; unknown board equals no-role board (both null; `role()` writes nothing); cross-tenant refused, except an explicit invite to that board; ids are `[a-z0-9-]` and never contain the domain |
| Admin | createBoard by admin; refused for a member, another tenant's admin, null caller, unknown tenant; bad `memberRole`; board owner manages links; member refused; revoke naming another board's link refused |
| Gateway | a stand-in hello awaits verify, the board lookup and the role; unknown board and no role both give `auth` |

## How I checked it

- **Full suite:** `bun test` gives 82 pass, 0 fail. The baseline before my work was 29 pass; the rest are mine
  plus tests other sessions added meanwhile.
- **Mutation check:** I broke the code 15 ways, one at a time, and confirmed at least one test fails each time.
  The breaks were: alg check, nonce, exp, signature, domain from email, JWKS cooldown, invite liveness, link
  liveness, cross-tenant member match, createBoard admin check, link roles, manage rights, dev enabled flag,
  session MAC, and tenant id = domain. Two survived at first: the alg check (covered by the key import) and a
  badly aimed invite mutation. After a new alg test and a re-aimed mutation, both are caught.
- **Review fix:** a review found that concurrent sign-ins on a cold JWKS cache were refused (the cooldown was
  checked before waiting for the fetch in progress). Fixed in `jwksCache.key` and covered by the concurrency test.
- **Unawaited assertions:** I found `.rejects` assertions that weren't awaited, which Bun may skip, and fixed all
  of them before running the mutation check.

## Not done here (by the brief)

- **Real Google sign-in end to end:** not run. It waits for the CEO's OAuth client credentials.
- **HTTP wiring into server/:** not built. That means `POST /boards`, the sign-in callback, the share-URL redeem
  and the session cookie or token hand-off; it waits for phase 3.
- **Persistence beyond memory:** not built. The engine backs the Registry with SQLite or Postgres.

## Risks and open points

1. **Sessions outlive a Workspace departure** until `exp` (12 hours by default), because `verify` is offline and
   `domain` is frozen in the token. Revocation is an M6 item (SCIM, Google's System for Cross-domain Identity
   Management user sync).
2. **Bootstrapping a tenant is open.** The brief doesn't say how the first tenant and its admin are created. I
   added `registry.createTenant` and `addTenantAdmin`, but there is no endpoint or policy for them.
   Question for the manager: is it an operator CLI, or does the first sign-in from a domain create a tenant?
3. **Share-link guests must sign in.** With no sign-in, `role()` has no identity to bind a link to. Supporting
   anonymous link viewers needs a guest session (for example `guest:<random>`). Question for the manager: is
   that wanted in M2?
4. **Unbounded state in the in-memory registry:** link uses and expired invites are never pruned. The engine's
   SQL version should add a cleanup.
5. **Sign-in state storage:** `finish()` needs the `{state, nonce, verifier}` that `begin()` returned. Storing
   them (server-side, or in a signed HttpOnly cookie) is phase 3 wiring.
6. **An outage looks like a refusal.** PROTOCOL.md § Auth says `verify` and `role` "resolve null on refusal,
   never throw", so `port.js` `role()` catches registry errors and returns null. The gateway then answers `auth`
   (refused) instead of `unavailable` (retry). Question for the manager: should a store error throw so the
   gateway can answer `unavailable`?
7. **Board creation is two writes.** `createBoard` calls `registry.createBoard` and then `setGrant(owner)`; a
   crash between them leaves a board with no owner (tenant admins can still manage it). The engine's SQL
   version could do both in one transaction.
8. **Memory recall:** I couldn't check Engram (cross-session memory) first; it was unreachable (DNS resolver
   error).

## Fix round (2026-11-11, from p5-authv and manager t14q)

Outcome: every item the manager listed is fixed, and each has a test. test/auth has 42 tests (was 28); the full
`bun test` gives 143 pass, 0 fail. **No Registry method name changed.** Not committed.

### What changed

| Item | Fix | Where | Test |
|---|---|---|---|
| **M1** stale third-party email | `email` is carried only when Google is authoritative: it ends in `@gmail.com`, or `email_verified` is true **and** `hd` is set (Google's "Verify the Google ID token" guide). | `oidc.js` `authoritativeEmail` | `oidc.test.js` M1 (5 cases, including `x@gmail.com.evil.example`); `port.test.js` "M1 end to end": a no-`hd` token for `cfo@partner.example` passes through ID token, session token, port, and `role()` returns null; a gmail.com invite still works |
| **M2** withdrawn key trusted forever | Keys are fresh for `Cache-Control: max-age`, capped at 1 h and floored at the 30 s cooldown; no header means 1 h. A stale lookup refetches. | `oidc.js` `jwksCache` | M2: a removed key stops verifying after max-age; `max-age=604800` is capped at 1 h |
| **M3** empty JWKS wipes the cache | A 200 with no usable RSA key counts as a failed fetch, and the old keys stay. | `jwksCache` `load` | M3: `{}`, `{keys:[]}` and an EC-only set each refetch (asserted) and keep the old key |
| **M4** fetch that never settles | `AbortSignal.timeout` (default 10 s, `timeoutMs` in config) on both the JWKS and token fetches; a timeout is a failed fetch (retry after 5 s). | `jwksCache`, `googleOidc.finish` | M4 ×2: a hanging JWKS fetch times out and sign-in recovers; a hanging token request times out |
| **M5** role() trusted the Registry | `capTo(role, allowed)`: an unknown role counts for nothing; `memberRole` and invites are capped below owner (owner becomes editor); links are capped to editor, annotator or viewer (e.g. commenter becomes viewer). Explicit grants may still be owner. | `util.js` `capTo`, `tenancy.js` | M5: direct Registry writes of `owner` and `god` in every slot |
| **M6** owners minting owners | Only a tenant admin grants `owner`. A board owner grants up to editor, and may change an owner's grant only if it is their own (stepping down). Nobody, including tenant admins, removes or demotes a board's last owner; that refusal is `AdminError` code `last-owner`. | `admin/boards.js` `setGrant` | M6: owner can't grant owner (including cross-tenant) or strip the creator; can step down while another owner remains; last owner protected against admin and self |
| **M7** empty state or missing verifier | `finish()` refuses unless `expected.state`, `.nonce` and `.verifier` are non-empty strings; nothing is sent to Google. | `googleOidc.finish` | M7: five bad records, zero token requests |
| **L3** huge names | Name is capped at 200 characters at sign-in, and again in `sessions.issue`. | `oidc.js`, `session.js` | L3 ×2: a 5,000-character name gives a 200-character name, and the session verifies |
| **L6** iat/exp sanity | `exp > iat` is required; an `iat` older than 24 h is refused. | `verifyIdToken` | L6 |
| **L7** hd whitespace | `hd` is trimmed and lower-cased; a blank `hd` means no domain. | `verifyIdToken` | L7 |
| **L8** dev entry without a name | `devAuth` throws at config unless every entry has a name matching `[A-Za-z0-9_.@-]{1,64}`. A `Map` is accepted. | `dev.js` | L8 |

Changes to earlier behaviour that callers should know:
- **`AdminError` code:** `last-owner` is new.
- **`jwksCache` options:** `maxAgeCapMs`, `retryMs` and `timeoutMs` are new.
- **`googleOidc` config:** `timeoutMs` is new.
- **Concurrency line removed:** the extra "wait for the fetch in flight" line in `jwksCache.key` is gone, because
  the mutation check showed it was redundant: `refresh()` already shares a fetch in progress. The concurrency
  test still passes.

### How I checked it

- **Mutation check:** 42 mutations in all: 25 on the new code, the original 16 re-run on the changed code, and one on
  `refresh()` sharing a fetch in progress.
  Every one fails at least one test.
- **Survivors on the first pass, all fixed:**

| Mutation | Why it survived | What I did |
|---|---|---|
| Both M4 timeouts removed | the hanging fake fetch threw when no signal was passed, so it failed closed | made it hang for real |
| `exp` check removed | masked by the new `exp > iat` rule | added an expired token with a sane `iat` |
| Concurrency wait removed | the line was redundant | removed it |

- **Full suite:** 143 pass, 0 fail, run three times.
  - **One flake:** in one run a test I don't own (`test/web/sync.test.js`, "pointer move, resize and
    rotate…") failed once. It passed in the next two full runs and on its own, so it's flaky or was being edited
    mid-run, and isn't related to this job.

### Still open (unchanged from above)

- **L1, L2, L4, L5, L9:** not asked for in this round; they are as the verifier described.
- **Retired keys if Google is unreachable:** a stale key is still used when Google can't be reached (the refetch
  fails and the old keys stay). That chooses availability over withdrawal speed. It only matters if someone holds
  a Google signing key, and only while Google's JWKS endpoint is down for us.
- **Earlier questions:** tenant bootstrap, anonymous link guests, and outage vs `auth` are still open (risks 2,
  3 and 6 above).

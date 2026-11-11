# Report: p5-fix (auth port errors, authoritative email, last-owner in the Registry)

2026-11-11. Outcome: **done.** All four fixes plus the manager's addition (a shared Registry contract test).
Not committed.

- **`bun test test/auth`:** 65 pass, 0 fail.
- **Full `bun test`:** 166 pass, 0 fail at first. A re-run at 17:36 gave 171 pass and 1 fail, with a second,
  flaky fail in one of three runs.
- **The steady fail is not from this job:** it is `test/server/gateway.test.js:134`, "bad frames…". The gateway
  answers code `version` to a `v: 99` hello (`server/gateway.js:117`). That check runs before any Auth call, and
  the test's list of allowed codes lacks `version`.
- **Who is editing it:** both files changed at 17:36:36, in the middle of the engine's p1-seam (engine-owned).
- **The flaky one:** "clients converge… (seed 1)" failed once in three runs; it is engine territory too.

## For the engine (relay): shared Registry contract test

- **What:** `test/auth/registry-contract.js` exports `registryContract(name, makeRegistry, opts?)`. It registers
  18 bun tests under `describe("Registry contract: <name>")`.
- **Factory:** `makeRegistry({ now })` is async and returns a fresh, empty Registry. `now()` is the test clock in
  ms, and the adapter must stamp `createdAt` with it. Optional `opts.cleanup(registry)` runs after each test
  (close a DB, drop a schema).
- **Usage:** `registryContract("sqlite", async ({ now }) => sqliteRegistry({ path: ":memory:", now }))`.
- **What it covers:**
  - **Ids:** id shapes (`t-`+12, `b-`+16, `i-`+16, links 26, all `[a-z0-9]`).
  - **Tenants:** domain uniqueness (case-insensitive; null domains not unique), case-insensitive `tenantByDomain`,
    `addTenantAdmin` (idempotent; unknown tenant rejects).
  - **Boards:** `createBoard` defaults (title `""`, memberRole `viewer`, `null` kept), unknown tenant rejects, reads
    return copies.
  - **Grants:** set, overwrite, remove, per board, unknown board rejects.
  - **Last owner:** sequential refusal with no change, then concurrent refusal for pairs and for five owners.
  - **Invites:** email trimmed and lower-cased, `invitesFor` case-insensitive, revoke (stays listed; unknown gives
    false).
  - **Links:** fields, `links(board)`, revoke, `addLinkUse` / `linkUses` (idempotent, per board and user; unknown
    link rejects).
- **Memory-specific:** nothing. It uses only public Registry methods and matches refusals by `err.code`, never by
  class.
- **Run against memory:** `test/auth/registry.test.js`.
- **New export:** `RegistryError` in `server/auth/registry.js` (class, `code: "last-owner"`). No method names
  changed. Other adapters need not use the class; they only have to reject with `code === "last-owner"`.

## For the engine (relay): PROTOCOL.md hand-offs (not my file)

- **Name the error code:** § Registry ("At least one owner per board, atomically") says the refused call "fails
  and changes nothing" but doesn't name the error. The contract pins `err.code === "last-owner"`. Please add that
  to § Registry.
- **Behaviour the contract pins that PROTOCOL.md doesn't state** (all current `memoryRegistry` behaviour; object
  now if any is wrong):
  - **Writes on unknown ids reject:** `createBoard` for an unknown tenant, `setGrant` / `createInvite` /
    `createLink` for an unknown board, `addLinkUse` for an unknown link, `addTenantAdmin` for an unknown tenant.
  - **Reads of unknown ids give empty answers:** `tenant`, `board`, `invite` and `link` give `null`; `invites`,
    `links`, `grants` and `linkUses` give `[]`.
  - **Revokes report what they did:** `revokeInvite` / `revokeLink` give `true`, or `false` for an unknown id, and
    a revoked row stays listed.
  - **Duplicates are refused or ignored:** a duplicate domain (case-insensitive) rejects; `addTenantAdmin` and
    `addLinkUse` are idempotent.
- **Email rule already matches:** PROTOCOL.md § Tenancy (lines 408–409, 552) already states the new
  authoritative-email rule and the secondary-domain consequence. No change needed.

## Fixes

| # | Fix | Files | Test (red before, green after) |
|---|---|---|---|
| 1 | **Outage is not refusal.** `authPort` no longer catches. `verify` and `role` give null for bad input (junk, forged or expired tokens, unknown board, no role); a throwing verifier or Registry rejects, so the gateway answers `unavailable`. Port comment rewritten. | `server/auth/port.js`, `test/auth/fake-store.js` (stand-in hello maps a throw to `unavailable`, like `server/gateway.js`) | `port.test.js` "p5-fix 1: a Registry outage propagates…" and "…verify refuses bad tokens with null but lets a verifier's failure through" |
| 2 | **Authoritative email.** Email counts only if `email_verified` AND (it ends `@gmail.com` OR its domain equals `hd`). `hd` is trimmed and lower-cased at the call site; the email is too. | `server/auth/oidc.js` | `oidc.test.js` "p5-fix 2": `x@other.com` + `hd: acme.com` gives no email (still domain `acme.com`); subdomain refused; case and whitespace OK; unverified refused; gmail with an `hd` still OK |
| 3 | **Last owner in the Registry.** `memoryRegistry.setGrant` checks and writes with no await in between, and throws `RegistryError("last-owner")` without changing anything. Admin `setGrant` keeps its caller rules and its pre-check, and maps a Registry `last-owner` to `AdminError("last-owner")`. | `server/auth/registry.js`, `server/admin/boards.js` | `tenancy.test.js` "p5-fix 3: registry.setGrant refuses…" and "p5-fix 3 (p5-authv R1): two concurrent demotions…"; also the contract suite. The existing M6 test still passes. |
| 4 | **Stale header.** registry.js now says the board lookup is `Registry.board(id)`, points at PROTOCOL.md § Registry and the contract test, and documents the last-owner rule. | `server/auth/registry.js` | n/a |

**Behaviour change (fix 2):** a Workspace user whose address is on a secondary domain of their Workspace (email
domain ≠ `hd`) now gets no email, so they **can't claim an invite by email**. They still get the member role via
`hd`, and a share link works.

## How I checked

- **Tests first:** I wrote the five new tests before the fixes and saw all five fail, then saw them pass.
- **Mutation check:** I ran the contract against a copy of `memoryRegistry` with the old non-atomic shape (read
  the count, `await`, then write). Only the concurrent last-owner test failed, so the contract catches the R1
  race.
- **Protocol and gateway:** PROTOCOL.md § Auth (lines 432–435) already says null = `auth` and throw =
  `unavailable`. `server/gateway.js:96-103` already wraps `verify`, `registry.board` and `auth.role` in try/catch
  and answers `unavailable`. Neither needed a change.
- **Full suite:** `bun test` passes: 166 tests, 0 fail.

## Not verified

- **Real gateway path:** I did not drive an outage through `server/gateway.js` itself, only through the stand-in
  in fake-store and by reading the gateway code.
- **SQL adapters:** none exist yet, so the contract has run only against memory and the mutant.
- **Real Google token:** no live Google sign-in with a secondary-domain account. The `hd` / email behaviour is
  tested only against the fake IdP.

## Risks

1. **Dev-token startup** (`server/main.js:52`, not my file): if two dev tokens share a name, the first with role
   `owner` and a later one without, startup now throws `last-owner`. Before, it silently demoted. This is unlikely
   (names are effectively unique), but the engine may want to dedupe or catch it there.
2. **Session verifier swallows its own failures:** `session.verify` still turns any throw inside crypto or JSON
   parsing into null. That is right for malformed tokens, but a WebCrypto failure would read as a refusal. Both
   inputs come from the token itself, so I judged it bad input.
3. **Contract clock requirement:** the contract requires adapters to take `now` and use it for `createdAt`. A
   Postgres adapter that stamps with `now()` in SQL will fail those assertions unless it honours the injected
   clock.
4. **Two last-owner checks:** the admin pre-check is now redundant with the Registry's atomic check. I kept it
   on purpose (it gives the same error sooner and keeps the M6 test unchanged). It is harmless, because the
   Registry decides races.

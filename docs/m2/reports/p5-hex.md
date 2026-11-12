# Report: p5-hex (server/auth and server/admin follow the hexagonal rule)

Done. Imports in server/auth and server/admin follow the rule. `test/auth/architecture.test.js` proves it, and it
failed on the tree before the fix. Every auth adapter passes its port's contract. `bun test`: **367 pass, 0 fail**
(437 tests across 26 files; the baseline before this job was 331 pass, 0 fail). Nothing committed.

## The manager's audit, checked

| Audit row | Verdict |
|---|---|
| registry/sqlite.js:18, postgres.js:20, postgres.js:38 import the memory adapter | **Confirmed, and incomplete.** **sqlite.js:32** (`@returns {import("../auth/registry.js").Registry …}`) is a fourth line of the same kind. I was cleared for three lines, so I left it alone. The new test tracks it as a KNOWN exception (below). |
| dev.js:5, port.js:15 type-import Identity from oidc.js | Confirmed. **session.js:12 does the same.** |
| port pieces live in the memory adapter | Confirmed; moved to `registry-port.js`. |
| http.js calls oidc.begin()/finish(), a port that is written down nowhere | Confirmed. It is now `idp-port.js`, with a contract test. |
| admin/boards.js "imports only auth/util.js, looks fine" | **Wrong.** Its JSDoc types import `../auth/registry.js` and `../auth/oidc.js` (lines 15 and 16), so it is core importing adapters. **tenancy.js (core) did the same** (lines 15 to 17). Both are fixed. |

The test found 8 violations on the tree before the fix (JSDoc `import("…")` types count):

```
server/auth/session.js -> server/auth/oidc.js: adapter imports adapter
server/auth/port.js -> server/auth/oidc.js: port imports adapter
server/auth/dev.js -> server/auth/oidc.js: adapter imports adapter
server/auth/tenancy.js -> server/auth/registry.js: core imports adapter
server/auth/tenancy.js -> server/auth/oidc.js: core imports adapter
server/admin/boards.js -> server/auth/registry.js: core imports adapter
server/admin/boards.js -> server/auth/oidc.js: core imports adapter
server/registry/postgres.js -> server/auth/registry.js: only a composition root may import adapter
```

sqlite.js:18 (the runtime import) is missing from that list. The KNOWN exception was then keyed by file pair, which
hid it. That was a bug in the first version of the test, since fixed (see "How I checked it"): the exception now
excuses only the `[type]` reference at sqlite.js:32.

**Correction from that fix:** reverting sqlite.js:18 now fails the test with
`server/registry/sqlite.js -> server/auth/registry.js [runtime]: only a composition root may import adapter`.

## File classification (also the `CLASSES` table in the test)

| File | Class | Why |
|---|---|---|
| server/auth/registry-port.js | port | **New.** Registry typedefs (Role, Tenant, Board, Invite, Link, Registry), `mint`, `RegistryError`, the last-owner and failure rules. |
| server/auth/idp-port.js | port | **New.** Types only: Identity, the IdP port (`begin`/`finish`), the Verifier port (`verify`), and their failure semantics. |
| server/auth/port.js | port | The Auth port (`verify`, `role`, now an `Auth` typedef) plus `authPort`, which is composed over injected verifiers and tenancy and imports no adapter. |
| server/auth/util.js | core | Pure helpers: roles, base64url, ids. |
| server/auth/tenancy.js | core | Role resolution over the Registry port. |
| server/admin/boards.js | core | Admin use cases over the Registry port. |
| server/auth/registry.js | adapter | In-memory Registry. |
| server/auth/oidc.js | adapter | Google OIDC (IdP port). |
| server/auth/session.js | adapter | Session tokens (Verifier port, plus `issue`). |
| server/auth/dev.js | adapter | Dev tokens (Verifier port). |
| server/auth/http.js | driving | HTTP routes. Its adapters are injected; it imports only util.js and admin/boards.js (core). |

**Where the Auth port lives:** it stays in port.js, because that is the file the gateway and main.js already import, and
moving it would touch engine files. The types it composes over (Identity, Verifier) sit beside the IdP port in
idp-port.js, because all three describe "something that yields an Identity".

## What changed

- **New port modules:** `server/auth/registry-port.js` and `server/auth/idp-port.js`.
- **server/auth/registry.js:** now only the memory adapter. It imports `mint`/`RegistryError` from the port and keeps
  `export { mint, RegistryError }`, marked "until engine's registry adapters import registry-port.js". It also keeps
  typedef aliases for Registry, Role and the rest, so the remaining JSDoc reference at sqlite.js:32 still resolves.
- **Type imports switched to the port modules:** dev.js, session.js, port.js, tenancy.js, admin/boards.js, oidc.js (its
  `Identity` is now an alias plus an `@returns IdP & {…}`), http.js (the inline `oidc` type is now `IdP|null`) and
  test/auth/registry-contract.js (its JSDoc only).
- **Behaviour:** no runtime change. The only runtime-visible move is that `mint`/`RegistryError` are now defined in
  registry-port.js and re-exported from registry.js, so they are the same objects as before.
- **Engine lines, exactly three:** `server/registry/sqlite.js:18`, `server/registry/postgres.js:20` and
  `server/registry/postgres.js:38` now point at `../auth/registry-port.js`. Nothing else in those files changed.
  - **sqlite.js is tracked:** it carries a one-line diff. **Recommendation:** platform's commit includes it (engine
    agreed to the line). If it is left out, the architecture test fails on the commit, because a runtime import of
    the memory adapter is not excused.
  - **postgres.js is untracked** (engine-uncommitted), so platform's commit won't carry it. Engine's next commit of
    postgres.js carries both changed lines.
- **Paths and export names are unchanged** (`authPort`, `devAuth`, `tenancy`, `memoryRegistry`, `googleOidc`,
  `sessions`), so main.js, test/server/rig.js and the engine tests needed no edit.

## Tests added (test/auth/)

| File | What it does |
|---|---|
| architecture.test.js | The import rule. It parses static `import`/`export … from`, side-effect imports, `import()` and JSDoc `import("…")`, relative specifiers only (so `crypto.subtle.importKey(` doesn't match). Rules: every file in scope is classified; nothing in scope imports an `adapter` or `driving` file; nothing in scope reaches outside server/auth and server/admin; and **inbound**, no file under server/ other than main.js imports an auth adapter (that rule is what sees the engine violation). The checker is a pure function with synthetic cases for each kind of violation, plus look-alikes that must not match. |
| idp-contract.js | The IdP port contract, 8 tests: fresh begin values; a round trip gives exactly an Identity; refuses a bad state, a missing or incomplete `expected`, a missing or unknown code, and a code from another sign-in (nonce); garbage never throws; an unreachable IdP gives null and the adapter recovers. |
| verifier-contract.js | The Verifier contract, 5 tests: its own token gives exactly the Identity; about 25 garbage values give null without throwing; a tampered token gives null; verify is repeatable; an expired token gives null (when the adapter expires tokens). |
| fake-idp-adapter.js | **New** in-memory IdP adapter (codes bound to nonce and verifier, single use, `down` flag). It is separate from fake-idp.js, which fakes Google's network. |
| contracts.test.js | Runs the IdP contract against `googleOidc` (over the fake Google network, with a fetch that can be switched off) and `fakeIdpAdapter`, and the Verifier contract against `sessions` and `devAuth`. |

The KNOWN mechanism: every violation is tagged `[runtime]` or `[type]`. `KNOWN = ["server/registry/sqlite.js ->
server/auth/registry.js [type]"]` excuses only the JSDoc reference; a synthetic test proves that a runtime import of
the same file still fails. A separate test fails once the excused violation is gone, so the list only shrinks.
An extensionless or unknown in-scope target (`./registry`) is also a violation.

## How I checked it

- **Baseline:** `bun test` before any change gave 331 pass, 0 fail.
- **Fails before the fix:** architecture.test.js on the old tree gave the 8 violations above.
- **Catches a re-introduced violation:** I put `import("./registry.js").Registry` back into tenancy.js. The test
  failed with `server/auth/tenancy.js -> server/auth/registry.js: core imports adapter`, then I restored the file.
- **The contracts can fail:** in a scratch file I ran them against deliberately broken adapters: an IdP that ignores
  state, an IdP that throws when down, and a verifier that throws on non-strings. Each failed the matching contract
  tests (3 failures).
- **Catches a reverted engine line:** I put `../auth/registry.js` back at sqlite.js:18. The test failed with the
  `[runtime]` violation, then I restored the line.
- **After the change:** the full `bun test` gave 367 pass, 0 fail.
- **Tamper test:** it flips the second-to-last character, not the last, because base64url's last character can carry
  padding bits that a decoder ignores (a flip there could leave the bytes unchanged).

## Systems design skill (`distributed-systems-design`, APPLIER mode, kept proportionate)

This job defines ports rather than new infrastructure, so I applied the APPLIER Phase 5 failure analysis, the
Reliability Checks (SKILL.md, "no single point of failure"), and chapter-01's "Stateless Web Tier" (any server
handles any request; no sticky sessions) to each port. The answers are written into the port files
as what a second adapter must honour:

- **Registry:** an infrastructure failure must **reject**, never resolve to null, because callers turn null into a
  refusal ("no role") and a rejection into `unavailable`. *Confirmed* the existing rule; it is now written in the port.
  A memory adapter can't show this, so the contract doesn't test it: risk (below).
- **Verifier:** offline and stateless. Any node verifies any session, so gateways need no sticky sessions
  (chapter-01's goal). We reach it differently from chapter-01: state lives in a signed token, not a shared session
  store, so there is no store to be a single point of failure. The trade-off, already in session.js, is that a
  session can't be revoked before `exp` (12 h) except by rotating the key. null means "not mine or invalid", it never throws
  on garbage, and a genuine failure may reject. *Confirmed* and now tested.
- **IdP:** the login state lives in a signed cookie, not in server memory, so `/auth/callback` can land on any node
  behind the load balancer. *Confirmed.* **Changed (made explicit):** `finish` resolves null on an outage as well as
  on a refusal. That is deliberate: sign-in is interactive and the person retries. But it is a different split from
  the Auth port's null-versus-reject rule, so it is now written in idp-port.js and tested ("unreachable IdP gives
  null, then recovers"). Adapters must also bound their own network calls (oidc.js already does, with
  `AbortSignal.timeout`).
- **Scale:** no new hot path. Sign-in is rare compared with hellos, and `verify` is one HMAC with no I/O, so no
  estimate changes anything here.

## Not verified

- **Postgres:** `bun test test/server/pg-registry.test.js test/server/registry.test.js` gives 23 pass, 26 skip, 0 fail.
  The SQLite Registry contract passes. The Postgres contract is skipped here because there is no database, so
  postgres.js's changed line is only proven to resolve when the test file loads the module, not exercised.
- **No type checker:** no tsc/JSDoc checker runs in this repo, so the JSDoc retyping (the `IdP`, `Auth` and `Registry`
  `@returns`) is unchecked beyond reading it.
- **No live Google sign-in:** the IdP contract runs googleOidc against the fake Google network only.

## Risks and follow-ups

- **Engine, sqlite.js:32:** switch the JSDoc to `import("../auth/registry-port.js").Registry`, then delete its KNOWN
  entry in test/auth/architecture.test.js. Once sqlite.js and postgres.js are both on registry-port.js (they are for
  the runtime imports now), platform can delete the `export { mint, RegistryError }` re-export in registry.js. Keep the
  typedef aliases until sqlite.js:32 moves.
- **Engine, test/architecture.test.js:** the repo-wide test can copy the checker's approach (import kinds, the pure
  `violations()` function, synthetic cases). Importing it from a `.test.js` file would re-register that file's tests,
  so if engine wants to share it, platform should first move the checker and `CLASSES` into a plain module (as
  registry-contract.js is). My inbound rule covers only server/; tests and web/ are out of scope.
- **Who deletes the KNOWN entry:** when engine fixes sqlite.js:32, platform's KNOWN test goes red, and engine can't
  edit test/auth. **Platform deletes the entry in the same change** (the manager lands both together).
- **Stale doc pointers, not changed (not my files):** PROTOCOL.md:443 ("Platform owns its implementation
  (server/auth/registry.js)": still true for the memory adapter, but the port's home is now registry-port.js);
  docs/m2/COMMITMENTS.md:34 and :35 (historical, so leave them); server/store/sqlite.js:13 (engine: "it is the Registry
  port's (server/auth/registry.js)", which should say registry-port.js).
- **The IdP outage-is-null rule:** an outage at Google shows the person a generic failed sign-in, not "try later",
  and http.js has no signal to log it as an outage. If operators need that, the port must change to reject on an
  outage (and http.js must map that to 503). That is a decision, not a bug.
- **A new file in server/auth or server/admin fails the build until it is classified.** That is on purpose.

## Amendment (2026-11-11, from manager platform t187; engine t18m agreed to the fourth line)

- **sqlite.js:32 switched:** the JSDoc `@returns` now names `import("../auth/registry-port.js").Registry`. Nothing
  else in that file changed. Its full diff against HEAD is now two lines, :18 and :32. The comment at sqlite.js:2 and
  postgres.js:2 still names `server/auth/registry.js`, which is accurate: it refers to the memory adapter.
- **The KNOWN mechanism is removed, not kept empty:** no exception remains, and an empty allowlist would only invite
  new entries. Removed: the `KNOWN` list, its filter in the rule test, the "KNOWN exceptions still exist" test, and
  the synthetic "KNOWN type exception" test.
  - **Still there:** the runtime/type tagging, which makes violation messages clearer.
  - **Changed:** the synthetic test now checks that a runtime import and a JSDoc type of the same file are reported
    separately.
- **Checked:**
  - `bun test test/auth/architecture.test.js`: 9 pass, 0 fail.
  - **Line 32 reverted:** the test fails with
    `server/registry/sqlite.js -> server/auth/registry.js [type]: only a composition root may import adapter`. I then
    restored the line.
  - Full `bun test`: **366 pass, 0 fail** (436 tests across 26 files; one fewer test than before, the removed KNOWN
    test).
- **Follow-up now unblocked:** both engine adapters import `registry-port.js` at runtime and in their types, so
  platform can delete the re-export `export { mint, RegistryError }` and the typedef aliases in
  server/auth/registry.js. I left them in place: deleting them is outside this amendment, and postgres.js is still
  engine-uncommitted.

## Fix round (2026-11-11, from manager platform t187, after p5-hexv PASS with 2 MEDIUM)

All four items are fixed. Full `bun test`: **376 pass, 0 fail** (454 tests across 27 files; the 27th file,
test/auth/google-live.test.js, is not this job's).

**(1) MEDIUM 1: the import checker skipped an `export … from` below a comment line. Fixed.**
- **The bug:** the comment check used `m[0].indexOf("import")`, which is -1 for `export`, so it looked at the line
  above.
- **The fix:** it now uses the position of the matched keyword (`import` or `export`) itself.
- **New synthetic cases (all must be flagged):**
  - the verifier's `// …` followed by `export { a } from "./a.js"`;
  - `export * from` below a `/** */` line;
  - an `import` below a ` * ` line.
  - Control: the same lines commented out are still ignored.
- **LOW 3 forms now caught, each with a synthetic case:**
  - no-space `import{a}from"./a.js"` and `export*from"./a.js"`;
  - ``import(`./a.js`)`` with a template literal;
  - `require("./a.js")` (ignored when on a comment line).
  - Control: string literals such as `export const x = "./a.js"` are not flagged.
- **LOW 3 forms still missed, now listed in the `importsOf` doc comment:** a block comment between `import` and its
  `(`, `import.meta.resolve`, and an apostrophe in a comment inside a multi-line import.
- **Proof:** on a scratch copy of the tree, the verifier's repro (that comment line plus
  `export { googleOidc } from "./oidc.js"` appended to tenancy.js) now fails with
  `server/auth/tenancy.js -> server/auth/oidc.js [runtime]: core imports adapter`. Before the fix it gave 9 pass.

**(2) MEDIUM 2: the IdP contract now fails an adapter with no PKCE check and one whose code works twice.**
- **New contract tests:**
  - **Same nonce, other sign-in:** a code from sign-in A, finished with sign-in B's state and verifier but A's
    nonce, is refused.
  - **Code works once:** finishing the same code a second time gives null.
- **googleOidc needed a stricter fake Google:** test/auth/fake-idp.js gets opt-in `strictCode(code, idToken, url)`.
  These codes are single use and PKCE-checked: the token endpoint compares S256(`code_verifier`) with the
  `code_challenge` in the authorize URL and answers 400 `invalid_grant` on a mismatch, as Google does.
  - contracts.test.js uses strict codes for googleOidc.
  - The old lenient `codes` map is unchanged, so http.test.js and oidc.test.js behave as before.
  - For googleOidc, these two tests therefore check that the adapter sends the right verifier; enforcing PKCE and
    single use is Google's job. The port doc says so.
- **Proof:** in a scratch file I ran the contract against three deliberately broken in-memory adapters and one
  correct control. Each broken adapter failed exactly its own test (3 fail, 41 pass); the control passed all 11:
  - no PKCE check: fails "a code from another sign-in with the SAME nonce is refused";
  - reusable code: fails "a code works once";
  - `finish(null)` throws: fails "a non-object argument never rejects".

**(3) LOW 5: I fixed the code, not the doc.**
- **Code:** `googleOidc().finish` and `fakeIdpAdapter().finish` now treat a non-object argument as `{}` and resolve
  null. This is a small runtime change in oidc.js: `finish(null)` used to reject with a TypeError. http.js always
  passes an object, so nothing in the app changes.
- **Port doc:** idp-port.js says finish never rejects on garbage, including a non-object argument, and that
  `begin()` ignores its arguments.
- **New contract test:** `finish(null | undefined | 0 | 42 | "x" | true | [])` gives null, and
  `begin("garbage", null, {})` works.

**(4) LOW 6: done.** registry-port.js now says "reads see every write acknowledged before them (read-your-writes and
no stale replica reads), so a revoked grant, invite or link stops working on the very next role()".

**Other LOWs (4, 7, 8, 9): left alone, as instructed.** Of those:
- **LOW 9 is still unexplained.** The rule test reads the live tree, so a file being created or edited under server/
  during a run can fail it.
- **LOW 8 is engine's:** postgres.js imports a Store adapter.
- **Files touched this round:** test/auth/architecture.test.js, idp-contract.js, fake-idp.js, fake-idp-adapter.js
  and contracts.test.js; server/auth/oidc.js (finish), idp-port.js and registry-port.js (doc comments only).

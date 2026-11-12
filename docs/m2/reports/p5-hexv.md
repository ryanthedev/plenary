# Report: p5-hexv (verify p5-hex)

**PASS, with 2 MEDIUM and 7 LOW.** No HIGH. The hexagonal rule holds on the current tree, including the amendment.
Runtime behaviour is unchanged. Every auth adapter passes its port's contract. The full `bun test` passes (one
unexplained architecture-test failure in 8 full runs, finding 9).

The MEDIUMs are holes in the safety nets, not defects in the shipped code:
- **The import checker can be fooled** by one ordinary-looking line.
- **The IdP contract** (the shared test suite every sign-in adapter must pass) **tests neither PKCE binding nor
  single-use codes.**

I changed nothing in the tree. All probes ran on scratch copies.

## Findings

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 1 | MEDIUM | test/auth/architecture.test.js:52 | **An `export … from` directly below a comment line is skipped.** For `export`, `m[0].indexOf("import")` is -1, so `onComment` checks the line *before* the match. If that line is a comment, the re-export counts as commented out. `export * from` has the same hole. A plain `import` below a comment is caught. | **Confirmed on the real test.** On a scratch copy I appended `// Convenience re-export for callers.` and then `export { googleOidc } from "./oidc.js";` to tenancy.js, which is core. Result: 9 pass, 0 fail. |
| 2 | MEDIUM | test/auth/idp-contract.js; test/auth/fake-idp.js:49 | **A broken IdP adapter can pass all 8 IdP contract tests.** (1) An adapter that never checks the PKCE verifier against the code still passes. The "code from another sign-in" test changes the nonce too, so the nonce check rejects it first. (2) A code that can be redeemed twice still passes. No test finishes the same code twice. | **Confirmed by probe:** two deliberately broken in-memory adapters (no PKCE check; reusable code) each passed 16/16. Codex flagged the same gap on its own. |
| 3 | LOW | architecture.test.js:50 to :52 | **Other forms the checker misses** (probed): `require("./b.js")` (Bun allows it in ESM), ``import(`./b.js`)`` with a template literal, `import{x}from"./b.js"` with no spaces, an apostrophe inside a comment in a multi-line import (`// don't`), `import.meta.resolve`, and codex's `import /* c */ ("./b.js")`. All are unusual in this codebase. | Confirmed by probe (codex's form not run; it plainly falls outside the regex). |
| 4 | LOW | architecture.test.js:100 (`walk`) | **Only `.js` files are scanned.** A `.mjs` or `.ts` file in server/ is never classified or checked (codex). | Confirmed by reading. |
| 5 | LOW | server/auth/idp-port.js:21 | **The doc says `finish` "never throws on garbage input", but `finish(null)` throws a TypeError** in both googleOidc and the fake adapter (codex). They destructure the argument, and the contract only tries `finish({})`. | **Confirmed by running it.** Harmless today: http.js:161 always passes an object and catches anyway. |
| 6 | LOW | server/auth/registry-port.js | **The Registry port doesn't state its consistency model** (skill: "Consistency model explicitly chosen"). Nothing says a read sees a prior write. Today every adapter reads its primary. A future adapter reading a Postgres replica could still admit a revoked grant or link for the replication lag, and the contract (one connection) wouldn't notice. | Judgement. Suggest one line: "reads see every write acknowledged before them". |
| 7 | LOW | test/auth/contracts.test.js (devAuth) | **devAuth's dev tokens never expire,** so the "expired token" test is skipped for it. Codex rated this MEDIUM as a doc contradiction. **Refuted:** the port only says an expired token gives null, and dev tokens are off unless explicitly enabled. | Noted. |
| 8 | LOW | server/registry/postgres.js:22 (engine, outside this job) | **`postgres.js` (Registry adapter) imports `../store/postgres.js` (Store adapter):** adapter imports adapter. This test only checks auth and admin. It belongs to engine's repo-wide test/architecture.test.js. | Seen while reading. Forward to engine. |
| 9 | LOW | architecture.test.js (rule test) | **One unexplained failure.** Of two back-to-back full `bun test` runs at about 21:46, the second failed `server/auth and server/admin follow the hexagonal import rule`. I didn't capture its message. 3 isolated runs and 6 more full runs all passed. No file under server/ changed after 21:38; one new file appeared in that window, `test/auth/google-live.test.js`, which isn't in this job's diff. | **Unexplained, not reproduced.** The test reads the live tree, so another session editing or creating a file under server/ during a run would fail it. That is a likely cause but unproven. |

**Port classification:** port.js is labelled `port` but also holds `authPort`, an implementation that composes
injected verifiers. That is harmless while it imports nothing; if it ever grows an import, "core" is the honest class.

## Checks

### Behaviour unchanged: confirmed

- **Exports:** server/auth/registry.js exports `RegistryError`, `memoryRegistry` and `mint`, the same names as at HEAD.
  - registry.js now imports `mint`/`RegistryError` from registry-port.js and no longer defines them. They are the
    same objects (`===` true), and the `memoryRegistry` body is byte-identical to HEAD.
  - The only other runtime import changes are sqlite.js:18 and postgres.js:20, which now point at the port. Every
    other diff line is a comment or a JSDoc type.
- **main.js and test/server untouched (an inference):** both are untracked, so there is no git diff, only file
  modification times.
  - main.js was last modified at 18:52, and test/server/rig.js and outbound.test.js at 21:09 and 21:12.
  - The p5-hex brief was last written at 21:24, and the builder's earliest edit is at 21:28.
  - main.js's auth imports (port.js, dev.js, tenancy.js) still resolve.
- **Full `bun test` on the final tree: 366 pass, 70 skip, 0 fail** (436 tests across 26 files), in 8 of 9 full
  runs. The exception is finding 9. The skips are Postgres, NATS and S3 suites with no service here.

### The amendment (sqlite.js:32 and the KNOWN list): confirmed on the current tree

- **sqlite.js against HEAD is exactly two lines:** :18 (the runtime import) and :32 (the JSDoc type), both moved to
  `../auth/registry-port.js`.
- **The KNOWN list (the test's allowlist of excused violations) is gone.** `grep KNOWN` finds nothing.
  architecture.test.js: 9 pass.
- **Reverting :32 on a scratch copy fails the test** (8 pass, 1 fail) with
  `server/registry/sqlite.js -> server/auth/registry.js [type]: only a composition root may import adapter`.

### Import rule and classification

- **Every import in scope matches its class.**
  - **Adapters** import only util.js (core) and the two port modules.
  - **http.js** imports util.js and admin/boards.js.
  - **Core files** import only util.js and port types.
  - **registry-port.js** imports util.js (`randomId`). A port depending on pure core helpers is fine.
- **Inbound:** only main.js imports auth adapters. sqlite.js and postgres.js import only registry-port.js and
  util.js from auth.
- **Caught on purpose (probed):** dynamic `import()`, `..` paths, JSDoc types including continuation lines, an
  extensionless target, an unclassified new file, and a core file reaching an adapter through a port that re-exports
  it (the port's re-export is flagged).
- **Missed:** findings 1, 3 and 4.

### Contract tests

- **The Verifier contract catches a real break.** Probe: a verifier that never checks the MAC (it accepts any
  signature) failed "a tampered token gives null" (4 pass, 1 fail). The other checks (garbage, exact Identity keys,
  expiry) were confirmed by reading.
- **The IdP contract is port semantics, not Google quirks:** URL protocol, state and nonce length, the exact Identity
  keys, outage gives null.
  - **Its gaps** are finding 2.
  - **googleOidc's own PKCE is covered elsewhere.** test/auth/oidc.test.js:117 to :125 and http.test.js:83 and :98
    check the `code_challenge` (S256) and that `code_verifier` is sent (oidc.js:226).
  - **Single use is the IdP's job by design** (idp-port.js:21): the real Google enforces it, and http.js refuses a
    replayed login cookie.
  - The gap therefore matters for the *next* adapter, not for googleOidc.
- **Not tested, as the builder said:** "Registry infrastructure failure rejects, never null".
  - By reading, postgres.js:113 to :116 rethrows anything that isn't the unique-domain race.
  - The gateway's 10 s hello timeout (gateway.js:30) bounds a hanging Registry.

## Systems design skill (`distributed-systems-design`, CHECKER mode, on the three ports)

Applied: SKILL.md §3, the references/checklists.md universal review (Reliability, Data Management, Security,
Operations), chapter 1's DESIGN REVIEW CRITERIA (stateless tier, failover) and chapter 7's (unique IDs).

| Check | Result |
|---|---|
| Stateless web tier (ch. 1) | **Pass.** Verifier: signed token, no shared session store. IdP: login state in a signed cookie, so `/auth/callback` works on any node. The trade-off (no revocation before `exp`, 12 h) is written in session.js. |
| Unique IDs (ch. 7) | **Pass; the Snowflake criteria don't apply.** `mint` uses `crypto.getRandomValues` with rejection sampling (no modulo bias). Tenant ids carry about 62 bits, boards about 83, links about 134. That needs no coordination and has no clock dependency. The ids are not time-sortable; adapters order rows by an explicit insertion column instead. postgres.js mints through a `fresh()` helper that checks for collisions. |
| Graceful degradation, retry with limits | **Pass.** IdP outage: a failed sign-in the person retries (bounded by `AbortSignal.timeout`). Registry failure: rejects, and the gateway answers `unavailable`. Verifier: no dependency. |
| Consistency model | **Gap, finding 6.** The Registry port doesn't state read-after-write. |
| Input validation | **Pass.** Garbage tests on both contracts. |
| Monitoring | **Gap (a decision, already raised by the builder).** IdP outage-as-null means http.js can't count a Google outage separately from a refused sign-in. |
| Rate limiting | Out of this job's scope (`/auth/login`, `/auth/callback`); not checked. |
| No single point of failure; 10x load | Nothing new: `verify` is one HMAC with no I/O; sign-in is rare. |

## Ensemble review

| Harness | Outcome |
|---|---|
| codex (high effort) | 6 findings. Confirmed: PKCE and single use (= finding 2), the `import /* */ (` bypass (in 3), `.mjs`/`.ts` (4), `finish(null)` (5). Refuted: dev-token expiry as a contradiction (7). |
| grok | "No defects." It wrongly says the IdP contract covers single-use codes; my probe refutes that. Not relied on. |
| agy | Failed: quota exhausted (429, resets in about 65 h). |
| kimi, mistral | Failed check_adapter (not logged in; no API key). qwen is not installed. |

**No HIGH candidate arose.** The brief's rule needs two harnesses to agree. Only codex and grok returned, and they
disagree. Finding 2 is MEDIUM on its own merits: codex and my probe agree, and the reasons it isn't HIGH are in
"Contract tests". Finding 1 is mine alone, confirmed on the real test.

## Suggested fixes (for the builder; not made)

1. **Finding 1:** at architecture.test.js:52, change the position passed to `onComment` to
   `m.index + m[0].search(/\b(import|export)\b/) + 1`, and add a synthetic case for an `export … from` directly below
   a `//` line.
   - **Tested on a scratch copy:** it flags the tenancy.js re-export above, still ignores a commented-out
     `// export { x } from "./oidc.js";`, and the existing synthetic tests pass.
2. **Finding 2:** add two IdP contract tests:
   - the same code finished twice gives null the second time;
   - a code finished with the right state and nonce but a wrong `expected.verifier` gives null.

   For googleOidc to pass them, test/auth/fake-idp.js's token endpoint must check `code_verifier` against the
   challenge and delete used codes. Untested.
3. **Findings 3 and 4:** add `require(` to the dynamic pattern and scan `.mjs`/`.ts`, or list these as known limits
   in the test header.
4. **Finding 5:** default `finish`'s argument (`= {}`) in both adapters, and add `finish(null)` /
   `finish(undefined)` to the garbage test.
5. **Finding 6:** one line in registry-port.js on read-after-write.

# Re-check (fix round, 2026-11-11)

**PASS.** Every item in the fix round is fixed as claimed, and nothing regressed. I changed nothing in the tree;
probes ran on a fresh scratch copy (tree3).

| Item | Probe | Result |
|---|---|---|
| MEDIUM 1: `export … from` under a comment | **On the real test:** appended `// Convenience re-export for callers.` plus `export { googleOidc } from "./oidc.js";` to tenancy.js | **Fixed.** Fails (10 pass, 1 fail) with `server/auth/tenancy.js -> server/auth/oidc.js [runtime]: core imports adapter`. |
| | `/** doc */` then `export * from "./oidc.js"` in util.js | **Fixed.** Fails with `util.js -> oidc.js [runtime]: core imports adapter`. |
| | Controls: a commented-out `// export … from`, a commented-out `require(`, and a string literal `"./oidc.js"` | **Still ignored** (11 pass). |
| MEDIUM 2: IdP contract | My two broken in-memory adapters from the first check, unchanged | **Fixed.** Each fails its own test. The adapter with no PKCE check fails "a code from another sign-in with the SAME nonce is refused". The adapter whose code can be redeemed twice fails "a code works once". |
| LOW 3: cheap forms | The first check's synthetic checker cases, rerun against the new `importsOf` | **Fixed:** `require()`, template-literal `import()` and no-space `import{…}from`. **Still missed, as the fix round says:** `import.meta.resolve` and an apostrophe inside a comment in a multi-line import. Both are now listed as known limits in the test header (architecture.test.js:47). |
| LOW 5: `finish` on garbage | `finish(null | undefined | 42 | "x" | [])` on googleOidc and fakeIdpAdapter | **Fixed.** All resolve null, none throw. The only runtime change in oidc.js is the argument guard in `finish`. |
| LOW 6: consistency | registry-port.js:15 | **Fixed.** Read-your-writes is now stated. |

**No regression.**
- **Full `bun test`, two runs:** 376 pass, 78 skip, 0 fail each time (454 tests across 27 files).
  - The 27th file is test/auth/google-live.test.js, which is not this job's.
  - The 8 extra skips are presumably that file's live-Google tests. I didn't check.
- **Architecture test on a clean copy:** 11 pass.
- **sqlite.js** still differs from HEAD only at :18 and :32.
- **No failing tests.** LOW 9 (the one-off architecture-test failure) did not recur.

**Still open, by decision:** LOW 4 (only `.js` scanned), LOW 7 (dev tokens never expire), LOW 8 (engine:
postgres.js imports a Store adapter) and LOW 9 (unexplained, not reproduced).

**Ensemble review not rerun:** this was a narrow re-check, per the manager.

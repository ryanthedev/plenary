**PASS.** No HIGH findings. The p5-fix diff does what its brief says and matches committed PROTOCOL.md (7e834d2)
on every point the manager listed. There are two MEDIUM findings, both small, and both in code that was there
before this job: `createBoard` doesn't report the board id when the owner grant fails, and the code and spec word
the gmail `email_verified` rule differently. Neither blocks the commit. Not committed.

# Report: p5-fixv (verify p5-fix: auth port errors, authoritative email, last-owner in the Registry)

2026-11-11. Verifier for `manager platform` (t14q).

## Findings

### HIGH

None. No auth bypass. No refusal turned into a throw on wire input, and no outage swallowed as null. The last owner
can't be removed. This job breaks no test.

### MEDIUM

1. **`createBoard` can leave an ownerless board without reporting its id** (`server/admin/boards.js:57-58`).
   This was already in the code before p5-fix, but the manager asked that any mismatch with the committed spec be
   a finding. PROTOCOL.md § Registry (7e834d2) says: "If the second [call] fails, the endpoint must retry it or
   report the failure with the board id; it must not report success for a board with no owner."
   - **What happens today:** if `registry.setGrant(board.id, caller.user, "owner")` throws, for example during a
     Registry outage, the error propagates without the board id. The board stays behind with no owner.
   - **Mitigation:** it is never reported as a success, so the rule is half met. Only an infrastructure failure
     can trigger it.
   - **Fix (platform, p3 HTTP wiring or a small follow-up):** catch the error and rethrow it with `board.id`
     attached, or retry once.
2. **Gmail email: the code is stricter than the spec** (`server/auth/oidc.js:128-131` vs PROTOCOL.md § Tenancy,
   line 408).
   - **Spec:** "it ends in `@gmail.com`, **or** the ID token has `email_verified` true and an `hd` …" So a gmail
     address needs no `email_verified`.
   - **Code:** it requires `email_verified === true` in every case, gmail included. The report says so, and the
     code comment says "required in every case".
   - **Impact:** none in practice, because Google sends `email_verified: true` for gmail accounts. The stricter
     reading is also the safer one. But the code and the spec disagree.
   - **Not from this job:** the `email_verified !== true` guard is an unchanged line in the diff. It also departs
     from the wording of the p5-fix brief's item 2. A probe confirms `x@gmail.com` with `email_verified: false`
     gives no email.
   - **Fix:** change the spec. One clause in § Tenancy: "`email_verified` true and (ends in `@gmail.com`, or `hd`
     equals the email's domain)". Change the code instead only if the CEO wants the looser rule.

### LOW

1. **A malformed dev-token entry now answers `unavailable` instead of `auth`** (`server/auth/dev.js:23`; codex's
   finding, confirmed).
   - **How it happens:** `devAuth({ enabled: true, tokens: { tok: { name: "x", email: 42 } } })`, then
     `verify("tok")`, throws `t.email.toLowerCase is not a function`. Before p5-fix, authPort caught that and
     returned null; now it propagates.
   - **Why LOW and not HIGH:** the brief grades "a refusal turned into a throw" as HIGH, and this was null
     before and throws now. But the token matched a configured entry. The fault is in the operator's config
     (`PLENARY_DEV_TOKENS`, which `server/main.js:36,44` JSON-parses and passes to `devAuth` without checking
     types), not in wire input. No client-chosen token reaches it.
   - **Fix:** `devAuth` should check that `email` and `domain` are strings at config time, the way it already
     checks `name`.
2. **The committed spec doesn't name the `last-owner` error code.** § Registry says the refused call "fails and
   changes nothing". The contract and both adapters pin `err.code === "last-owner"`. This is the builder's own
   hand-off: the engine should add the code to § Registry.
3. **The admin pre-check for the last owner is redundant** (builder risk 4). This is confirmed harmless: the
   Registry decides races, and the admin layer maps the Registry's `last-owner` to `AdminError("last-owner")`.
   Keeping both is fine.

## The committed spec (7e834d2) against the code

| Rule (PROTOCOL.md 7e834d2) | Code | Verdict |
|---|---|---|
| § Auth: null = `auth`, a throw = `unavailable`; `Registry.board` splits the same way | `port.js` catches nothing. `server/gateway.js:128,138,140` wraps verify, board and role in try/catch and answers `unavailable` with close 1013. `null` and a missing role answer `auth`. | Match |
| § Tenancy: tenants are created by an operator; a sign-in never creates one | The only `createTenant` call outside the adapters is `server/main.js:49` (the dev tenant, `domain: null`). oidc and tenancy create nothing. | Match |
| § Tenancy: everyone signs in with Google; no anonymous guests | `verify` accepts only session tokens (issued after sign-in) or configured dev tokens. A non-string or empty token gives null. | Match |
| § Tenancy: authoritative email (`hd` equals the email's domain, or `@gmail.com`) | `oidc.js:127-132`. `hd` is trimmed and lower-cased (`:174`), and so is the email. Exact domain compare. | Match, except the stricter gmail case (MEDIUM 2) |
| § Known limits: a secondary Workspace domain can't claim invites | `x@other.com` with `hd: acme.com` gives no email but keeps `domain: acme.com` (test "p5-fix 2") | Match |
| § Tenancy: only tenant admins grant `owner` (admin layer, not the Registry) | `boards.js:68-71`: a non-admin asking for `owner` gets `forbidden`. The Registry has no caller rule. | Match |
| § Registry: `setGrant` enforces the last owner atomically, and a refused call changes nothing | memory: `registry.js:103-107`, check and write with no await between them. sqlite (engine's): one IMMEDIATE transaction. | Match |
| § Registry: `POST /boards` = createBoard, then setGrant owner, retried or reported with the board id | `boards.js:57-58` neither retries nor reports the id | Mismatch (MEDIUM 1, already in the code before this job) |

## How I tried to break it

- **Red before, green after (checked):** I ran the live `test/auth/` against the pre-fix code (a scratch copy
  with the diff reverse-applied). Exactly 7 tests fail there: all 5 "p5-fix" tests and the contract's 2
  last-owner tests. The other 58 pass. So every new test exercises its fix.
- **Refusals that might now throw:**
  - **Tokens (the builder's test, re-run):** the builder's test sends `verify` undefined, null, `1`, `{}`, `""`, `"junk"`, `"s1.a.b"` and `"s1.!!.??"`, plus
    tampered and expired tokens (port.test.js). All give null. I re-ran it.
  - **Why the session verifier is safe:** it catches its own decode, HMAC and JSON errors (`session.js:30-37`),
    and its payload is signed, so its fields aren't attacker-controlled.
  - **`tenancy.role` (my probe):** I sent `{}`, `{user: 1}`, a numeric board, the boards `"__proto__"` and `"constructor"`,
    and a string identity. All give null (scratch probe).
  - **Result:** the only throw I found is the dev-config one (LOW 1).
- **Outages still swallowed:**
  - **`authPort`:** I grepped it and the gateway hello path. Nothing catches except the gateway, which maps every
    throw to `unavailable`.
  - **`session.verify`:** it still turns an internal throw into null (builder risk 2). Its inputs all come from
    the token, so that is bad input. I accept it.
- **Email (my probe, signed by the fake IdP):** every case fails safe, and no bypass was found.

  | Token claims | Email out |
  |---|---|
  | `x@acme.com.` with `hd: acme.com`; `x@acme.com` with `hd: acme.com.` | null |
  | `x@acme.com.` with `hd: acme.com.` (both from Google) | `x@acme.com.` |
  | `x@gmail.com.evil.com`, `x@notgmail.com` | null |
  | `x@GMAIL.COM` | `x@gmail.com` |
  | punycode `x@xn--bcher-kva.example` with `hd: bücher.example` | null |
  | `email_verified: "true"` (a string) | null |
  | `a@b@acme.com` | null |
  | `x@sub.acme.com` with `hd: acme.com` | null |
  | `hd` as an array, or `""` | null (and domain null) |
- **Last owner:**
  - **Direct calls:** a direct `registry.setGrant` on the last owner with null, editor, commenter and viewer is
    refused, and the grants are unchanged.
  - **Allowed moves:** owner to owner is allowed. A non-owner can be added and removed. A board that has no owner
    yet still takes grants.
  - **Concurrency:** pairs, and five owners removed at once, leave exactly one owner. I added a probe of my own:
    10 owners demote or remove themselves at once through admin `setGrant`, with mixed null and viewer. Exactly
    one owner is left.
- **Contract mutants:** I ran 10 deliberately broken adapters through `registryContract`. All 10 were killed:

  | Mutant | Contract tests failed |
  |---|---|
  | No last-owner check | 2 |
  | Check then `await` then write (racy) | 1 |
  | Writes first, then refuses (a refused call changes state) | 2 |
  | Refusal without `code` | 2 |
  | Guards removal only, not demotion | 2 |
  | Stamps `createdAt` with the real clock | 1 |
  | Case-sensitive `invitesFor` | 1 |
  | `setGrant` on an unknown board silently OK | 1 |
  | `revokeLink` deletes instead of marking | 1 |
  | `addLinkUse` not idempotent | 1 |

- **Memory-only assumptions in the contract:** none. It uses public methods, fresh adapters, `err.code` (never a
  class), and `now` only for `createdAt`. The engine already runs it against `sqliteRegistry`
  (`test/server/registry.test.js:18`), with cleanup, so it is proven against a second adapter. That retires the
  builder's "SQL adapter not yet" risk.

## The engine's failing tests (brief: "Engine's failing tests")

**None of them is caused by this job.**

- **The four named failures now pass, with and without the job:** I ran `bun test test/server/gateway.test.js
  -t "bad frames|H1:|M1/M4"` in the live tree and in the pre-fix copy. Both give 6 pass, 0 fail (`:100`, three
  H1 tests at `:415`, `:427` and `:458`, and M1/M4 at `:483`). So they never depended on this job.
- **What fixed "bad frames":** the test's case list now expects the code `version` for a `v: 99` hello
  (`gateway.test.js:124`). That matches the builder's diagnosis, and the engine changed it in p1-seam.
- **Without the job, only the job's own consumer fails:** in a scratch copy with the p5-fix diff reverse-applied
  (by `patch -R`, with the two new test files removed), the full suite runs with these four passing. The only
  failures there come from the engine's new `test/server/registry.test.js`. It imports
  `test/auth/registry-contract.js` (this job's file) and checks that sqlite and memory give the same answers,
  which needs this job's `last-owner` behaviour. So the engine now depends on this job, rather than being broken
  by it.
- **The flaky test is not this job's either:** "clients converge … over real sockets (seed N)" failed once in 10
  runs without the diff and 0 times in 10 runs with it. One full run with the diff also hit it once (seed 2). It
  is a pre-existing engine flake.
- **The gateway and test/server don't expect null on a throw:** `server/gateway.js` catches every throw as
  `unavailable`. `test/server/gateway.test.js:192` asserts exactly that, and `rig.js` uses the real authPort.
- **Current numbers:**
  - **`bun test`:** 242 pass, 0 fail (twice). One other run had 1 fail, the convergence flake. The tree is
    moving under the engine's p1-seam: 205, then 242 tests during this verification.
  - **`bun test test/auth`:** 65 pass, 0 fail.

## The builder's not-verified list and risks

| Item | Verdict |
|---|---|
| Outage not driven through server/gateway.js itself | Covered by the engine's test: `test/server/gateway.test.js:192` drives a throwing port through the real gateway and gets `unavailable`, close 1013. Retired. |
| No SQL adapter yet | Retired: the engine's sqlite adapter runs the contract and passes. |
| No live Google token with a secondary-domain account | Still not verified. It needs a real Workspace account. Fake IdP only. |
| Two same-name dev tokens throw `last-owner` at start (`server/main.js:52`) | Retired: the engine's `main.js:53-60` now builds one grant per user, keeping the highest role. `ROLES` there is highest first (`packages/protocol/envelope.js:5`), so `indexOf <` keeps the higher role. An owner is never demoted at start. |
| `session.verify` turns an internal throw into null | Accepted: its inputs come from the token itself. |
| The contract requires an injected `now` | Holds for sqlite already. A Postgres adapter must honour it (engine note). |
| The admin pre-check is redundant | Harmless (LOW 3). |

## sdd ensemble review

| Harness | Ran? | Result |
|---|---|---|
| codex (`effort: high`) | Yes | One LOW: the dev email type throws. I confirmed it (LOW 1). |
| grok | Yes | Clean: no findings. |
| agy | No | `check_adapter` failed: quota (429, resets in about 69 h). |
| kimi | No | `check_adapter` failed: no model configured (not logged in). |
| mistral | No | `check_adapter` failed: `MISTRAL_API_KEY` missing. |
| qwen | No | Binary not installed. |

- **Agreement:** no two harnesses agreed on a finding, so there was no HIGH candidate.
- **Isolation:** each harness ran in its own scratch copy of the repo, so neither could touch the real tree.

## Not verified

- **Live Google sign-in:** not tested with a secondary-domain or gmail token. The email rules are tested against
  the fake IdP only.
- **Postgres adapter:** none exists yet.
- **Interleaved runs:** I ran the base-vs-diff comparison on a snapshot while the engine was still editing
  `test/server/`. Test counts moved between runs, so I re-ran the full suite on the live tree three times.

## Files

- **Written:** only this report. Scratch work is in the session scratchpad: the mutants, the probes, the base
  copy and the harness copies.

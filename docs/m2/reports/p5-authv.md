**PASS** — no HIGH finding. 7 MEDIUM and 9 LOW findings below; none is an auth bypass, cross-tenant access,
token forgery or existence leak through the job's public functions.

# Report: p5-authv (verify p5-auth: OIDC module + tenancy model)

2026-11-11. Verifier only: nothing was changed outside this report and my scratchpad. Not committed.

**Three things the manager must know first:**

0. **The verdict turns on M1.** The brief's attack list names "an unverified email claiming an invite". A
   consumer Google account whose third-party email Google verified once, and is no longer authoritative for,
   can claim an invite. I graded it MEDIUM because Google does mark the email verified and PROTOCOL.md § Tenancy
   says only "verified email". **If the manager counts "Google not authoritative" as unverified, this job is a
   FAIL.** M1 and M6 both match the written spec, so a fix starts in PROTOCOL.md, not with the builder.
1. **The sdd ensemble requirement was not met.** Only codex passed `check_adapter`. I ran codex twice (two
   models), which is one harness, not two. See "sdd ensemble review". Question at the end.
2. **One codex run graded a finding HIGH** (retired JWKS keys stay trusted). I confirmed the behaviour and
   refute the HIGH grade; it is M2 below, with the reasoning.

## How I checked it

- **Read:** every file in `server/auth/`, `server/admin/`, `test/auth/`, against the working-tree PROTOCOL.md
  § Tenancy, § Auth, § Registry, § Bus.
- **Attack probes:** 366 probes in one script, run against the real modules by absolute import (not the review
  copy): `/private/tmp/claude-501/-Users-r-repos-plenary/7c538e6d-39f5-496e-a6a7-b78a30fb641a/scratchpad/attack/probe.js`
  (plus `kid.js` beside it). Run with `bun probe.js`. They print observations; they are not assertions.
- **Full suite:** `bun test` gives 125 pass, 0 fail across 14 files (run last, after the probes). The count was
  106 when I started; other sessions added tests meanwhile.
- **Tree untouched:** `git status` shows `server/auth/`, `server/admin/` and `test/auth/` still untracked, and
  `diff -rq` shows all three identical to the copy I took before any review ran.
- **Required tests exist:** every test the brief p5-auth.md § Tests lists is present in `test/auth/` (read
  against the list), and no `.rejects` assertion is unawaited (grep).
- **Google's guidance** on when an email is authoritative was read from the live docs, not recalled (M1).
- **Engram** (cross-session memory) was unreachable (DNS resolver error), so no recall was done.

## HIGH

None.

## MEDIUM

**M1. A consumer Google account with a stale third-party email can claim an invite.**
`server/auth/oidc.js:142`, `server/auth/tenancy.js:31`.
- **What happens:** an ID token with `email_verified: true`, no `hd` and `email: cfo@partner.example` yields an
  identity carrying that email, and `role()` returns the invite's role (`editor` in my probe).
- **Why it matters:** Google says it is authoritative for an email only when it ends in `@gmail.com`, or when
  `email_verified` is true **and** `hd` is set. Otherwise "`email_verified` can also be true as Google initially
  verified the user when the Google account was created, however ownership of the third party email account may
  have since changed" (developers.google.com/identity/gsi/web/guides/verify-google-id-token).
- **Attack:** someone who once controlled the address (a former employee of a partner whose domain is not on
  Workspace, or a previous owner of the domain) keeps a Google account bound to it and claims an invite meant
  for the current owner.
- **Why not HIGH:** an explicit invite to that exact address must exist, and Google did verify the address once.
  It is not a general bypass. It is the nearest thing to "a stale email claiming an invite" in this job.
- **Fix options (manager decision):** carry `email` only when Google is authoritative (gmail.com, or `hd` set);
  or bind an invite to the Google `sub` on first redemption.
- **Tests miss it:** the invite tests use hand-built identities, never a no-`hd` token end to end.

**M2. A withdrawn JWKS key stays trusted with no time limit** (codex-sol said HIGH; refuted as HIGH).
`server/auth/oidc.js:86`.
- **Confirmed:** a cached key has no TTL. After the IdP removed key `b`, a `b`-signed token still verified
  7 days later with no JWKS fetch; it was dropped only when an unrelated unknown `kid` forced a refetch.
  Google's `Cache-Control` is ignored.
- **Why not HIGH:** the attacker needs a Google signing private key, which nobody in the brief's threat model
  has. And an ID token reaches `verifyIdToken` only from Google's token endpoint inside `finish()`; an attacker
  cannot hand one in. That changes if `googleOidc().verifyIdToken` is ever exposed (its comment says "a future
  token-exchange endpoint").
- **Fix:** refetch after a maximum age (honour `Cache-Control: max-age`, or about an hour).

**M3. A 200 JWKS response with no usable keys wipes the working cache** (both codex runs agree; confirmed).
`server/auth/oidc.js:67-78`.
- **Confirmed:** after a refetch answered `{}` or `{"keys":[]}`, a previously good key no longer verifies, and
  the 30 s cooldown blocks a retry. A 503, a thrown error or an HTML body keep the old keys (fine).
- **Grade:** availability only (sign-in outage of up to 30 s per bad response), so not HIGH under the brief.
- **Fix:** treat an empty key set as a failed fetch and keep the old map.

**M4. A JWKS fetch that never settles blocks sign-in for good** (codex-sol agrees; confirmed).
`server/auth/oidc.js:59-81`.
- **Confirmed:** with a fetch that never resolves, the first verify stays pending, and so does a verify an hour
  later with the network healthy again: `inflight` is never cleared, and only one fetch is ever made.
  Cached kids still work; anything needing a fetch waits until the process restarts.
- **Not verified:** whether Bun's own `fetch` times out by default. The module sets no timeout on the JWKS or
  token request either way.
- **Fix:** a timeout (`AbortSignal.timeout`) on both fetches.

**M5. `tenancy.role()` does not cap roles; it trusts whatever the Registry holds.**
`server/auth/tenancy.js:30-40`. Defence in depth: all three need a direct Registry write, which the admin
functions refuse.
- **Confirmed:** `memberRole: "owner"` in the Registry makes every Workspace member `owner`; a link stored with
  role `owner` makes its redeemer `owner`; a grant of `"god"` is returned as `"god"` (the stand-in gateway
  accepts any truthy role).
- **Why it matters:** the engine's SQLite/Postgres Registry will be a second writer of these rows.
- **Fix:** in `role()`, ignore unknown roles, cap `memberRole` and invites below `owner`, cap links to
  `LINK_ROLES`.

**M6. A board owner can make anyone an owner, including a user of another tenant, and can strip the creator.**
`server/admin/boards.js:60-65`.
- **Confirmed:** a non-admin owner granted `owner` to a globex.com user on an acme.com board; that outsider then
  created links. The same owner removed the creator's `owner` grant, and an owner can remove their own.
  Invites are capped below `owner`; grants are not.
- **Not a bypass:** it is an explicit grant on that very board (allowed by PROTOCOL.md § Tenancy), the owner
  stays confined to their board (other boards of the same tenant refuse them), and tenant admins keep control.
- **Manager decision:** should only tenant admins grant `owner`, and should the last owner be protected?

**M7. `finish()` leans on the caller for an empty `state` and a missing PKCE verifier.**
`server/auth/oidc.js:177-186`.
- **Confirmed:** `expected.state === ""` with `state: ""` passes the state check; a missing `expected.verifier`
  is sent to Google as the literal string `undefined` (seen in the fake IdP's recorded token request).
- **Reach:** only if phase 3 stores a broken sign-in record (the builder's risk 5 covers storage, not this).
- **Fix:** refuse unless `expected.state`, `.nonce` and `.verifier` are non-empty strings.

## LOW

| # | Where | Finding (all confirmed by probe) |
|---|---|---|
| L1 | `oidc.js:126-130` | A mismatching `azp` is accepted when `aud` is a string or a one-element array (codex-sol said MEDIUM). Only matters if ID tokens are ever accepted from outside `finish()`. |
| L2 | `oidc.js:89` | A legitimately new `kid` is refused for up to 30 s after any refetch (codex-sol said MEDIUM). An attacker cannot trigger refetches today, since ID tokens only come from Google's token endpoint. |
| L3 | `session.js:24,30` | `issue()` can mint a token `verify()` refuses: a name of about 3,000+ characters makes the token exceed the 4,096 cap. `verifyIdToken` passes names up to about 12k. Cap `name` at sign-in. |
| L4 | `util.js:29-36` | Encoding malleability: 3 other final characters of a session MAC, and 15 of an ID-token signature, decode to the same bytes and are accepted. Not forgery; matters only if a token string is ever used as a revocation or cache key. |
| L5 | `oidc.js:68-76` | JWK key size is not checked (a 1024-bit RSA key was imported). Trusts Google. |
| L6 | `oidc.js:132-134` | No sanity check between `iat` and `exp` (`exp < iat` accepted; a 10-year-old `iat` accepted; `nbf` ignored). |
| L7 | `oidc.js:143` | `hd` is lower-cased but not trimmed (`"acme.com "` stays as is). Fails closed: no tenant matches. |
| L8 | `dev.js:9-22` | A dev entry without `name` becomes the shared user `dev:undefined`; a `Map` passed as `tokens` silently yields no tokens; lookup is not constant-time. Dev-only. |
| L9 | `session.js` | The session token is not bound to a deployment: any instance with the same key accepts it. Use a different key per environment. |

## Checked and sound

- **ID tokens:** every `alg` variant refused (`none` in three cases, `HS256`, `RS256 ` with spaces or NUL,
  `RS384`, `PS256`, arrays, objects); HMAC signatures keyed with the public key (SPKI, JWK JSON, modulus)
  refused under both `HS256` and `RS256` headers; attacker keys in `jwk`/`jku`/`x5u` headers ignored; `kid`
  missing, null, empty, `__proto__`, `constructor`, path-like, array or number all refused; ten `iss`
  lookalikes refused; `aud` arrays, nested arrays, objects, prefixes refused; `exp`/`iat` as strings, null,
  booleans or Infinity refused, skew exactly 60 s; nonce type confusion and missing expected nonce refused;
  `hd` as array, object, boolean or empty gives no domain; an `@acme.com` email without `hd` gives no domain;
  `email_verified` as `"true"` or `1` drops the email; `__proto__` smuggling in the payload has no effect;
  oversized and malformed tokens return null and never throw.
- **Session tokens:** tampered payload, empty MAC, MAC truncated to 1–42 characters, extended MAC, prefix and
  whitespace variants all refused; expiry exact; a Google ID token is refused; keys under 32 bytes throw.
  The MAC check uses WebCrypto `verify` (constant-time).
- **Port (`port.js`) matches PROTOCOL.md § Auth:** exactly `verify` and `role`, both return Promises, resolve
  null on every bad input and on a Registry outage, never throw, and made zero `fetch` calls. Dev tokens are
  refused with no config, `enabled: false`, or any non-`true` value of `enabled`. A Google ID token is refused.
- **Cross-tenant:** no route found. Tenant-A members, admins and no-`hd` users get null on tenant-B boards;
  13 domain tricks (case, dot, space, NUL, prefix, subdomain, array, object) get null; a tenant with no domain
  has no members; an A-board link or invite gives nothing on a B board; another tenant's admin is refused on
  every admin function.
- **Invites and links:** revoke and expiry apply on the next `role()` (exact to the millisecond); a revoked or
  expired link cannot be redeemed; an unverified email (null) claims nothing; link roles limited to editor,
  annotator, viewer; invites below owner; `memberRole` can't be owner.
- **Existence leaks:** unknown board and no-role board are identical in `role()` (null), in the stand-in
  gateway (`auth`), and in all ten admin call shapes I tried, including with invalid arguments (same code and
  message, `forbidden` before any `bad-request`). `createBoard` on an unknown tenant equals a known one for a
  non-admin. A manager naming another board's invite or link gets the same answer as for an unknown id, and
  nothing is revoked. Refused calls wrote nothing. **Not measured:** timing (an unknown board returns after one
  Registry read, a known one after three or four); meaningless in memory, worth a look once SQL backs it.
- **Admin:** `createBoard` refused for a member, another tenant's admin, a non-admin board owner, a guest, null,
  and a caller carrying only the right domain. An editor can do nothing. A board owner can't touch another
  board.
- **Ids:** tenant `t-`+12, board `b-`+16, invite `i-`+16, link 26 characters, all `[a-z0-9-]`, no dots or
  wildcards; 20,000 generated ids were unique and evenly spread over 36 characters. The Registry returns
  copies (mutating a returned tenant or board changes nothing).

## sdd ensemble review

- **Harnesses that ran:** codex only, twice: default model at high effort, and `gpt-5.6-sol` at high effort,
  with different prompts, against a scratchpad copy of the job's files (so a harness could not write the tree).
- **Harnesses that did not run:** agy (quota exhausted, HTTP 429, resets in about 69 h); grok (not signed in);
  kimi (no model configured, not signed in); mistral (no `MISTRAL_API_KEY`); qwen (not installed).
- **codex quota:** 6% of the 5-hour window before, checked with `usage`.

| Finding | codex default | codex-sol | My result |
|---|---|---|---|
| Empty 200 JWKS wipes the cache | LOW | MEDIUM | **Confirmed**, M3. Both runs agree, so a HIGH candidate; refuted as HIGH (availability only). |
| Retired keys trusted forever | not raised | HIGH | **Confirmed behaviour, refuted grade**, M2. |
| Stalled JWKS fetch hangs forever | not raised | MEDIUM | **Confirmed**, M4. |
| Mismatching `azp` accepted | not raised | MEDIUM | **Confirmed**, graded L1. |
| New key refused during cooldown | not raised | MEDIUM | **Confirmed**, graded L2. |

Both runs printed `VERDICT: FAIL` (the default run on a single LOW). Both found tenancy, admin, existence-leak
and port behaviour sound, which matches my probes. Neither raised M1, M5, M6 or M7.

## The builder's not-verified list

I found nothing that makes any of the eight worse than described. Two notes:
- **Sign-in state (risk 6 in the brief's list):** the module is stateless, so the same `{state, nonce}` and ID
  token verify twice. Phase 3 must make the stored sign-in record single-use. M7 is the part it did not list.
- **Sessions outlive a Workspace departure:** as described (12 h, `domain` and `email` frozen in the token).

## Not verified

- **Timing leak:** the unknown-board versus no-role timing difference was not measured.
- **Fetch timeout:** whether Bun's `fetch` times out by default (M4).
- **Constant-time MAC compare:** judged by reading (WebCrypto `verify`), not measured.
- **The builder's mutation check:** not re-run.
- **A second harness:** none ran; the ensemble is codex only.
- **Everything the brief puts out of scope:** real Google sign-in, HTTP wiring, persistence.

## Questions for the manager

1. M1: does "Google not authoritative for the email" count as unverified (which makes this a FAIL), and should
   invite matching be restricted to emails Google is authoritative for?
2. M6: may a board owner grant `owner` (including to another tenant's user) and remove the creator?
3. Is a codex-only review acceptable for this job, or should the ensemble be re-run when agy's quota resets
   (about 69 h) or after grok/kimi/mistral are signed in?

---

# Re-check (2026-11-11, after the p5-auth fix round)

**PASS** — all eleven items (M1–M7, L3, L6, L7, L8) are fixed and hold under my probes; no HIGH. The fix
round opened **one new MEDIUM**: last-owner protection can be bypassed by two concurrent calls (R1). Three new
LOW notes (R2–R4).

**The manager should read R1 before accepting:** you asked for "last owner protected", and it holds for calls
made one after another but not for two made at once. I graded it MEDIUM, not HIGH, because nobody gains a role
and a tenant admin can restore an owner. If you treat the rule as a hard requirement, send it back.

## How I re-checked

- **Diffed** every job file against the copy I took in round one, and read each changed function.
- **Original probes re-run:** the 366-probe script (365 after dropping one dev entry the new config rule rejects)
  against the real modules. The 103 token and input refusals from round one are unchanged; no existence-leak
  line changed.
- **New probes:** `/private/tmp/claude-501/-Users-r-repos-plenary/7c538e6d-39f5-496e-a6a7-b78a30fb641a/scratchpad/attack/recheck.js`
  (about 190 more, aimed at the fixes and at what they might have opened).
- **Real-network timeout test:** a local Bun server on port 0 (stopped by its own handle; no process was killed)
  that never answers, and one that sends half a body and stalls.
- **Full suite:** `bun test` gives 143 pass, 0 fail across 14 files; `test/auth` alone is 42 pass.
- **codex pass** on the changed files (one run, medium effort, on a scratch copy). Codex-only, as accepted.

## The eleven items

| Item | Result | Evidence |
|---|---|---|
| **M1** stale third-party email | **Fixed** | End to end (ID token, session, port, `role()`): the no-`hd` `cfo@partner.example` account now gets email null and role null. 25 email shapes tried: only verified `@gmail.com` and verified-with-`hd` are carried. Refused: `x@gmail.com.evil.example`, `x@evilgmail.com`, `a@b@gmail.com`, NUL/newline/space before `@gmail.com`, `googlemail.com`, Unicode look-alikes, unverified gmail, and `hd` as `""`, spaces, `0`, `true`, array or object. |
| **M2** withdrawn key | **Fixed, one residual (R2)** | A withdrawn key verifies at 59 min 59 s and is refused at 1 h 1 s. `max-age` is honoured, floored at 30 s, capped at 1 h. |
| **M3** empty JWKS | **Fixed** | `{keys:[]}`, `{}`, `null`, a set of only unusable keys and an HTML body all leave the good key verifying, both on an unknown-kid refetch and on a stale refetch. |
| **M4** hanging fetch | **Fixed for real `fetch`, one residual (R3)** | Real `fetch` against a server that never answers: refused after 300 ms (the configured timeout). Body stalled halfway: refused after 301 ms. Both recover after the 5 s retry window. Four concurrent callers during a hang all get refused, none stays pending; `inflight` is cleared. |
| **M5** role caps | **Fixed** | Direct Registry writes: `memberRole` owner gives editor; link owner gives editor; link commenter gives viewer; invite owner gives editor; `god`, `Owner`, arrays and numbers give null in every slot. A real `owner` grant still gives owner. |
| **M6** owner rules | **Fixed sequentially; new R1** | A non-admin owner is refused when granting owner (to an outsider, a member or self), stripping or demoting the creator, or using invites or links for owner. They can grant up to editor and step down. Another tenant's admin who is an owner here is held to the same limits. A stepped-down owner can't regain owner or manage. The last owner is protected against an admin and against self, one call at a time. |
| **M7** `finish()` inputs | **Fixed** | Nine broken sign-in records refused (empty state, missing or empty verifier, missing nonce, array or `String`-object state, null record); zero token requests sent; a good record still works. |
| **L3** huge names | **Fixed, one residual (R4)** | An 11,000-character name becomes 200; the session verifies. A cut inside an emoji still round-trips. A worst-case identity gives a 1,778-character token. |
| **L6** `iat`/`exp` | **Fixed** | `exp <= iat` refused; `iat` 24 h + 1 s old refused, 24 h − 1 s accepted; a normal one-hour token accepted. |
| **L7** `hd` whitespace | **Fixed** | Spaces, tabs, newlines and no-break space trimmed; blank gives no domain. A zero-width space or trailing dot is kept, which matches no tenant (fails closed). |
| **L8** dev names | **Fixed** | A missing, empty, spaced, 65-character, numeric or colon-containing name throws at config; a `Map` works; nothing throws when dev is off. |

## New findings

**R1 (MEDIUM). Two concurrent `setGrant` calls remove every owner.** `server/admin/boards.js:73-77`.
- **Confirmed:** with two owners, both stepping down at the same moment (`Promise.all`) are both allowed, and the
  board ends with no owner. The same happens when a tenant admin removes both owners concurrently.
- **Cause:** the owner count is read, then the grant is written, with awaits in between; nothing makes the pair
  atomic.
- **Impact:** an ownerless board. No one gains a role; a tenant admin can still manage it and grant a new owner
  (confirmed). It is the same class as the builder's risk 8 (`createBoard` is two writes).
- **Fix:** it can't be closed in `boards.js` alone once the Registry is SQL. It needs one atomic Registry call
  (for example `setGrant` with an "unless last owner" condition, in a transaction). That changes the Registry
  port, so it starts in PROTOCOL.md § Registry. A per-board in-process lock would cover single node only.
- **codex agrees** (it also graded this MEDIUM).

**R2 (LOW). A stale key is still used for as long as Google's JWKS can't be fetched** (codex said HIGH; refuted
as HIGH). `server/auth/oidc.js:108`.
- **Confirmed:** with the JWKS endpoint answering 503 for 7 days, a cached key still verifies. The builder lists
  this under "Still open" as a choice of availability over withdrawal speed.
- **Why not HIGH:** as for M2, the attacker needs a Google signing private key, and an ID token only reaches the
  verifier from Google's token endpoint. This case additionally needs our JWKS fetches to keep failing.
- **Fix if wanted:** a hard limit (for example 24 h) after which a stale key is refused.

**R3 (LOW). A `fetch` that ignores its abort signal still hangs for good** (codex said MEDIUM).
`server/auth/oidc.js:74`, and the token request in `finish()`.
- **Confirmed:** with an injected fetch that never settles and ignores `signal`, the first verify and one an hour
  later both stay pending, and `finish()` stays pending.
- **Why LOW:** Bun's real `fetch` honours the signal (measured above), and that is what production passes in.
  Only a custom or wrapped fetch that drops `signal` is affected.
- **Fix if wanted:** race the fetch against a timer instead of relying on the signal alone.

**R4 (LOW). Two small leftovers.**
- **Uncapped `hd`:** a 5,000-character `hd` is carried as the domain, which would make a session token over the
  4,096 limit that `verify` refuses. Needs Google to issue such an `hd`, so not realistic. `sessions.issue` also
  doesn't cap `email` (the ID-token path caps it at 320).
- **Dev config error text** includes the first four characters of the dev token. Dev only.

## Still open from round one (not in this round)

L1 (`azp`), L2 (new key refused for up to 30 s after a refetch; re-confirmed), L4, L5, L9: unchanged.

## codex pass

| codex finding | codex grade | My result |
|---|---|---|
| Stale keys trusted after a failed refresh | HIGH | **Confirmed behaviour, refuted grade:** R2, LOW. |
| Concurrent grant changes remove every owner | MEDIUM | **Confirmed:** R1, MEDIUM. |
| A fetch ignoring its signal hangs lookups | MEDIUM | **Confirmed:** R3, LOW (real `fetch` is not affected). |

codex found role caps, email authority, `capTo`, `finish()`, `devAuth` and `sessions.issue` sound, matching my
probes. It printed `VERDICT: FAIL` on the strength of its HIGH.

## Not verified

- **PROTOCOL.md:** § Tenancy still says "a live invite to the user's verified email" and has no owner-grant
  rule or `last-owner` code. The spec was not in the builder's files; it should be brought in line with the
  manager's M1 and M6 decisions.
- **The builder's 42-mutation check:** not re-run.
- **Timing leak** (unknown board versus no-role board): still not measured.
- **Engram:** not retried this round.
- **Out of scope as before:** real Google sign-in, HTTP wiring, persistence.

## Question for the manager

1. R1: accept the concurrent last-owner gap for M2 (a tenant admin can repair it), or add an atomic Registry
   call now, which changes PROTOCOL.md § Registry and the engine's port?

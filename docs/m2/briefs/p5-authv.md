# Brief: p5-authv (verify p5-auth: OIDC module + tenancy model)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p5-authv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad (extra tests go there). Do not commit.

## Goal and done-when (docs/m2/briefs/p5-auth.md: read it in full)

Google OIDC sign-in (authorization code + PKCE S256, ID-token verification against JWKS, `hd` = Workspace
domain), a dev-token verifier, and the tenancy model (tenant = Workspace domain via a registry of server-minted
`[a-z0-9-]` ids; invites and share links with role, expiry, revoke; boards belong to one tenant; cross-tenant
reads refused), implementing the async Auth port of PROTOCOL.md § Auth (working tree): `verify(token) →
{user, name, email, domain} | null`, then `role(identity, board) → role | null`. Plus `createBoard` and invite/link
admin functions against the Registry port (PROTOCOL.md § Registry, working tree). All tested with a fake IdP, no
network, no real credentials. Done when those tests and the full `bun test` pass. Real Google end-to-end, HTTP
wiring and persistence are explicitly out of scope.

## The job's files (all new, untracked)

`git status --short -- server/auth server/admin test/auth`. Read every file. Compare against PROTOCOL.md
§ Auth, § Tenancy, § Registry, § Bus (id rules) in the working tree.

## Try to break it (write attack tests in your scratchpad, run them against the real modules)

- ID tokens: forged signatures, alg confusion (`none`, HS256 with the public key, `RS256 ` variants), `kid`
  tricks (missing, path-like, prototype keys like `__proto__`), `aud`/`azp` arrays, `iss` lookalikes, exp/iat
  edges, nonce replay across sign-ins, oversized/malformed tokens, `hd` spoofing via email or non-string values.
- Session tokens: tamper, truncation, key reuse, timing-safe compare, expiry, accepting a Google ID token or a
  dev token when dev is off.
- Tenancy: any route by which a user of tenant A gets a role on a tenant-B board without an explicit invite/link
  to that board; existence leaks (unknown board vs no role, and admin errors); revoked/expired invite or link
  still working; an unverified email claiming an invite; link role escalation; `memberRole` = owner; id shapes.
- Admin: non-admins creating boards; board owners exceeding their rights; acting on another board's link/invite.
- Does `port.js` match PROTOCOL.md § Auth exactly (async, null not throw, no network in `verify`)?
- `bun test` (full) passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load the `sdd:subagent-driven-development` skill first. Check `usage`, then run an ensemble review of the job's
files (save `git diff --no-index /dev/null <file>` per file, or the file list, to your scratchpad) with codex +
agy + every other harness that passes `check_adapter`, focused on auth security. A finding two harnesses agree on
is a HIGH candidate: confirm or refute it yourself and say which. List which harnesses ran.

## The builder's not-verified list and risks (only these, not its claims)

- Real Google sign-in not run; no HTTP wiring; registry in memory only.
- Sessions outlive a Workspace departure until `exp` (12 h); `domain` frozen in the token.
- Tenant bootstrap (first tenant/admin) has no endpoint or policy.
- Share-link guests must sign in (no anonymous link viewers).
- In-memory registry never prunes link uses or expired invites.
- Sign-in `{state, nonce, verifier}` storage is left to phase 3.
- `role()` swallows registry errors as null, so an outage looks like a refusal (`auth`, not `unavailable`).
- `createBoard` is two writes (board, then owner grant); a crash between leaves no owner.

Grade HIGH: any auth bypass, cross-tenant access, token forgery, existence leak, or failing test. Then stop and
leave the session idle.

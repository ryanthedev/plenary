# Brief: p5-httpv (verify p5-http: sign-in and admin HTTP routes)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p5-httpv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; servers on
port 0, started from a command that records the PID; kill only that PID.

## Goal and done-when (docs/m2/briefs/p5-http.md: read it)

Standalone handlers in server/auth/http.js, `httpRoutes(deps) → async (req, url) => Response | null`, mounted by
engine after its own routes; never answering /health, /ws, /blobs/*, /metrics. Routes: /auth/login (PKCE, state and
nonce in a signed short-lived HttpOnly Secure SameSite=Lax cookie), /auth/callback (code exchange, session token to
a configured post-login URL in the fragment, no open redirect), /auth/logout, POST /boards, invites, links (incl.
GET /links/:id redeem), grants. API routes: `Authorization: Bearer` session token (dev tokens only when a dev
verifier is configured). JSON errors; unknown board == forbidden board; Registry outage → 503; size-capped JSON
bodies, unknown fields refused. createBoard reports the board id if the owner grant fails (PROTOCOL.md § Registry).

## The diff

`git diff -- server/admin` plus untracked server/auth/http.js and test/auth/http.test.js. Read against committed
PROTOCOL.md (§ Auth, § Tenancy, § Registry) and the existing auth modules.

## Try to break it (attack tests in your scratchpad, against the real module; a `Bun.serve` on port 0 is fine)

- Open redirect via any parameter, header (Host, X-Forwarded-*), or the remembered link in the login cookie.
- Login cookie: forge, tamper, replay after use, expiry, cross-login swap (state/nonce from another attempt),
  missing cookie, oversized cookie.
- Token leakage: the token in a query string, a Location header other than the fragment, a log line, an error body.
- Bearer: missing, malformed, expired, a Google ID token, a dev token with dev off, case/whitespace tricks.
- Authorization: non-admin board creation, owner exceeding rights, acting on another tenant's board, existence
  leaks via status codes, timing aside.
- Link redeem: unknown/revoked/expired link, link for another tenant's board, redirect target.
- Bodies: too big, not JSON, wrong content type, unknown fields, prototype keys (`__proto__`, `constructor`).
- Reserved paths return null; a Registry throw becomes 503, not 500.
- `bun test` (full) passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then review the diff with codex + agy + every other
harness passing `check_adapter`, focused on web auth security. Two agreeing = HIGH candidate: confirm or refute.
List which harnesses ran.

## The builder's not-verified list and risks (only these)

- No real Google; no real browser (cookie prefixes, Secure on localhost, SameSite on the callback redirect).
- A Google outage at callback shows as 400 `login-failed`, not 503.
- Never mounted through engine's createServer({ http }); web/ doesn't consume the fragment yet.
- In-memory Registry only.
- Logout is local (stateless tokens valid until exp); replay guard per process; a share link sent by an attacker
  makes the victim redeem it; no prompt/login_hint on /auth/login.

Grade HIGH: any open redirect, token leak, auth bypass, cross-tenant action, existence leak, or failing test.
Then stop and leave the session idle.

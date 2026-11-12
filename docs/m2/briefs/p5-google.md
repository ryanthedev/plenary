# Brief: p5-google (real Google sign-in, scripted up to Google's redirect)

docs/m2/BRIEF-BASE.md applies, including its Architecture line. Manager: `manager platform` (t187). Report:
docs/m2/reports/p5-google.md. Never pkill/killall; kill only PIDs you recorded.

## Goal

The CEO made the real Google OAuth client: a Web client in the Omniping project, redirect URI
`http://localhost:8080/auth/callback`, consent screen External in Testing (only listed test users can sign in).
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are in `/Users/r/repos/plenary/.env` (gitignored, mode 0600).
Prove our sign-in works with that client as far as a script can go, so a human login is the only step left.

## Secrets (hard rules)

- **Never print, log, echo, commit or paste** the client id or secret: not in output, reports, test names, error
  messages, screenshots or scratch files. Refer to them as "the client id" / "the secret". Read them from `.env`
  in the process that needs them (Bun loads `.env` from the cwd automatically; or parse it in-process). No `cat .env`.
- Redact before printing any URL that carries `client_id` (replace the value with `<client-id>`).
- Nothing goes to any service other than Google's own OAuth endpoints, and only what a browser would send.

## Do

1. **A dev harness**, `server/auth/dev-google.js` (or `scripts/`, your call; it is a composition root for a local
   check, not the product server, and must say so at the top): composes `httpRoutes` with `googleOidc` (real
   `fetch`), `sessions` (random key per run), the in-memory Registry and `tenancy`, from env; `Bun.serve` on
   **127.0.0.1:8080** (the redirect URI fixes the port: check it is free first and refuse to start otherwise; record
   the PID). `postLoginUrl` = a tiny page on the same server that shows only "signed in as <email>" (decode the
   session token server-side; never show the token).
2. **Scripted check, up to Google's redirect** (a script or a bun test that is skipped unless `.env` has both keys
   and a flag like `PLENARY_LIVE_GOOGLE=1` is set, so CI and the normal suite never call Google):
   - `GET /auth/login` → 302 to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, our client
     id, `redirect_uri=http://localhost:8080/auth/callback` exactly, `scope` incl. `openid email`, `state`, `nonce`,
     `code_challenge` + `code_challenge_method=S256`; the login cookie is HttpOnly, SameSite=Lax.
   - Follow that URL once with a plain GET (no cookies, no login): Google must answer with its sign-in page, not an
     error (`invalid_client`, `redirect_uri_mismatch`, `unauthorized_client`, a 400). Report status and which
     marker you matched, never the body verbatim if it echoes the client id.
   - Google's discovery and JWKS are reachable and the JWKS parses through our `jwksCache`.
   - `GET /auth/callback` with a bogus code and a valid state → our refusal (Google's token endpoint says
     `invalid_grant`), no crash, no secret in the response or logs.
3. **Hand-off for the human login:** exact steps for the CEO (start command, URL to open, what success looks like,
   that the Google account must be a listed test user, how to stop the harness). Do not do the login yourself.
4. **Systems design skill:** apply `distributed-systems-design` (APPLIER) briefly to the sign-in flow's failure
   behaviour (Google down, JWKS rotation, clock skew, replayed callback); note what is already covered by tests.

## Files you own

The harness file, a live-check test/script under test/auth/ (skipped by default), docs/m2/reports/p5-google.md.
Nothing in server/ outside server/auth/, not main.js (engine's p2-swap mounts httpRoutes there later; a rerun
against the real server is a later job).

## Done when

The scripted checks pass against the real Google endpoints; the normal `bun test` is unaffected (if a full run fails,
name the failing tests: `bun test 2>&1 | grep -E '\(fail\)'`); `git grep` and your report contain neither secret
(check with a script that compares against `.env` values without printing them); the human-login steps are written.
Then stop. Do not commit.

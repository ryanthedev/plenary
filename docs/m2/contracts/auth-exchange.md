# Sign-in code exchange (platform p5-code; from manager platform t187, 2026-11-11)

No long-lived token in any URL (proxy's decision).

1. **Callback:** 302 to `postLoginUrl#code=<code>` (share-link path: the board URL `#code=<code>`; `&link=invalid` /
   `&link=unavailable` unchanged). It also sets an HttpOnly, SameSite=Strict exchange cookie `__Host-plen_xchg` (60 s).
2. **Client:** read `#code`, drop the fragment at once with `history.replaceState`, then
   `POST /auth/exchange` (same origin, `credentials: "same-origin"`, `Content-Type: application/json`,
   body `{"code":"<code>"}`).
3. **Responses:**
   - `200 {token, user, name, email, domain, exp}`: `exp` in seconds since the epoch; cookie cleared; `no-store`.
   - `400 {error:"invalid-code"}`: unknown, expired (> 60 s), used, or not this browser's. One error for all (no oracle).
   - `403 {error:"bad-origin"}`: Origin isn't postLoginUrl's origin.
   - `503 {error:"unavailable"}`.
4. The token then goes in `hello` as today (memory + sessionStorage, never localStorage or a URL).

Platform tells manager client if the shape changes, and the p5-code commit id when it lands.

## Field types (platform t187, from server/auth/idp-port.js and oidc.js)

- `user`: always a non-empty string (`google:<sub>`, or `dev:<name>` for dev tokens).
- `name`: string or null (null if Google sends none; p5-code turns an empty name into null).
- `email`: string or null (null whenever Google isn't authoritative for it: a consumer account not @gmail.com, or a
  Workspace user on a secondary domain). Show it only if present.
- `domain`: string or null: the Workspace `hd` domain; null for any non-Workspace Google account. It says who the
  user IS, not how they got access (an invite or share-link user from a Workspace keeps their own domain).
- `exp`: integer seconds since the epoch.
- Client-only `{error: "network"}` for no answer or a network error: agreed; the server never sends that code.

## Landed (platform p5-code, 3f6b489 on main)

Shape as above; the 200 body types are pinned. The exchange cookie holds a signed payload (opaque to the client).
**One origin:** httpRoutes refuses to start unless postLoginUrl, postLogoutUrl, the board URL base and the callback
share one origin, so web/ and the auth routes are served from the same origin (relative `/auth/exchange` is right).

// @ts-check
// Auth port: trade the single-use sign-in code from the post-login fragment for a session token.
// Imports nothing.
// Contract test: test/web/contracts/auth-contract.js (authContract).
//
// Contract:
//   exchange(code)  A Promise that ALWAYS resolves (never rejects) to exactly one of:
//     { token, user, name, email, domain, exp }   signed in (PROTOCOL.md, "Sign-in code exchange"): token and user are
//                                                  non-empty strings (user `google:<sub>` or `dev:<name>`); name,
//                                                  email and domain are each a string or null (no name from Google;
//                                                  email not authoritative; not a Workspace account); exp integer
//                                                  seconds since the epoch. The UI shows email only if present and
//                                                  gives a null name a fallback.
//     { error }                                    one of AUTH_ERRORS:
//       "invalid-code"  unknown, expired (> 60 s), already used, or not this browser's (the server gives one answer
//                       for all, so there is no oracle). Also any code that is not a non-empty string. Final:
//                       the code is spent; send the user to sign in again.
//       "bad-origin"    the request's Origin is not the post-login origin. Final (a deployment error).
//       "unavailable"   the server said 503, or answered something that is not this shape. The code may still be
//                       good for its 60 s, so ONE retry after a JITTERED wait (clock.random, e.g. 0.5–2 s) is
//                       reasonable: at 100k joins in 2 min a 503 wave must not retry in lockstep. Never a loop.
//       "network"       no answer at all (offline, DNS, a dropped connection). Client-only (agreed with platform; the
//                       server never sends it). Same as unavailable for retry.
//   The token is a secret: an adapter never logs it (nor the code) and never puts it in a URL. The caller keeps it in memory and
//   sessionStorage (never localStorage), as web/core/signin.js does.
//
// Failure behaviour: every failure is a value, so the sign-in path has one branch per outcome and no try/catch.

/** Every `error` value exchange() can resolve with. */
export const AUTH_ERRORS = Object.freeze(["invalid-code", "bad-origin", "unavailable", "network"]);

/**
 * @typedef {{ token: string, user: string, name: string | null, email: string | null, domain: string | null, exp: number }} AuthSession
 * @typedef {{ error: "invalid-code" | "bad-origin" | "unavailable" | "network" }} AuthFailure
 * @typedef {object} Auth
 * @property {(code: string) => Promise<AuthSession | AuthFailure>} exchange
 */

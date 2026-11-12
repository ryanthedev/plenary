// Sign-in core: who this tab is and the token its hello carries (docs/m2/contracts/auth-exchange.md). Core code:
// it imports only ports (the auth port's error list) and touches no globals; the composition root passes the
// fragment, a function that drops it from the address bar (history.replaceState), the session-storage adapter
// (never localStorage), the auth adapter and the clock. Replaces web/ui/token.js's job (p6-hex wires it).
//
//   takeSignIn(...)    on page load: the fragment's #code → POST /auth/exchange → token, kept in storage; else the
//                      stored token; plus the share-link outcome (&link=invalid|unavailable).
//   devSignIn(...)     the dev path: ?as=<name> → token "dev-<name>" (the server decides whether it accepts it).
//   readStored(...)    the stored session, if well formed and not expired (else dropped).
//   signOut(storage)   forget the stored session.
//
// Everything in the fragment is hostile until checked: over MAX_FRAGMENT it is not parsed, `code=` must appear
// exactly once and be 1–256 base64url characters (the server mints 43), and anything else is rejected BEFORE any
// request. The identity is display-only (the room decides the real user and role on every hello): name and email
// may be null. Nothing here logs (the code and the token are secrets).

import { AUTH_ERRORS } from "../ports/auth.js";

export const SESSION_KEY = "plenary.session";
export const MAX_FRAGMENT = 2048;
const CODE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const DEV_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LINKS = ["invalid", "unavailable"];
const RETRYABLE = ["unavailable", "network"];
/** The jittered wait before the one retry: 500 ms + up to 1500 ms (clock.random), so a 503 wave does not retry in lockstep. */
export const RETRY_MIN_MS = 500, RETRY_SPREAD_MS = 1500;
const TOKEN_MAX = 8192;

/**
 * @typedef {{ user: string, name: string | null, email: string | null, domain: string | null }} Identity
 * @typedef {"signed-in" | "restored" | "none" | "bad-fragment" | "invalid-code" | "bad-origin" | "unavailable" | "network"} Outcome
 * @typedef {{ token: string | null, identity: Identity | null, exp: number | null, outcome: Outcome,
 *             link: "invalid" | "unavailable" | null }} SignIn
 */

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** The hard part of a session: a plain token (no control characters, no spaces), a user, an integer exp. */
function validSession(s) {
  return !!s && typeof s === "object" && str(s.token, TOKEN_MAX) && !/\s/.test(s.token) && str(s.user, 256) &&
    Number.isInteger(s.exp) && s.exp > 0;
}
/** Display-only fields never gate sign-in: one that is empty, too long or has control characters becomes null. */
const display = v => (str(v, 512) ? v : null);
const clean = s => ({ token: s.token, user: s.user, name: display(s.name), email: display(s.email), domain: display(s.domain), exp: s.exp });
const live = (s, clock) => s.exp * 1000 > clock.now();
/** An adapter's answer as a session or one of AUTH_ERRORS; anything else (a malformed session, an unknown error)
 *  counts as "unavailable", the port's word for "answered something not this shape". A fresh session is NOT checked
 *  against this browser's clock: the server just issued it, and a browser clock running ahead must not refuse it
 *  (the stored copy is checked on read-back, so a reload with a wrong clock drops it). */
const normalize = r => {
  // A session-shaped answer that fails the hard checks came from the server, which has spent the code by now:
  // "unavailable" but FINAL (a retry could only give invalid-code).
  if (r && typeof r === "object" && !("error" in r)) return validSession(r) ? clean(r) : { error: "unavailable", final: true };
  return r && AUTH_ERRORS.includes(r.error) ? r : { error: "unavailable" };
};
const identityOf = s => ({ user: s.user, name: s.name, email: s.email, domain: s.domain });

/**
 * Split a fragment ("#a=1&b=2" or "a=1&b=2") into raw key → raw values. No decoding: every value we accept is
 * base64url or a fixed word, so an escaped value is simply not accepted.
 * @returns {Map<string, string[]> | null}  null when the fragment is too long to look at.
 */
function parseFragment(fragment) {
  if (typeof fragment !== "string") return new Map();
  const f = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (f.length > MAX_FRAGMENT) return null;
  const out = new Map();
  for (const part of f.split("&")) {
    if (part === "") continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? "" : part.slice(i + 1);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(v);
  }
  return out;
}

/**
 * The stored session, if well formed and unexpired; a malformed or expired one is removed. A store that cannot be
 * read (STORAGE_UNAVAILABLE) gives null without removing anything: "could not read" is not "signed out".
 * @param {{ storage: import("../ports/storage.js").Storage, clock: import("../ports/clock.js").Clock }} o
 * @returns {{ token: string, identity: Identity, exp: number } | null}
 */
export function readStored({ storage, clock }) {
  let raw;
  try { raw = storage.get(SESSION_KEY); } catch { return null; }
  if (raw === null) return null;
  let s = null;
  try { s = JSON.parse(raw); } catch {}
  if (!validSession(s) || !live(s, clock)) {
    try { storage.remove(SESSION_KEY); } catch {}
    return null;
  }
  s = clean(s);
  return { token: s.token, identity: identityOf(s), exp: s.exp };
}

/** Forget the stored session (sign out, or the room refused the token for good). Never throws. */
export function signOut(storage) { try { storage.remove(SESSION_KEY); } catch {} }

/**
 * The dev path: `?as=<name>` signs in as dev user <name> with the token "dev-<name>" (the server accepts it only
 * when its dev auth is on). Returns null unless `as` appears exactly once, is a plain name, and (when `allowed` is
 * given) is one of them. Nothing is stored.
 * @param {{ query?: string, allowed?: Iterable<string> | null }} o  query: location.search ("?as=ada&x=1").
 * @returns {{ token: string, identity: Identity, exp: null, outcome: "dev", link: null } | null}
 */
export function devSignIn({ query = "", allowed = null }) {
  if (typeof query !== "string" || query.length > MAX_FRAGMENT) return null;
  const q = query.startsWith("?") ? query.slice(1) : query;
  const as = q.split("&").filter(p => p === "as" || p.startsWith("as=")).map(p => p.slice(3));
  if (as.length !== 1 || !DEV_RE.test(as[0])) return null;
  if (allowed && ![...allowed].includes(as[0])) return null;
  return { token: `dev-${as[0]}`, identity: { user: `dev:${as[0]}`, name: as[0], email: null, domain: null }, exp: null, outcome: "dev", link: null };
}

/**
 * On page load. Drops the fragment at once (whatever it held, before anything else), then: a well-formed #code is
 * exchanged once via the auth port, with ONE retry after a jittered clock wait on "unavailable"/"network" (never
 * on "invalid-code"/"bad-origin"); a session is kept in the storage port (the root passes session storage; a store
 * that fails is survived: the token is still returned, kept in memory only). Without a code, or when the exchange
 * fails, the stored session (if any, unexpired) is returned, and `outcome` says what happened to the fragment.
 *
 * outcome: "signed-in" (exchanged now) · "restored" (stored session, no code) · "none" (neither) · "bad-fragment"
 * (rejected before any request) · or the exchange's final error ("invalid-code", "bad-origin", "unavailable",
 * "network"). link: the share-link outcome from the fragment (exactly one `link=` of a known value), else null.
 *
 * @param {{ fragment: string, replaceFragment: () => void, storage: import("../ports/storage.js").Storage,
 *           auth: import("../ports/auth.js").Auth, clock: import("../ports/clock.js").Clock }} o
 * @returns {Promise<SignIn>}
 */
export async function takeSignIn({ fragment, replaceFragment, storage, auth, clock }) {
  // Off the address bar first, before anything can copy it (history, a bookmark, a screenshot, a referrer).
  try { replaceFragment(); } catch {}

  const params = parseFragment(fragment);
  let link = null, code = null, outcome = null;
  if (params === null) outcome = "bad-fragment";
  else {
    const links = params.get("link") ?? [];
    if (links.length === 1 && LINKS.includes(links[0])) link = links[0];
    const codes = params.get("code") ?? [];
    if (codes.length === 1 && CODE_RE.test(codes[0])) code = codes[0];
    else if (codes.length > 0) outcome = "bad-fragment";
  }

  if (code !== null) {
    let r = normalize(await auth.exchange(code));
    if (RETRYABLE.includes(r.error) && !r.final) {
      await new Promise(resolve => clock.set(resolve, RETRY_MIN_MS + Math.floor(clock.random() * RETRY_SPREAD_MS)));
      r = normalize(await auth.exchange(code));
    }
    if (!r.error) {
      const s = { token: r.token, user: r.user, name: r.name, email: r.email, domain: r.domain, exp: r.exp };
      try { storage.set(SESSION_KEY, JSON.stringify(s)); } catch {}   // STORAGE_UNAVAILABLE: carry on in memory
      return { token: s.token, identity: identityOf(s), exp: s.exp, outcome: "signed-in", link };
    }
    outcome = r.error;
  }

  const kept = readStored({ storage, clock });
  return {
    token: kept?.token ?? null, identity: kept?.identity ?? null, exp: kept?.exp ?? null,
    outcome: outcome ?? (kept ? "restored" : "none"), link,
  };
}

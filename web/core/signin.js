// Sign-in core: who this tab is and the token its hello carries. Core code:
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
 * @typedef {"signed-in" | "restored" | "none" | "bad-fragment" | "url-not-cleared" | "invalid-code" | "bad-origin" | "unavailable" | "network"} Outcome
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
  const as = asParam(query);
  if (as === null || (allowed && ![...allowed].includes(as))) return null;
  return { token: `dev-${as}`, identity: { user: `dev:${as}`, name: as, email: null, domain: null }, exp: null, outcome: "dev", link: null };
}

/** The `as` of a query string when it appears exactly once and is a plain name, else null. */
export function asParam(query = "") {
  if (typeof query !== "string" || query.length > MAX_FRAGMENT) return null;
  const q = query.startsWith("?") ? query.slice(1) : query;
  const as = q.split("&").filter(p => p === "as" || p.startsWith("as=")).map(p => p.slice(3));
  return as.length === 1 && DEV_RE.test(as[0]) ? as[0] : null;
}

/** How long a dev sign-in is kept in the tab's storage (a dev convenience: a reload without `?as=` stays signed in). */
export const DEV_SESSION_S = 30 * 24 * 3600;

/**
 * The served page's dev sign-in: `?as=<name>` names a user in the server's dev menu (web/ports/devconfig.js), and the
 * token is that user's own from the menu. Only a menu the server gave counts (null menu: dev sign-in is off, so `?as=`
 * is ignored). The session is kept in this tab's storage like any other. Returns null when there is no menu, no `as`,
 * or the name is not in the menu.
 * @param {{ query: string, menu: import("../ports/devconfig.js").DevMenu | null, storage: import("../ports/storage.js").Storage,
 *           clock: import("../ports/clock.js").Clock }} o
 * @returns {{ token: string, identity: Identity, exp: number, outcome: "dev", link: null } | null}
 */
export function menuSignIn({ query, menu, storage, clock }) {
  const as = menu ? asParam(query) : null;
  const u = as === null ? null : menu.users.find(x => x.name === as);
  if (!u) return null;
  const exp = Math.floor(clock.now() / 1000) + DEV_SESSION_S;
  const identity = { user: `dev:${u.name}`, name: u.name, email: null, domain: null };
  try { storage.set(SESSION_KEY, JSON.stringify({ token: u.token, user: identity.user, name: u.name, email: null, domain: null, exp })); } catch {}
  return { token: u.token, identity, exp, outcome: "dev", link: null };
}

/** The sign-in screen's dev buttons: one link per menu user, each to `board` as that user (a relative `?` href). */
export function devLinks(menu, board) {
  return menu.users.map(u => ({ href: `?${new URLSearchParams({ board, as: u.name })}`, text: `Continue as ${u.name} (${u.role})` }));
}

/**
 * On page load. Drops the fragment at once (whatever it held, before anything else), then: a well-formed #code is
 * exchanged once via the auth port, with ONE retry after a jittered clock wait on "unavailable"/"network" (never
 * on "invalid-code"/"bad-origin"); a session is kept in the storage port (the root passes session storage; a store
 * that fails is survived: the token is still returned, kept in memory only). Without a code, or when the exchange
 * fails, the stored session (if any, unexpired) is returned, and `outcome` says what happened to the fragment.
 *
 * outcome: "signed-in" (exchanged now) · "restored" (stored session, no code) · "none" (neither) · "bad-fragment"
 * (rejected before any request) · "url-not-cleared" (replaceFragment threw: the code is never sent) · or the exchange's final error ("invalid-code", "bad-origin", "unavailable",
 * "network"). link: the share-link outcome from the fragment (exactly one `link=` of a known value), else null.
 *
 * @param {{ fragment: string, replaceFragment: () => void, storage: import("../ports/storage.js").Storage,
 *           auth: import("../ports/auth.js").Auth, clock: import("../ports/clock.js").Clock }} o
 * @returns {Promise<SignIn>}
 */
export async function takeSignIn({ fragment, replaceFragment, storage, auth, clock }) {
  // Off the address bar first, before anything can copy it (history, a bookmark, a screenshot, a referrer).
  // Fail closed (manager decision, p6-hexv): if the fragment could not be dropped, the code is NOT exchanged (it would
  // stay in the URL while it works); outcome "url-not-cleared", and the stored session (if any) is used as usual.
  let cleared = true;
  try { replaceFragment(); } catch { cleared = false; }

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

  if (code !== null && !cleared) { code = null; outcome = "url-not-cleared"; }
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

/**
 * The page's whole sign-in choice (p6-hex; was web/ui/token.js chooseSignIn + app.js). In order:
 *   1. an explicit, known `?as=<name>` (one of devUsers' "dev-<name>" keys) is the dev path: token "dev-<name>". The
 *      fragment is still dropped from the address bar, but nothing in it is exchanged or stored (p6-landv L2);
 *   2. else takeSignIn: a `#code` exchanged now, or the stored session;
 *   3. else dev `fallback` (the in-browser rooms' default user).
 * `dev` names the dev user (null for a real session). `identity` is display-only (p6-landv L5): the room decides the
 * real user and role on every hello. `outcome`/`link` say what happened to the fragment (signInNotice words it).
 * @param {{ query: string, fragment: string, replaceFragment: () => void, storage: import("../ports/storage.js").Storage,
 *           auth: import("../ports/auth.js").Auth, clock: import("../ports/clock.js").Clock,
 *           devUsers: Record<string, object>, fallback?: string }} o
 * @returns {Promise<SignIn & { dev: string | null }>}
 */
export async function pageSignIn({ query, fragment, replaceFragment, storage, auth, clock, devUsers, fallback = "ada" }) {
  const names = Object.keys(devUsers).filter(k => k.startsWith("dev-")).map(k => k.slice(4));
  const dev = devSignIn({ query, allowed: names });
  if (dev) {
    try { replaceFragment(); } catch {}
    const links = parseFragment(fragment)?.get("link") ?? [];
    const link = links.length === 1 && LINKS.includes(links[0]) ? links[0] : null;
    return { ...dev, dev: dev.token.slice(4), link };
  }
  const s = await takeSignIn({ fragment, replaceFragment, storage, auth, clock });
  if (s.token) return { ...s, dev: null };
  return { token: `dev-${fallback}`, identity: null, exp: null, outcome: s.outcome, link: s.link, dev: fallback };
}

/**
 * What to tell the user after sign-in, or null. Never blames the user for a code the network spent (p6-edgev
 * LOW-4: a lost answer then a retry reads as invalid-code), and says when the tab is still someone else (LOW-5).
 * @param {SignIn & { dev?: string | null }} s
 * @param {string | null} [still]  the display name the tab is still signed in as, when an exchange failed
 */
export function signInNotice(s, still = null) {
  const parts = [];
  if (s.link === "invalid") parts.push("That share link is not valid (it may have expired).");
  else if (s.link === "unavailable") parts.push("Share links are unavailable right now. Try the link again later.");
  const failed = {
    "bad-fragment": "That sign-in link wasn't readable.",
    "url-not-cleared": "Sign-in stopped: the sign-in link couldn't be removed from the address bar.",
    "invalid-code": "That sign-in link has expired or was already used.",
    "bad-origin": "Sign-in isn't set up for this address.",
    unavailable: "Sign-in couldn't finish: the server didn't answer.",
    network: "Sign-in couldn't finish: no connection.",
  }[s.outcome];
  if (failed) {
    parts.push(failed);
    parts.push(s.dev === null && s.token && still ? `Still signed in as ${still}.` : "Sign in again.");
  }
  return parts.length ? parts.join(" ") : null;
}

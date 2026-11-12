// The sign-in session token on the page (platform p5-http). After Google sign-in the server sends the browser
// to the post-login URL with `#token=<s1 token>` (and, after a share link, `&link=invalid|unavailable`).
// On load: read it, keep it for the hello (memory, plus sessionStorage so a reload works; never localStorage,
// never in a URL or a log), and clear the fragment at once with history.replaceState, whatever it held.
// Pure (location, history and storage are passed in) so the tests drive it without a browser.
//
// Everything in the fragment is hostile until checked: a fragment over MAX_HASH is not parsed at all, a token
// must have the server's shape (server/auth/session.js: s1.<base64url payload>.<base64url HMAC-SHA256>), and
// `token=` twice means neither is taken. The stored copy is checked the same way when it is read back.

export const TOKEN_KEY = "plenary.session";
const MAX_HASH = 8192;
const TOKEN_RE = /^s1\.[A-Za-z0-9_-]{1,6000}\.[A-Za-z0-9_-]{43}$/;
const LINK = new Set(["invalid", "unavailable"]);

/** True for a string with the session token's shape (not a signature check: the server does that). */
export const validToken = t => typeof t === "string" && t.length <= 6100 && TOKEN_RE.test(t);

/**
 * @param {{ location: { hash: string, pathname: string, search: string }, history: { state: any, replaceState(s: any, t: string, u: string): void },
 *           storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void } | null }} env
 * @returns {{ token: string | null, link: "invalid" | "unavailable" | null, fromHash: boolean }}
 *   token: the fragment's (if valid), else the stored one (if valid), else null. link: the share-link outcome.
 */
export function takeToken({ location, history, storage = null }) {
  const hash = typeof location?.hash === "string" ? location.hash : "";
  let token = null, link = null;
  if (hash.length > 1) {
    // Off the address bar first, before anything can copy it (history, a bookmark, a screenshot).
    try { history.replaceState(history.state, "", location.pathname + location.search); } catch {}
    if (hash.length <= MAX_HASH) {
      let p = null;
      try { p = new URLSearchParams(hash.slice(1)); } catch {}
      const all = p?.getAll("token") ?? [];
      if (all.length === 1 && validToken(all[0])) token = all[0];
      const l = p?.getAll("link") ?? [];
      if (l.length === 1 && LINK.has(l[0])) link = l[0];
    }
  }
  const fromHash = token !== null;
  try {
    if (fromHash) storage?.setItem(TOKEN_KEY, token);
    else {
      const kept = storage?.getItem(TOKEN_KEY) ?? null;
      if (validToken(kept)) token = kept;
      else if (kept !== null) storage.removeItem(TOKEN_KEY);
    }
  } catch {}
  return { token, link, fromHash };
}

/** Forget the stored token (sign out, or the room refused it for good). */
export function dropToken(storage) { try { storage?.removeItem(TOKEN_KEY); } catch {} }

/**
 * Who the token says this is, for display only (the room decides the real user and role on every hello).
 * Unverified, so only short plain strings come out; anything else gives null.
 * @returns {{ user: string, name: string } | null}
 */
export function tokenIdentity(token) {
  if (!validToken(token)) return null;
  try {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "===".slice((b.length + 3) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    const o = JSON.parse(json);
    const str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
    const user = str(o?.u, 128);
    if (!user) return null;
    return { user, name: str(o?.n, 64) ?? user };
  } catch { return null; }
}

/**
 * Who this page signs in as, and the token its hello carries. An explicit, known `?as=` is the dev path
 * (token `dev-<as>`); otherwise the sign-in token, if it passes validToken; otherwise dev `fallback`.
 * @param {{ as?: string | null, token?: string | null, devUsers: Record<string, object>, fallback?: string }} o
 * @returns {{ token: string, dev: string | null }}  dev: the dev user's name, or null for a session token.
 */
export function chooseSignIn({ as = null, token = null, devUsers, fallback = "ada" }) {
  const asked = typeof as === "string" && Object.hasOwn(devUsers, `dev-${as}`) ? as : null;
  if (!asked && validToken(token)) return { token, dev: null };
  const dev = asked ?? fallback;
  return { token: `dev-${dev}`, dev };
}

// DEV HARNESS, NOT THE PRODUCT SERVER (brief p5-google). A composition root for one local check: real Google
// sign-in against your own OAuth client, before the engine's server mounts httpRoutes (p2-swap). Nothing here
// is used by server/main.js; delete it once a rerun against the real server replaces it.
//
//   bun scripts/dev-google.js   serve on http://localhost:8080 (bound to 127.0.0.1); Ctrl-C stops it
//
// Composes httpRoutes + googleOidc (real fetch) + sessions (a random key per run) + the in-memory Registry +
// tenancy, from env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (required), COOKIE_KEY (optional, ≥ 32 bytes; else
// random per run). Bun loads .env from the cwd, so run it from the repo root.
//
// The OAuth client's redirect URI is http://localhost:8080/auth/callback, which fixes the port: the CLI refuses to
// start if anything already answers on 8080 (IPv4 or IPv6), rather than let the browser reach some other server.
//
// Extra routes (dev only):
//   GET /             a "Sign in with Google" link
//   GET /signed-in    postLoginUrl. Its script takes the one-time sign-in code from the URL fragment (`#code=`),
//                     removes it from the address bar, and trades it at POST /auth/exchange (same origin, the
//                     exchange cookie riding along) for the session; the page then shows only "signed in as
//                     <email>". The session token stays in a script variable, never in a URL (brief p5-code).
//   GET /whoami       Bearer session token → { email } (verified and decoded server-side; never echoes the token)
//
// Secrets: the client id and secret are never logged. Logs carry method, path (no query string) and status only.

import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE } from "../server/adapters/driving/auth-http.js";
import { googleOidc } from "../server/adapters/driven/auth/oidc.js";
import { sessions as makeSessions } from "../server/adapters/driven/auth/session.js";
import { memoryRegistry } from "../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy } from "../server/core/auth/tenancy.js";

export const PORT = 8080;
export const ORIGIN = `http://localhost:${PORT}`;
export const REDIRECT_URI = `${ORIGIN}/auth/callback`;

const html = body => new Response(`<!doctype html><meta charset="utf-8"><title>Plenary dev sign-in</title>${body}`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });

const HOME = `<p><a href="/auth/login">Sign in with Google</a></p>`;
const SIGNED_IN = `<p id="who">checking…</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const code = p.get("code");
  history.replaceState(null, "", location.pathname);          // the code leaves the address bar at once
  const who = document.getElementById("who");
  if (!code) who.textContent = "not signed in";
  else fetch("/auth/exchange", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
    .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(r.status + " " + j.error), () => Promise.reject(r.status)))
    .then(s => { who.textContent = "signed in as " + (s.email ?? "(no Google-verified email; user " + s.user + ")"); })
    .catch(s => { who.textContent = "sign-in failed (" + s + ")"; });
</script>`;

/** One structured log line to stderr. */
const defaultLog = rec => console.error(JSON.stringify({ t: new Date().toISOString(), ...rec }));

/**
 * Build and start the harness.
 * @param {{ env?: Record<string, string|undefined>, port?: number, hostname?: string, fetch?: typeof fetch,
 *   log?: (rec: object) => void }} [o]   port 0 = any free port (tests); the redirect URI stays REDIRECT_URI.
 */
export async function startDevGoogle({ env = process.env, port = PORT, hostname = "127.0.0.1", fetch = safeFetch, log = defaultLog } = {}) {
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("dev-google: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (.env)");
  const cookieKey = env.COOKIE_KEY && new TextEncoder().encode(env.COOKIE_KEY).length >= 32
    ? env.COOKIE_KEY : crypto.getRandomValues(new Uint8Array(32));

  const registry = memoryRegistry();
  const sessions = await makeSessions({ key: crypto.getRandomValues(new Uint8Array(32)) });
  const oidc = googleOidc({ clientId, clientSecret, redirectUri: REDIRECT_URI, fetch });
  const routes = httpRoutes({
    registry, sessions, oidc, tenancy: makeTenancy({ registry }),
    log: { warn: (msg, fields) => log({ msg, ...fields }) },          // "sign-in failed" { cause } (p5-googlev LOW 1)
    config: { cookieKey, postLoginUrl: `${ORIGIN}/signed-in`, boardUrl: `${ORIGIN}/b/{board}` },
  });

  async function handle(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return html(HOME);
    if (req.method === "GET" && url.pathname === "/signed-in") return html(SIGNED_IN);
    if (req.method === "GET" && url.pathname === "/whoami") {
      const m = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "");
      const id = m ? await sessions.verify(m[1]) : null;
      if (!id) return Response.json({ error: "auth" }, { status: 401, headers: { "cache-control": "no-store" } });
      return Response.json({ email: id.email ?? `(no Google-verified email; user ${id.user})` }, { headers: { "cache-control": "no-store" } });
    }
    return (await routes(req, url)) ?? Response.json({ error: "not-found" }, { status: 404 });
  }

  const server = Bun.serve({
    port, hostname,
    async fetch(req) {
      let res;
      try { res = await handle(req); } catch { res = Response.json({ error: "unavailable" }, { status: 503 }); }
      const path = new URL(req.url).pathname;
      // On the callback, whether the browser sent the login cookie back (its presence only, never its value): the
      // first thing to check when a real sign-in ends in login-failed.
      // On the exchange, likewise whether the exchange cookie came back.
      const has = name => (req.headers.get("cookie") ?? "").split(";").some(c => c.trim().startsWith(name + "="));
      const extra = path === "/auth/callback" ? { loginCookie: has(LOGIN_COOKIE) }
        : path === "/auth/exchange" ? { exchangeCookie: has(EXCHANGE_COOKIE) } : {};
      log({ msg: "http", method: req.method, path, status: res.status, ...extra });
      return res;
    },
  });
  return { server, oidc, sessions, url: `http://${hostname}:${server.port}`, stop: () => server.stop(true) };
}

/** Signals that stop the harness cleanly (a closed terminal sends SIGHUP). */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
export const FETCH_TIMEOUT_MS = 15000;   // one request, headers and body: a Google that never answers must not hang a sign-in

/**
 * `fetch` that never lets a URL escape in an error. When Bun's fetch throws (offline, DNS, TLS, refused), its error
 * carries the full URL in `path` (and sometimes the message), and test runners print it; an authorization URL holds
 * the client id. This rethrows a fresh Error with only the error code and no `cause`. (p5-googlev MEDIUM 1)
 * It also gives every request its own timeout (a caller's init.signal wins).
 */
export const makeSafeFetch = (timeoutMs) => async (input, init) => {
  try { return await fetch(input, { signal: AbortSignal.timeout(timeoutMs), ...init }); }
  catch (e) {
    const code = typeof e?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code
      : typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error";
    throw new Error("google unreachable: " + code);
  }
};
/** @type {typeof fetch} */
export const safeFetch = makeSafeFetch(FETCH_TIMEOUT_MS);

/**
 * Follow an authorization URL once, as a browser with no cookies would, and classify Google's answer. Google's
 * error pages answer 200 too, so `errors` (markers in the final URL or body) is the verdict, not the status.
 * Returns only origin + path of the final URL, never its query (it carries the client id).
 */
export async function probeAuthorize(url, { fetch = safeFetch } = {}) {
  const g = await fetch(url, { redirect: "follow" });
  // Reading the body can fail after the headers arrived (a reset mid-body); Bun's error may then name the URL, so it
  // gets the same treatment as safeFetch (p5-googlev re-check, new LOW).
  let body;
  try { body = await g.text(); } catch (e) { throw new Error("google unreachable: body " + (typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error")); }
  const f = new URL(g.url);
  return { status: g.status, where: f.origin + f.pathname, path: f.pathname,
    errors: AUTH_ERRORS.filter(m => g.url.includes(m) || body.includes(m)) };
}
export const AUTH_ERRORS = ["redirect_uri_mismatch", "invalid_client", "unauthorized_client", "signin/oauth/error"];

/**
 * True when anything accepts a TCP connection on host:port, HTTP or not (p5-googlev LOW 2: a silent listener on
 * [::1] must stop us too, or the browser's "localhost" may reach it instead of us).
 */
export async function listening(host, port, timeoutMs = 1000) {
  return new Promise(resolve => {
    let done = false;
    const end = (v, sock) => { if (done) return; done = true; clearTimeout(t); try { sock?.end(); } catch {} resolve(v); };
    const t = setTimeout(() => end(false), timeoutMs);
    Bun.connect({ hostname: host, port, socket: { open: s => end(true, s), data() {}, error: () => end(false), close() {}, connectError: () => end(false) } })
      .catch(() => end(false));
  });
}

/** True when port is taken on 127.0.0.1 or ::1. */
export const portBusy = async port => (await listening("127.0.0.1", port)) || (await listening("::1", port));

if (import.meta.main) {
  // DEV_GOOGLE_PORT moves the listening port only (tests; the redirect URI, and so the real sign-in, stays on 8080).
  const listenPort = process.env.DEV_GOOGLE_PORT ? Number(process.env.DEV_GOOGLE_PORT) : PORT;
  if (await portBusy(listenPort)) {
    console.error(`dev-google: something already answers on port ${listenPort}; stop it first (the redirect URI fixes the port)`);
    process.exit(1);
  }
  let h;
  try { h = await startDevGoogle({ port: listenPort }); }
  catch (e) { console.error(String(e.message).startsWith("dev-google:") ? e.message : `dev-google: ${e.message}`); process.exit(1); }   // p5-googlev LOW 3
  console.error(`dev-google: pid ${process.pid}; open ${ORIGIN}/ (Ctrl-C or kill ${process.pid} to stop)`);
  for (const sig of STOP_SIGNALS) process.on(sig, () => { h.stop(); process.exit(0); });
}

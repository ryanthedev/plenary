// Auth adapter: POST /auth/exchange over fetch (docs/m2/contracts/auth-exchange.md). Implements web/ports/auth.js.
// Imports nothing: fetch, the base URL and the timers are injected; the composition root passes globalThis.fetch.
//
// Mapping (on the STATUS, with a JSON body required for 200/400/403):
//   200 + JSON of the session shape      → { token, user, name, email, domain, exp } (exp stays seconds)
//   200 + JSON of any other shape        → { error: "unavailable" }   (the contract's "malformed")
//   200/400/403 + a body that is not JSON → { error: "network" }      (not our server: a captive portal, a proxy or
//                                                                     WAF page; retryable, never a final error)
//   400 + JSON                           → { error: "invalid-code" }  (final; the server gives one answer for all)
//   403 + JSON                           → { error: "bad-origin" }    (final)
//   503, and every other status          → { error: "unavailable" }   (a 502/504 from a load balancer, the route's
//                                                                     503 "sign-in-unavailable", a 404 mid-deploy)
//   fetch throws, or no answer in timeoutMs → { error: "network" }
// A code that is not a non-empty string is invalid-code without a request. exchange() never rejects.
// The code and the token are secrets: nothing here logs, and the code goes only in the JSON body.

const SESSION_KEYS = ["domain", "email", "exp", "name", "token", "user"];
const nullableString = v => v === null || typeof v === "string";

/** @returns {boolean} true for exactly { token, user, name, email, domain, exp } of the contract's types. */
function isSession(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const keys = Object.keys(b).sort();
  if (keys.length !== SESSION_KEYS.length || keys.some((k, i) => k !== SESSION_KEYS[i])) return false;
  return typeof b.token === "string" && b.token.length > 0 && typeof b.user === "string" && b.user.length > 0 &&
    nullableString(b.name) && nullableString(b.email) && nullableString(b.domain) && Number.isInteger(b.exp);
}

/**
 * @param {{ fetch: typeof globalThis.fetch, base?: string, timeoutMs?: number,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 *   fetch: the browser's fetch (required). base: prefix of the path; "" (default) posts to the relative
 *   "/auth/exchange", right because web/ and the auth routes share one origin (p5-code). timeoutMs: abort and
 *   report "network" after this long (default 10 s, so wait + retry stays inside the code's 60 s). timers: the
 *   clock port's set/clear (default the global setTimeout/clearTimeout).
 * @returns {import("../../ports/auth.js").Auth}
 */
export function httpAuth({ fetch, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpAuth: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const url = `${base}/auth/exchange`;

  async function attempt(code, signal) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        cache: "no-store",
        signal,
      });
    } catch { return { error: "network" }; }
    const status = res?.status;
    if (status !== 200 && status !== 400 && status !== 403) return { error: "unavailable" };
    let body;
    try { body = JSON.parse(await res.text()); } catch { return { error: "network" }; }
    // A final answer needs our server's JSON: a proxy's or WAF's HTML 400/403 page is "network" (retryable).
    if (status === 400) return { error: "invalid-code" };
    if (status === 403) return { error: "bad-origin" };
    if (!isSession(body)) return { error: "unavailable" };
    const { token, user, name, email, domain, exp } = body;
    return { token, user, name, email, domain, exp };
  }

  return {
    async exchange(code) {
      if (typeof code !== "string" || code === "") return { error: "invalid-code" };
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      let timer = null;
      const timeout = new Promise(resolve => {
        timer = set(() => { try { ctl?.abort(); } catch {} resolve({ error: "network" }); }, timeoutMs);
      });
      try {
        return await Promise.race([attempt(code, ctl?.signal), timeout]);
      } catch {
        return { error: "network" };
      } finally { clear(timer); }
    },
  };
}

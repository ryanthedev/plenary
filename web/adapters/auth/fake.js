// Auth adapter: an in-memory fake of POST /auth/exchange (docs/m2/contracts/auth-exchange.md) for tests and the
// dev page. Implements web/ports/auth.js. Codes are single use and expire after ttlMs (60 s, as the server).

/**
 * @param {{ now?: () => number, ttlMs?: number, fail?: "bad-origin" | "unavailable" | "network" | "malformed" | null }} [o]
 *   now: the clock (ms; pass a virtual clock's now). fail: every exchange meets this failure (a 403, a 503, no
 *   answer at all, or a 200 that is not the shape, which an adapter reports as "unavailable"), to test callers;
 *   the code is not spent then, as on the server. Field types: auth-exchange.md "Field types" (name, email and
 *   domain may be null; mint passes null through).
 */
export function fakeAuth({ now = () => 0, ttlMs = 60_000, fail = null } = {}) {
  /** @type {Map<string, { session: object, at: number }>} */
  const codes = new Map();
  let n = 0;
  return {
    /** @param {string} code */
    async exchange(code) {
      if (fail) return { error: fail === "malformed" ? "unavailable" : fail };
      if (typeof code !== "string" || code === "") return { error: "invalid-code" };
      const c = codes.get(code);
      codes.delete(code);                                     // single use, even when it had expired
      if (!c || now() - c.at > ttlMs) return { error: "invalid-code" };
      return { ...c.session };
    },
    /** Test hook: what the server's callback does. Returns a fresh single-use code for this session. */
    mint({ token = `s1.fake${++n}.${"A".repeat(43)}`, user = "google:ann", name = "Ann", email = "ann@acme.com",
      domain = "acme.com", exp = Math.floor(now() / 1000) + 3600 } = {}) {
      const code = `c-${++n}-${codes.size}`;
      codes.set(code, { session: { token, user, name, email, domain, exp }, at: now() });
      return code;
    },
    /** Test hook: change the forced failure (null: answer normally). */
    setFail(f) { fail = f; },
  };
}

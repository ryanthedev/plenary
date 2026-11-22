// @ts-check
// Dev menu adapter: GET /auth/dev over fetch. Implements web/ports/devconfig.js. Imports nothing: fetch and the timers
// are injected. The server has this route only while its dev tokens are on (server/auth/http.js); any other answer
// (404 on a production server, a proxy's page, a 5xx, bad JSON, the wrong shape, no answer in time) is null.
//
// The shape is checked here, because the page puts the board in its URL and the tokens in its hello: a board is
// 1-64 of [A-Za-z0-9_-], a name 1-64 of [A-Za-z0-9_.@-], a token a non-empty string without whitespace or control
// characters (at most 8192), a role a short string. At most 100 users; a duplicate name is dropped. Nothing logs.

const BOARD_RE = /^[\w-]{1,64}$/, NAME_RE = /^[A-Za-z0-9_.@-]{1,64}$/, ROLE_RE = /^[a-z]{1,32}$/;
const MAX_USERS = 100;

/**
 * @param {{ fetch: typeof globalThis.fetch, base?: string, timeoutMs?: number,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 * @returns {import("../../ports/devconfig.js").DevConfig}
 */
export function httpDevConfig({ fetch, base = "", timeoutMs = 5_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpDevConfig: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);

  async function ask(signal) {
    const res = await fetch(`${base}/auth/dev`, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
    if (res?.status !== 200) return null;
    const b = JSON.parse(await res.text());
    if (!b || typeof b !== "object" || typeof b.board !== "string" || !BOARD_RE.test(b.board) || !Array.isArray(b.users)) return null;
    const seen = new Set(), users = [];
    for (const u of b.users.slice(0, MAX_USERS)) {
      if (!u || typeof u.name !== "string" || !NAME_RE.test(u.name) || seen.has(u.name)) continue;
      if (typeof u.token !== "string" || !u.token || u.token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(u.token)) continue;
      seen.add(u.name);
      users.push({ name: u.name, token: u.token, role: typeof u.role === "string" && ROLE_RE.test(u.role) ? u.role : "editor" });
    }
    return users.length ? { board: b.board, users } : null;
  }

  return {
    async get() {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      let timer = null;
      const timeout = new Promise(resolve => { timer = set(() => { try { ctl?.abort(); } catch {} resolve(null); }, timeoutMs); });
      try { return await Promise.race([ask(ctl?.signal).catch(() => null), timeout]); }
      finally { clear(timer); }
    },
  };
}

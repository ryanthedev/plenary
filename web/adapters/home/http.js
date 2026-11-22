// Home adapter over fetch: implements web/ports/home.js against GET /home, GET /home/search?q= and PUT/DELETE /home/stars/:board.
// Imports nothing (fetch and timers are injected). The body's shape is checked here, because the page renders it and puts
// ids in links: ids are 1-64 of [A-Za-z0-9_-], strings are capped, lists are capped, anything else is dropped.

const ID_RE = /^[\w-]{1,64}$/;
/** A valid id: a string (a missing field is not the id "undefined"). */
const ID = { test: v => typeof v === "string" && ID_RE.test(v) };
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);

const part = p => (p && typeof p === "object" && ["group", "space", "shared"].includes(p.type) ? { type: p.type, ...(ID.test(p.id) ? { id: p.id } : {}), name: str(p.name) } : null);
const card = c => (c && typeof c === "object" && ID.test(c.id)
  ? { id: c.id, title: str(c.title), role: str(c.role, 32), path: list(c.path, 4, part), starred: c.starred === true, ...(Number.isFinite(c.at) ? { at: c.at } : {}),
    ...(c.can && typeof c.can === "object" ? { can: { rename: c.can.rename === true, move: c.can.move === true, trash: c.can.trash === true } } : {}) } : null);
const node = s => (s && typeof s === "object" && ID.test(s.id) ? { id: s.id, name: str(s.name), personal: s.personal === true } : null);
const tree = t => (t && typeof t === "object" ? {
  groups: list(t.groups, 200, g => (g && ID.test(g.id) ? { id: g.id, name: str(g.name), spaces: list(g.spaces, 200, node) } : null)),
  spaces: list(t.spaces, 200, node),
  more: t.more === true,
} : null);

/** @param {object} b a parsed GET /home body @returns {import("../../ports/home.js").HomeData | null} */
export function normalizeHome(b) {
  if (!b || typeof b !== "object" || typeof b.guest !== "boolean" || !Array.isArray(b.shared)) return null;
  const limits = {};
  for (const [k, v] of Object.entries(b.limits ?? {})) if (Number.isFinite(v)) limits[k.slice(0, 20)] = v;
  return {
    guest: b.guest, user: { user: str(b.user?.user, 80), name: str(b.user?.name, 80) },
    unit: b.unit && typeof b.unit === "object" ? { id: str(b.unit.id, 64), kind: str(b.unit.kind, 20) } : null,
    recent: list(b.recent, 50, card), starred: list(b.starred, 50, card), owned: list(b.owned, 50, card), shared: list(b.shared, 50, card), tree: tree(b.tree), limits, can: { createGroup: b.can?.createGroup === true, manageAccess: b.can?.manageAccess === true, manageRoles: b.can?.manageRoles === true },
  };
}

/**
 * @param {{ fetch: typeof globalThis.fetch, token: string, base?: string, timeoutMs?: number,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 * @returns {import("../../ports/home.js").HomePort}
 */
export function httpHome({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpHome: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);

  /** One request: `{ status, body }`, or `{ error }`. Never throws. */
  async function ask(path, method) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise(resolve => { timer = set(() => { try { ctl?.abort(); } catch {} resolve({ error: "unavailable" }); }, timeoutMs); });
    const run = (async () => {
      let res;
      try { res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store", redirect: "error", signal: ctl?.signal }); }
      catch { return { error: "network" }; }
      if (res?.status === 401) return { error: "auth" };
      if (res?.status === 403) return { error: "forbidden" };
      if (res?.status === 204) return { status: 204, body: null };
      if (res?.status !== 200) return { error: "unavailable" };
      try { return { status: 200, body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }

  return {
    async load() {
      const r = await ask("/home", "GET");
      if (r.error) return r;
      const home = normalizeHome(r.body);
      return home ? { home } : { error: "unavailable" };
    },
    async search(q) {
      const r = await ask(`/home/search?q=${encodeURIComponent(q)}`, "GET");
      if (r.error) return r;
      const b = r.body;
      return b && Array.isArray(b.results) ? { q: str(b.q, 100), results: list(b.results, 50, card), more: b.more === true } : { error: "unavailable" };
    },
    async star(board, on) {
      if (!ID.test(board)) return { error: "forbidden" };
      const r = await ask(`/home/stars/${encodeURIComponent(board)}`, on ? "PUT" : "DELETE");
      return r.error ? r : { ok: true };
    },
  };
}

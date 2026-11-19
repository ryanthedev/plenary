// Share adapter over fetch: implements web/ports/share.js against PROTOCOL.md § Share dialog. Imports nothing (fetch and timers are injected). Bodies are checked here
// because the dialog renders them: ids are 1-64 of [A-Za-z0-9_-], strings and lists are capped, anything else is dropped. A link's id is a capability: it is only ever
// put in a URL the manager copies, never in an error or a log.

const ID_RE = /^[\w-]{1,64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const time = v => (v === null ? null : Number.isFinite(v) ? v : undefined);
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);

const invite = i => (i && typeof i === "object" && isId(i.id) && typeof i.email === "string" && typeof i.role === "string" && time(i.expiresAt) !== undefined
  ? { id: i.id, email: str(i.email, 320), role: str(i.role, 32), expiresAt: i.expiresAt, createdAt: Number.isFinite(i.createdAt) ? i.createdAt : 0, guest: i.guest === true } : null);
const link = l => (l && typeof l === "object" && isId(l.id) && typeof l.role === "string" && time(l.expiresAt) !== undefined
  ? { id: l.id, role: str(l.role, 32), expiresAt: l.expiresAt, createdAt: Number.isFinite(l.createdAt) ? l.createdAt : 0, ...(typeof l.url === "string" && l.url.length <= 400 ? { url: l.url } : {}) } : null);
const roles = v => list(v, 8, r => (typeof r === "string" && r.length <= 32 ? r : null));

/** @returns {import("../../ports/share.js").ShareView | null} */
export function normalizeShareView(b) {
  if (!b || typeof b !== "object" || !isId(b.board?.id) || !Array.isArray(b.invites) || !Array.isArray(b.links)) return null;
  return {
    board: { id: b.board.id, title: str(b.board.title) },
    unit: b.unit && typeof b.unit === "object" ? { domains: list(b.unit.domains, 50, d => (typeof d === "string" && d.length <= 255 ? d.toLowerCase() : null)) } : null,
    limits: { inviteRoles: roles(b.limits?.inviteRoles), linkRoles: roles(b.limits?.linkRoles), inviteTtlMs: Number.isFinite(b.limits?.inviteTtlMs) ? b.limits.inviteTtlMs : 30 * 86_400_000 },
    invites: list(b.invites, 200, invite), links: list(b.links, 200, link), more: b.more === true,
  };
}

/** @returns {import("../../ports/share.js").SharePort} */
export function httpShare({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpShare: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 409: "conflict", 422: "invalid", 429: "limited" };

  /** One request: `{ body }` (a parsed 200/201 body, or null for a 204), or `{ error }`. Never throws. */
  async function ask(path, method = "GET", json, key = null) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise(resolve => { timer = set(() => { try { ctl?.abort(); } catch {} resolve({ error: "unavailable" }); }, timeoutMs); });
    const run = (async () => {
      let res;
      try {
        res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(typeof key === "string" && key ? { "idempotency-key": key } : {}) },
          ...(json !== undefined ? { body: JSON.stringify(json) } : {}), credentials: "omit", cache: "no-store", redirect: "error", signal: ctl?.signal });
      } catch { return { error: "network" }; }
      if (STATUS[res?.status]) return { error: STATUS[res.status] };
      if (res?.status === 204) return { body: null };
      if (res?.status !== 200 && res?.status !== 201) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;
  const put = (o, k, v) => (v !== undefined ? { ...o, [k]: v } : o);

  return {
    async view(board) {
      if (!isId(board)) return { error: "notfound" };
      const r = await ask(`/boards/${q(board)}/share`);
      if (r.error) return r;
      const view = normalizeShareView(r.body);
      return view ? { view } : bad();
    },
    async invite(board, { email, role, expiresAt }, key = null) {
      if (!isId(board)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/invites`, "POST", put({ email, role }, "expiresAt", expiresAt), key);
      if (r.error) return r;
      const x = invite(r.body?.invite);
      return x ? { invite: x } : bad();
    },
    async link(board, { role, expiresAt }, key = null) {
      if (!isId(board)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/links`, "POST", put({ role }, "expiresAt", expiresAt), key);
      if (r.error) return r;
      const x = link(r.body?.link);
      return x ? { link: { ...x, ...(typeof r.body?.url === "string" && r.body.url.length <= 400 ? { url: r.body.url } : {}) } } : bad();
    },
    async revokeInvite(board, id) {
      if (!isId(board) || !isId(id)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/invites/${q(id)}`, "DELETE");
      return r.error ? r : {};
    },
    async revokeLink(board, id) {
      if (!isId(board) || !isId(id)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/links/${q(id)}`, "DELETE");
      return r.error ? r : {};
    },
  };
}

// Trash adapter over fetch: implements web/ports/trash.js against PROTOCOL.md § Trash and restore. Imports nothing (fetch and timers are injected). Bodies are checked here because the page
// renders them: ids are 1-64 of [A-Za-z0-9_-], strings and lists are capped, anything else is dropped. Names and titles are other people's words: the page renders text only.

const ID_RE = /^[\w-]{1,64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const ms = v => (Number.isFinite(v) && v >= 0 ? v : null);
const days = v => (Number.isSafeInteger(v) && v >= 0 && v <= 3650 ? v : null);
const person = p => (p && typeof p === "object" && typeof p.id === "string" && p.id.length <= 200 ? { id: p.id, name: str(p.name) } : null);
const space = s => (s && typeof s === "object" && isId(s.id) ? { id: s.id, name: str(s.name), personal: s.personal === true } : null);
const group = g => (g && typeof g === "object" && isId(g.id) ? { id: g.id, name: typeof g.name === "string" ? str(g.name) : null } : null);

/** @returns {import("../../ports/trash.js").TrashResult | null} */
export function normalizeTrashed(b) {
  const sp = b?.board?.space;
  if (!b || typeof b !== "object" || !isId(b.board?.id) || !isId(sp?.id) || typeof b.trashed !== "boolean") return null;
  return { board: { id: b.board.id, title: str(b.board.title), space: { id: sp.id, name: str(sp.name) } }, trashed: b.trashed, trashedAt: ms(b.trashedAt), expiresAt: ms(b.expiresAt), undo: b.undo?.restore === true ? { restore: true } : null };
}
/** @returns {import("../../ports/trash.js").RestoreResult | null} */
export function normalizeRestored(b) {
  const sp = b?.board?.space;
  if (!b || typeof b !== "object" || !isId(b.board?.id) || !isId(sp?.id) || typeof b.restored !== "boolean") return null;
  return { board: { id: b.board.id, title: str(b.board.title), space: { id: sp.id, name: str(sp.name) } }, restored: b.restored };
}
/** @returns {import("../../ports/trash.js").SpaceResult | null} */
export function normalizeSpace(b) {
  if (!b || typeof b !== "object" || !isId(b.space?.id) || (typeof b.trashed !== "boolean" && typeof b.restored !== "boolean")) return null;
  return { space: { id: b.space.id, name: str(b.space.name) }, ...(typeof b.trashed === "boolean" ? { trashed: b.trashed } : {}), ...(typeof b.restored === "boolean" ? { restored: b.restored } : {}),
    boards: Number.isSafeInteger(b.boards) && b.boards >= 0 ? b.boards : 0, undo: b.undo?.restore === true ? { restore: true } : null };
}
/** @returns {import("../../ports/trash.js").Notice | null} */
export function normalizeNotice(b) {
  if (!b || typeof b !== "object" || !isId(b.board?.id) || typeof b.canRestore !== "boolean" || days(b.daysLeft) === null) return null;
  const from = b.from && typeof b.from === "object" ? { space: space(b.from.space), group: group(b.from.group) } : null;
  const via = b.via && typeof b.via === "object" ? { space: group(b.via.space), canRestore: b.via.canRestore === true } : null;
  return { board: { id: b.board.id, title: str(b.board.title) }, trashedAt: ms(b.trashedAt), expiresAt: ms(b.expiresAt), daysLeft: b.daysLeft, canRestore: b.canRestore,
    ...(person(b.by) ? { by: person(b.by) } : {}), ...(from ? { from } : {}), ...(via ? { via } : {}) };
}
const item = i => {
  if (!i || typeof i !== "object" || days(i.daysLeft) === null || !isId(i.id)) return null;
  const base = { id: i.id, by: person(i.by), trashedAt: ms(i.trashedAt), expiresAt: ms(i.expiresAt), daysLeft: i.daysLeft };
  if (i.type === "board") return { type: "board", title: str(i.title), from: { space: space(i.from?.space), group: group(i.from?.group) }, ...base };
  if (i.type === "space") return { type: "space", name: str(i.name), group: group(i.group), boards: Number.isSafeInteger(i.boards) && i.boards >= 0 ? i.boards : 0, ...base };
  return null;
};
/** @returns {{ items: import("../../ports/trash.js").Item[], more: boolean } | null} */
export function normalizeList(b) {
  if (!b || typeof b !== "object" || !Array.isArray(b.items)) return null;
  return { items: b.items.slice(0, 51).map(item).filter(Boolean), more: b.more === true };
}

/** @returns {import("../../ports/trash.js").TrashPort} */
export function httpTrash({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpTrash: fetch is required");
  const set = timers ? timers.set : (fn, t) => setTimeout(fn, t);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 422: "invalid" };
  const CONFLICT = { moved: "moved", "with-space": "with-space", "space-in-trash": "space-in-trash", purged: "purged" };
  /** One request: `{ body }` or `{ error }`. Never throws. */
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
      if (res?.status === 409) { let e = null; try { e = JSON.parse(await res.text())?.error; } catch {} return { error: CONFLICT[e] ?? "moved" }; }
      if (res?.status !== 200) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;
  const post = async (path, body, key, norm, name) => { const r = await ask(path, "POST", body, key); if (r.error) return r; const v = norm(r.body); return v ? { [name]: v } : bad(); };
  return {
    async trash(board, { from }, key = null) {
      if (!isId(board) || !isId(from)) return { error: "forbidden" };
      return post(`/boards/${q(board)}/trash`, { from }, key, normalizeTrashed, "result");
    },
    async restore(board, key = null) {
      if (!isId(board)) return { error: "forbidden" };
      return post(`/boards/${q(board)}/restore`, {}, key, normalizeRestored, "result");
    },
    async trashSpace(spaceId, key = null) {
      if (!isId(spaceId)) return { error: "forbidden" };
      return post(`/spaces/${q(spaceId)}/trash`, {}, key, normalizeSpace, "result");
    },
    async restoreSpace(spaceId, key = null) {
      if (!isId(spaceId)) return { error: "forbidden" };
      return post(`/spaces/${q(spaceId)}/restore`, {}, key, normalizeSpace, "result");
    },
    async notice(board) {
      if (!isId(board)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/trash`);
      if (r.error) return r;
      const notice = normalizeNotice(r.body);
      return notice ? { notice } : bad();
    },
    async list() {
      const r = await ask("/trash");
      if (r.error) return r;
      const list = normalizeList(r.body);
      return list ? { list } : bad();
    },
  };
}

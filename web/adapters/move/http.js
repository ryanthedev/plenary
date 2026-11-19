// Move adapter over fetch: implements web/ports/move.js against PROTOCOL.md § Move board. Imports nothing (fetch and timers are injected). Bodies are checked here because the
// dialog renders them: ids are 1-64 of [A-Za-z0-9_-], strings and lists are capped, anything else is dropped. Names are other people's words: the dialog renders text only.

const ID_RE = /^[\w-]{1,64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
const role = r => (r && typeof r === "object" && typeof r.id === "string" ? { id: str(r.id, 64), name: str(r.name, 64) } : null);
const space = s => (s && typeof s === "object" && isId(s.id) ? { id: s.id, name: str(s.name), personal: s.personal === true } : null);
const dest = d => (d && typeof d === "object" && isId(d.id)
  ? { id: d.id, name: str(d.name), personal: d.personal === true, general: typeof d.general === "string" ? d.general.slice(0, 32) : null, group: d.group && isId(d.group.id) ? { id: d.group.id, name: str(d.group.name) } : null } : null);
const entry = e => (e && typeof e === "object" && e.subject && ["user", "team", "everyone"].includes(e.subject.type)
  ? { subject: { type: e.subject.type, ...(typeof e.subject.id === "string" && e.subject.id.length <= 200 && !/[\0\n]/.test(e.subject.id) ? { id: e.subject.id } : {}), name: str(e.subject.name) }, ...(e.self === true ? { self: true } : {}), before: role(e.before), after: role(e.after) } : null);
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** @returns {import("../../ports/move.js").MoveOptions | null} */
export function normalizeOptions(b) {
  if (!b || typeof b !== "object" || !isId(b.board?.id) || !Array.isArray(b.destinations)) return null;
  return { board: { id: b.board.id, title: str(b.board.title) }, from: b.from?.hidden === true ? { hidden: true } : space(b.from), destinations: list(b.destinations, 101, dest), more: b.more === true };
}
/** @returns {import("../../ports/move.js").MoveDiff | null} */
export function normalizeDiff(b) {
  const to = space(b?.to);
  if (!b || typeof b !== "object" || !isId(b.board?.id) || !to || !Array.isArray(b.gains) || !Array.isArray(b.keeps) || !Array.isArray(b.loses)) return null;
  return { board: { id: b.board.id, title: str(b.board.title) }, from: b.from?.hidden === true ? { hidden: true } : space(b.from), to,
    gains: list(b.gains, 50, entry), keeps: list(b.keeps, 50, entry), loses: list(b.loses, 50, entry), invites: count(b.invites), links: count(b.links), hidden: b.hidden === true, more: b.more === true };
}
/** @returns {import("../../ports/move.js").MoveResult | null} */
export function normalizeResult(b) {
  const sp = space(b?.board?.space);
  if (!b || !isId(b.board?.id) || !sp || typeof b.moved !== "boolean") return null;
  return { board: { id: b.board.id, title: str(b.board.title), space: { id: sp.id, name: sp.name } }, moved: b.moved, undo: b.undo?.space && space(b.undo.space) ? { space: space(b.undo.space) } : null };
}

/** @returns {import("../../ports/move.js").MovePort} */
export function httpMove({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpMove: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 409: "moved", 422: "invalid" };
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
      if (res?.status !== 200) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;
  return {
    async options(board) {
      if (!isId(board)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/move`);
      if (r.error) return r;
      const options = normalizeOptions(r.body);
      return options ? { options } : bad();
    },
    async preview(board, to) {
      if (!isId(board) || !isId(to)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/move/preview?to=${q(to)}`);
      if (r.error) return r;
      const diff = normalizeDiff(r.body);
      return diff ? { diff } : bad();
    },
    async move(board, { from, to }, key = null) {
      if (!isId(board) || !isId(to) || (from !== null && !isId(from))) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/move`, "POST", { from, to }, key);
      if (r.error) return r;
      const result = normalizeResult(r.body);
      return result ? { result } : bad();
    },
  };
}

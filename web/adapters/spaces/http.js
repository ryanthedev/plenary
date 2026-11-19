// Spaces adapter over fetch: implements web/ports/spaces.js against the routes of PROTOCOL.md § Spaces and Groups. Imports nothing (fetch and
// timers are injected). Bodies are checked here because the page renders them and puts ids in links: ids are 1-64 of [A-Za-z0-9_-], strings
// and lists are capped, anything else is dropped.

const ID_RE = /^[\w-]{1,64}$/;
/** A valid id: a string (a missing field is not the id "undefined"). */
const ID = { test: v => typeof v === "string" && ID_RE.test(v) };
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
const gen = v => (typeof v === "string" ? v.slice(0, 32) : null);

const part = p => (p && typeof p === "object" && ["group", "space", "other", "shared"].includes(p.type) ? { type: p.type, ...(ID.test(p.id) ? { id: p.id } : {}), name: str(p.name) } : null);
const card = c => (c && typeof c === "object" && ID.test(c.id)
  ? { id: c.id, title: str(c.title), role: str(c.role, 32), path: list(c.path, 4, part), starred: c.starred === true, ...(c.can && typeof c.can === "object" ? { can: { rename: c.can.rename === true } } : {}) } : null);
const grp = g => (g && typeof g === "object" && ID.test(g.id) ? { id: g.id, name: str(g.name) } : null);
const info = s => (s && typeof s === "object" && ID.test(s.id) ? { id: s.id, name: str(s.name), personal: s.personal === true, general: gen(s.general), group: grp(s.group) } : null);

/** @param {object} b @returns {import("../../ports/spaces.js").SpacePage | null} */
export function normalizeSpacePage(b) {
  const space = info(b?.space);
  if (!space || !Array.isArray(b.boards)) return null;
  return { space, can: { createBoard: b.can?.createBoard === true, rename: b.can?.rename === true, general: b.can?.general === true }, boards: list(b.boards, 50, card), more: b.more === true };
}
/** @param {object} b @returns {import("../../ports/spaces.js").GroupPage | null} */
export function normalizeGroupPage(b) {
  const g = grp(b?.group);
  if (!g || !Array.isArray(b.spaces)) return null;
  return { group: { ...g, general: gen(b.group.general) }, can: { createSpace: b.can?.createSpace === true, rename: b.can?.rename === true, general: b.can?.general === true },
    spaces: list(b.spaces, 100, s => (s && ID.test(s.id) ? { id: s.id, name: str(s.name), general: gen(s.general) } : null)), next: ID.test(b.next) ? b.next : null };
}

/**
 * @param {{ fetch: typeof globalThis.fetch, token: string, base?: string, timeoutMs?: number,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 * @returns {import("../../ports/spaces.js").SpacesPort}
 */
export function httpSpaces({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpSpaces: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound" };

  /** One request: `{ body }` (a parsed 200/201 body), or `{ error }`. Never throws. */
  async function ask(path, method = "GET", json) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise(resolve => { timer = set(() => { try { ctl?.abort(); } catch {} resolve({ error: "unavailable" }); }, timeoutMs); });
    const run = (async () => {
      let res;
      try {
        res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
          ...(json !== undefined ? { body: JSON.stringify(json) } : {}), credentials: "omit", cache: "no-store", redirect: "error", signal: ctl?.signal });
      } catch { return { error: "network" }; }
      if (STATUS[res?.status]) return { error: STATUS[res.status] };
      if (res?.status !== 200 && res?.status !== 201) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const idOk = id => ID.test(id);
  const q = encodeURIComponent;
  const patch = async (kind, id, p) => {
    if (!idOk(id)) return { error: "forbidden" };
    const r = await ask(`/${kind}s/${q(id)}`, "PATCH", p);
    if (r.error) return r;
    if (kind === "space") { const s = info(r.body?.space); return s ? { space: s } : bad(); }
    const g = grp(r.body?.group);
    return g ? { group: { ...g, general: gen(r.body.group.general) } } : bad();
  };

  return {
    async space(id) {
      if (!idOk(id)) return { error: "notfound" };
      const r = await ask(`/spaces/${q(id)}`);
      if (r.error) return r;
      const page = normalizeSpacePage(r.body);
      return page ? { page } : bad();
    },
    async group(id, after = null) {
      if (!idOk(id) || (after !== null && !idOk(after))) return { error: "notfound" };
      const r = await ask(`/groups/${q(id)}${after ? `?after=${q(after)}` : ""}`);
      if (r.error) return r;
      const page = normalizeGroupPage(r.body);
      return page ? { page } : bad();
    },
    async boardSpaces() {
      const r = await ask("/spaces?can=board.create");
      if (r.error) return r;
      return Array.isArray(r.body?.spaces) ? { spaces: list(r.body.spaces, 101, info), more: r.body.more === true } : bad();
    },
    async spaceGroups() {
      const r = await ask("/groups?can=space.create");
      if (r.error) return r;
      return Array.isArray(r.body?.groups) ? { root: r.body.root === true, groups: list(r.body.groups, 50, grp), more: r.body.more === true } : bad();
    },
    async createBoard({ title, space = null }) {
      const r = await ask("/boards", "POST", { title, ...(space ? { space } : {}) });
      if (r.error) return r;
      return ID.test(r.body?.board?.id) ? { board: { id: r.body.board.id } } : bad();
    },
    async createSpace({ name, group = null, general }) {
      const r = await ask("/spaces", "POST", { name, ...(group ? { group } : {}), ...(general !== undefined ? { general } : {}) });
      if (r.error) return r;
      const s = info(r.body?.space);
      return s ? { space: s } : bad();
    },
    updateSpace: (id, p) => patch("space", id, p),
    updateGroup: (id, p) => patch("group", id, p),
    async renameBoard(id, title) {
      if (!idOk(id)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(id)}`, "PATCH", { title });
      if (r.error) return r;
      return ID.test(r.body?.board?.id) ? { board: { id: r.body.board.id, title: str(r.body.board.title) } } : bad();
    },
  };
}

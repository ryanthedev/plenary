// Offboarding adapter over fetch: implements web/ports/offboard.js against PROTOCOL.md § Leaver offboarding. Imports nothing (fetch and timers are injected). Bodies are checked here because the page
// renders them: ids are short, strings and lists are capped, anything else is dropped. Names are other people's words: the page renders text only.

const isId = v => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const isUser = v => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n]/.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const count = n => (Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : null);
const person = p => (p && typeof p === "object" && isUser(p.id) ? { id: p.id, name: str(p.name) || str(p.id).replace(/^[a-z]+:/, "") } : null);
const TYPES = ["space", "group"];

/** @returns {import("../../ports/offboard.js").Item|null} */
export function normalizeItem(i) {
  if (!i || typeof i !== "object" || !TYPES.includes(i.type) || !isId(i.id)) return null;
  return { type: i.type, id: i.id, name: str(i.name), personal: i.personal === true, archived: i.archived === true, trashed: i.trashed === true,
    ...(count(i.boards) !== null ? { boards: count(i.boards), boardsCapped: i.boardsCapped === true } : {}),
    can: { reassign: i.can?.reassign === true, ...(i.can?.handover === true ? { handover: true } : {}), ...(typeof i.can?.why === "string" ? { why: str(i.can.why, 200) } : {}) } };
}
/** @returns {import("../../ports/offboard.js").Page|null} */
export function normalizePage(b) {
  const m = person({ id: b?.member?.id, name: b?.member?.name }), d = person(b?.defaults?.recipient);
  if (!b || !m || !d || !Array.isArray(b.items) || typeof b.canRemove !== "boolean") return null;
  return { member: { ...m, email: typeof b.member.email === "string" ? str(b.member.email, 320) : null, removed: b.member.removed === true },
    defaults: { recipient: d, reason: b.defaults.reason === "manager" ? "manager" : "remover" }, items: b.items.slice(0, 51).map(normalizeItem).filter(Boolean),
    next: typeof b.next === "string" && b.next.length <= 200 ? b.next : null, blocked: b.blocked === "admin" ? "admin" : null, canRemove: b.canRemove };
}

/** @returns {import("../../ports/offboard.js").OffboardPort} */
export function httpOffboard({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpOffboard: fetch is required");
  const set = timers ? timers.set : (fn, t) => setTimeout(fn, t);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 422: "invalid" };
  const CODES = ["bad-recipient", "still-owns", "is-admin", "personal"];
  /** One request: `{ body }` or `{ error, code? }`. Never throws. */
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
      if (STATUS[res?.status] || res?.status === 409) {
        let b = null;
        try { b = JSON.parse(await res.text()); } catch {}
        const code = CODES.includes(b?.error) ? b.error : undefined;
        return { error: res.status === 409 ? "conflict" : STATUS[res.status], ...(code ? { code } : {}) };
      }
      if (res?.status !== 200) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;
  return {
    async list(user, after = null) {
      if (!isUser(user)) return { error: "forbidden" };
      const r = await ask(`/members/${q(user)}/offboarding${after ? `?after=${q(after)}` : ""}`);
      if (r.error) return r;
      const page = normalizePage(r.body);
      return page ? { page } : bad();
    },
    async reassign(user, { type, id, to }, key = null) {
      if (!isUser(user) || !TYPES.includes(type) || !isId(id) || !isUser(to)) return { error: "forbidden" };
      const r = await ask(`/members/${q(user)}/offboarding/reassign`, "POST", { type, id, to }, key);
      if (r.error) return r;
      const item = normalizeItem({ ...r.body?.item, can: {} }), p = person(r.body?.to);
      return item && p && typeof r.body.done === "boolean" ? { result: { item: { type: item.type, id: item.id, name: item.name, archived: item.archived }, to: p, done: r.body.done } } : bad();
    },
    async remove(user, to = null, key = null) {
      if (!isUser(user) || (to !== null && !isUser(to))) return { error: "forbidden" };
      const r = await ask(`/members/${q(user)}/remove`, "POST", to ? { to } : {}, key);
      if (r.error) return r;
      return typeof r.body?.removed === "boolean" ? { result: { removed: r.body.removed, grants: count(r.body.grants), scopedGrants: count(r.body.scopedGrants), teams: count(r.body.teams) } } : bad();
    },
    async people(term = "") {
      const r = await ask(`/directory?q=${q(String(term).slice(0, 100))}`);
      if (r.error) return r;
      return Array.isArray(r.body?.people) ? { people: r.body.people.slice(0, 8).map(p => person({ id: p?.user, name: p?.name })).filter(Boolean) } : bad();
    },
  };
}

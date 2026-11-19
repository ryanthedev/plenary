// Roles adapter over fetch: implements web/ports/roles.js against the routes of PROTOCOL.md § Roles. Imports nothing (fetch and timers are injected).
// Bodies are checked here because the screen renders them: ids are 1-64 of [A-Za-z0-9_-], strings and lists are capped, anything else is dropped.

const ID = { test: v => typeof v === "string" && /^[\w-]{1,64}$/.test(v) };
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
const SCOPES = ["unit", "group", "space", "board"];
const KINDS = ["builtin", "member", "custom"];
const perm = p => (typeof p === "string" && /^[a-z]+(\.[a-z]+)?$/.test(p) && p.length <= 32 ? p : null);
const count = n => (Number.isFinite(n) ? Math.max(0, Math.min(1_000_000, Math.floor(n))) : 0);

/** @returns {import("../../ports/roles.js").RoleView|null} */
export function normalizeRole(r) {
  if (!r || typeof r !== "object" || !ID.test(r.id) || !KINDS.includes(r.kind)) return null;
  const u = r.used;
  const used = u && typeof u === "object" ? ("members" in u ? { members: count(u.members), capped: u.capped === true } : { places: count(u.places), capped: u.capped === true }) : null;
  return { id: r.id, name: str(r.name), kind: r.kind, editable: r.editable === true, ...(typeof r.summary === "string" ? { summary: str(r.summary, 300) } : {}),
    ...(typeof r.base === "string" && r.base.length <= 64 ? { base: r.base } : {}), ladder: typeof r.ladder === "string" ? str(r.ladder, 16) : null,
    permissions: list(r.permissions, 20, perm), scopes: Object.fromEntries(SCOPES.map(s => [s, list(r.scopes?.[s], 20, perm)])), used };
}
/** @returns {import("../../ports/roles.js").RolesPage|null} */
export function normalizeRolesPage(b) {
  if (!b || !Array.isArray(b.roles) || !b.matrix || !Array.isArray(b.matrix.permissions)) return null;
  const m = b.matrix;
  return {
    roles: list(b.roles, 80, normalizeRole),
    matrix: {
      scopes: SCOPES,
      permissions: list(m.permissions, 20, p => (perm(p?.id) ? { id: p.id, group: p.group === "content" ? "content" : "management", scopes: list(p.scopes, 4, s => (SCOPES.includes(s) ? s : null)) } : null)),
      content: Object.fromEntries(Object.entries(m.content && typeof m.content === "object" ? m.content : {}).slice(0, 6).map(([k, v]) => [str(k, 16), list(v, 6, perm)])),
      ladders: list(m.ladders, 6, l => (typeof l === "string" ? str(l, 16) : null)), tickable: list(m.tickable, 20, perm),
    },
    can: { admin: b.can?.admin === true },
    limits: { custom: count(b.limits?.custom) || 50, many: { places: count(b.limits?.many?.places) || 10, people: count(b.limits?.many?.people) || 50 } },
  };
}

/** @returns {import("../../ports/roles.js").RolesPort} */
export function httpRoles({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpRoles: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 409: "conflict", 422: "invalid" };
  const RETRIES = 5, WAIT_MIN = 250, WAIT_MAX = 5000;
  const retryAfter = res => { const n = Number(res.headers?.get?.("retry-after")); return Math.min(WAIT_MAX, Math.max(WAIT_MIN, Number.isFinite(n) && n > 0 ? n * 1000 : 1000)); };
  const CODES = ["confirm-required", "in-use", "too-large", "in-progress"];

  /** One request: `{ body }` (a parsed 200/201 body, or null for a 204), or `{ error, code?, ... }`. Never throws. */
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
      if (STATUS[res?.status]) {
        let b = null;
        try { b = JSON.parse(await res.text()); } catch {}
        const code = CODES.includes(b?.error) ? b.error : undefined;
        const out = { error: STATUS[res.status], ...(code ? { code } : {}) };
        if (code === "confirm-required" && b.impact && typeof b.impact === "object") out.impact = { places: count(b.impact.places), people: count(b.impact.people), capped: b.impact.capped === true };
        if (code === "in-use") out.used = { places: count(b.places), capped: b.capped === true };
        if (code === "in-progress") out.waitMs = retryAfter(res);
        return out;
      }
      if (res?.status === 204) return { body: null };
      if (res?.status !== 200 && res?.status !== 201) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;

  return {
    async roles() {
      const r = await ask("/roles");
      if (r.error) return r;
      const page = normalizeRolesPage(r.body);
      return page ? { page } : bad();
    },
    async createRole({ name, base: from = null, boardRole, permissions, key }) {
      for (let i = 0; ; i++) {
        const r = await ask("/roles", "POST", { name, ...(from ? { base: from } : {}), boardRole, permissions }, key);
        if (r.code === "in-progress" && i < RETRIES) { await new Promise(resolve => set(resolve, r.waitMs)); continue; }
        if (r.error) return { error: r.code === "in-progress" ? "unavailable" : r.error, ...(r.code && r.code !== "in-progress" ? { code: r.code } : {}) };
        const role = normalizeRole(r.body?.role);
        return role ? { role } : bad();
      }
    },
    async updateRole(id, patch) {
      if (!ID.test(id)) return { error: "forbidden" };
      const r = await ask(`/roles/${q(id)}`, "PATCH", patch);
      if (r.error) return r;
      const role = normalizeRole(r.body?.role);
      return role ? { role } : bad();
    },
    async removeRole(id) {
      if (!ID.test(id)) return { error: "forbidden" };
      const r = await ask(`/roles/${q(id)}`, "DELETE");
      return r.error ? r : {};
    },
  };
}

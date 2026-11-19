// Access adapter over fetch: implements web/ports/access.js against the routes of PROTOCOL.md § Teams and access. Imports nothing (fetch and timers
// are injected). Bodies are checked here because the pages render them and put ids in links: ids are 1-64 of [A-Za-z0-9_-] (user ids are opaque
// strings, up to 200 chars), strings and lists are capped, anything else is dropped.

const ID_RE = /^[\w-]{1,64}$/;
const ID = { test: v => typeof v === "string" && ID_RE.test(v) };
const UID = { test: v => typeof v === "string" && v.length > 0 && v.length <= 200 && !v.includes("\n") };
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
const TYPES = ["unit", "group", "space", "board"];

const team = t => (t && typeof t === "object" && ID.test(t.id) ? { id: t.id, name: str(t.name), size: Number.isFinite(t.size) ? Math.max(0, Math.floor(t.size)) : 0 } : null);
const person = p => (p && typeof p === "object" && UID.test(p.user) ? { user: p.user, name: str(p.name), email: typeof p.email === "string" ? str(p.email, 320) : null } : null);
const subject = s => {
  if (!s || typeof s !== "object") return null;
  if (s.type === "team" && ID.test(s.id)) return { type: "team", id: s.id, name: str(s.name), size: Number.isFinite(s.size) ? s.size : 0 };
  if (s.type === "user" && UID.test(s.id)) return { type: "user", id: s.id, name: str(s.name), email: typeof s.email === "string" ? str(s.email, 320) : null };
  return null;
};
const scopeRef = s => (s && typeof s === "object" && TYPES.includes(s.type) && ID.test(s.id) ? { type: s.type, id: s.id, ...(typeof s.name === "string" ? { name: str(s.name) } : {}) } : null);
const row = r => {
  const sub = subject(r?.subject);
  if (!sub || typeof r.role !== "string") return null;
  return { subject: sub, role: str(r.role, 64), roleName: str(r.roleName, 64), via: ["direct", "team", "inherited"].includes(r.via) ? r.via : "direct",
    ...(r.can && typeof r.can === "object" ? { can: { change: r.can.change === true, remove: r.can.remove === true } } : {}), ...(r.scope ? { scope: scopeRef(r.scope) } : {}) };
};
const option = o => (o && typeof o === "object" && typeof o.id === "string" && o.id.length <= 64 ? { id: o.id, name: str(o.name, 64), custom: o.custom === true, summary: str(o.summary, 300), ladder: typeof o.ladder === "string" ? o.ladder : null, people: o.people !== false } : null);

/** @returns {import("../../ports/access.js").AccessPage | null} */
export function normalizeAccessPage(b) {
  const sc = scopeRef(b?.scope);
  if (!sc || !Array.isArray(b.rows)) return null;
  return {
    scope: { ...sc, ...(b.scope.personal === true ? { personal: true } : {}) }, can: { manage: b.can?.manage === true },
    general: list(b.general, 3, g => (g && typeof g.role === "string" && scopeRef(g.scope) ? { scope: scopeRef(g.scope), role: str(g.role, 32) } : null)),
    ...(Array.isArray(b.admins) ? { admins: list(b.admins, 100, person) } : {}),
    rows: list(b.rows, 250, row), next: typeof b.next === "string" && b.next.length <= 600 ? b.next : null, inherited: list(b.inherited, 40, row), roles: list(b.roles, 100, option),
  };
}
/** @returns {import("../../ports/access.js").TeamPage | null} */
export function normalizeTeamPage(b) {
  const t = team(b?.team);
  if (!t || !Array.isArray(b.members)) return null;
  return { team: t, can: { manage: b.can?.manage === true }, members: list(b.members, 50, person), next: typeof b.next === "string" && b.next.length <= 600 ? b.next : null };
}

/** @returns {import("../../ports/access.js").AccessPort} */
export function httpAccess({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpAccess: fetch is required");
  const set = timers ? timers.set : (fn, ms) => setTimeout(fn, ms);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 409: "conflict" };
  const CODES = ["unknown-person", "bad-role", "last-owner", "too-large"];

  /** One request: `{ body }` (a parsed 200/201 body, or null for a 204), or `{ error, code? }`. Never throws. */
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
      if (STATUS[res?.status]) {
        let code;
        try { const b = JSON.parse(await res.text()); if (CODES.includes(b?.error)) code = b.error; } catch {}
        return { error: STATUS[res.status], ...(code ? { code } : {}) };
      }
      if (res?.status === 204) return { body: null };
      if (res?.status !== 200 && res?.status !== 201) return { error: "unavailable" };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }
  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;
  const qs = o => { const p = Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${q(v)}`); return p.length ? "?" + p.join("&") : ""; };
  const subj = s => s && (s.type === "user" || s.type === "team") && UID.test(s.id) ? s : null;

  return {
    async teams({ after = null, q: term = null } = {}) {
      const r = await ask("/teams" + qs({ after, q: term }));
      if (r.error) return r;
      return Array.isArray(r.body?.teams) ? { teams: list(r.body.teams, 50, team), next: typeof r.body.next === "string" ? r.body.next : null, can: { create: r.body.can?.create === true } } : bad();
    },
    async team(id, after = null) {
      if (!ID.test(id)) return { error: "notfound" };
      const r = await ask(`/teams/${q(id)}` + qs({ after }));
      if (r.error) return r;
      const page = normalizeTeamPage(r.body);
      return page ? { page } : bad();
    },
    async createTeam(name) {
      const r = await ask("/teams", "POST", { name });
      if (r.error) return r;
      const t = team(r.body?.team);
      return t ? { team: t } : bad();
    },
    async renameTeam(id, name) {
      if (!ID.test(id)) return { error: "forbidden" };
      const r = await ask(`/teams/${q(id)}`, "PATCH", { name });
      if (r.error) return r;
      const t = team(r.body?.team);
      return t ? { team: t } : bad();
    },
    async deleteTeam(id) {
      if (!ID.test(id)) return { error: "forbidden" };
      const r = await ask(`/teams/${q(id)}`, "DELETE");
      return r.error ? r : {};
    },
    async setMember(id, user, on) {
      if (!ID.test(id) || !UID.test(user)) return { error: "forbidden" };
      const r = await ask(`/teams/${q(id)}/members/${q(user)}`, on ? "PUT" : "DELETE");
      return r.error ? r : {};
    },
    async directory(term = "") {
      const r = await ask("/directory" + qs({ q: term }));
      if (r.error) return r;
      return Array.isArray(r.body?.people) ? { people: list(r.body.people, 8, person), teams: list(r.body.teams, 8, team) } : bad();
    },
    async access(type, id, after = null) {
      if (!TYPES.includes(type) || !ID.test(id)) return { error: "notfound" };
      const r = await ask(`/access/${type}/${q(id)}` + qs({ after }));
      if (r.error) return r;
      const page = normalizeAccessPage(r.body);
      return page ? { page } : bad();
    },
    async setGrant(type, id, subject, role) {
      if (!TYPES.includes(type) || !ID.test(id) || !subj(subject)) return { error: "forbidden" };
      const r = await ask(`/access/${type}/${q(id)}/grants/${subject.type}/${q(subject.id)}`, "PUT", { role });
      if (r.error) return r;
      const x = row(r.body?.row);
      return x ? { row: x } : bad();
    },
    async removeGrant(type, id, subject) {
      if (!TYPES.includes(type) || !ID.test(id) || !subj(subject)) return { error: "forbidden" };
      const r = await ask(`/access/${type}/${q(id)}/grants/${subject.type}/${q(subject.id)}`, "DELETE");
      return r.error ? r : {};
    },
  };
}

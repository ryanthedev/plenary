// @ts-check
// Versions adapter over fetch: implements web/ports/versions.js (#19). Imports nothing at runtime (fetch and timers are injected).
// Bodies are validated and normalized here because the page renders version metadata directly.

const ID_RE = /^[\w-]{1,64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const ms = v => (Number.isFinite(v) && v >= 0 ? v : null);
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** @returns {import("../../ports/versions.js").BoardVersionMeta | null} */
export function normalizeVersionMeta(v) {
  if (!v || typeof v !== "object" || !isId(v.id)) return null;
  if (typeof v.label !== "string" || !v.label) return null;
  if (typeof v.createdBy !== "string" || !v.createdBy || v.createdBy.length > 200) return null;
  const createdAt = ms(v.createdAt);
  const elementCount = count(v.elementCount);
  if (createdAt === null || elementCount === null) return null;
  const createdByName = typeof v.createdByName === "string" && v.createdByName ? str(v.createdByName, 200) : null;
  return {
    id: v.id,
    label: str(v.label, 120),
    createdBy: v.createdBy,
    createdByName,
    createdAt,
    elementCount,
  };
}

/** @returns {import("../../ports/versions.js").BoardVersion | null} */
export function normalizeVersion(v) {
  const meta = normalizeVersionMeta(v);
  if (!meta) return null;
  if (!v.snapshot || typeof v.snapshot !== "object" || Array.isArray(v.snapshot)) return null;
  return { ...meta, snapshot: v.snapshot };
}

/** @returns {import("../../ports/versions.js").BoardVersionMeta[] | null} */
export function normalizeVersionList(b) {
  if (!b || typeof b !== "object" || !Array.isArray(b.versions)) return null;
  const out = [];
  for (const item of b.versions.slice(0, 100)) {
    const m = normalizeVersionMeta(item);
    if (m) out.push(m);
  }
  return out;
}

/**
 * @param {{ fetch: typeof globalThis.fetch, token: string, base?: string, timeoutMs?: number, timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } | null }} opts
 * @returns {import("../../ports/versions.js").VersionsPort}
 */
export function httpVersions({ fetch, token, base = "", timeoutMs = 10_000, timers = null }) {
  if (typeof fetch !== "function") throw new TypeError("httpVersions: fetch is required");
  const set = timers ? timers.set : (fn, t) => setTimeout(fn, t);
  const clear = timers ? timers.clear : h => clearTimeout(h);
  const STATUS = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 413: "too-large", 422: "invalid", 429: "limit" };

  /** One request: `{ body }` (or `{ ok: true }` for 204) or `{ error }`. Never throws. */
  async function ask(path, method = "GET", jsonBody = undefined, okStatuses = [200]) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = set(() => { try { ctl?.abort(); } catch {} resolve({ error: "unavailable" }); }, timeoutMs);
    });
    const run = (async () => {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: ctl?.signal,
        });
      } catch { return { error: "network" }; }
      if (STATUS[res?.status]) return { error: STATUS[res.status] };
      if (!okStatuses.includes(res?.status)) return { error: "unavailable" };
      if (res.status === 204) return { ok: true };
      try { return { body: JSON.parse(await res.text()) }; } catch { return { error: "unavailable" }; }
    })().catch(() => ({ error: "unavailable" }));
    try { return await Promise.race([run, timeout]); } finally { clear(timer); }
  }

  const bad = () => ({ error: "unavailable" });
  const q = encodeURIComponent;

  return {
    async list(board) {
      if (!isId(board)) return { error: "forbidden" };
      const r = await ask(`/boards/${q(board)}/versions`, "GET", undefined, [200]);
      if (r.error) return r;
      const versions = normalizeVersionList(r.body);
      return versions ? { versions } : bad();
    },

    async create(board, { label, snapshot }) {
      if (!isId(board)) return { error: "forbidden" };
      if (typeof label !== "string" || !label.trim() || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        return { error: "invalid" };
      }
      const r = await ask(`/boards/${q(board)}/versions`, "POST", { label, snapshot }, [201]);
      if (r.error) return r;
      const version = normalizeVersionMeta(r.body?.version);
      return version ? { version } : bad();
    },

    async get(board, versionId) {
      if (!isId(board)) return { error: "forbidden" };
      if (!isId(versionId)) return { error: "notfound" };
      const r = await ask(`/boards/${q(board)}/versions/${q(versionId)}`, "GET", undefined, [200]);
      if (r.error) return r;
      const version = normalizeVersion(r.body?.version);
      return version ? { version } : bad();
    },

    async remove(board, versionId) {
      if (!isId(board)) return { error: "forbidden" };
      if (!isId(versionId)) return { error: "notfound" };
      const r = await ask(`/boards/${q(board)}/versions/${q(versionId)}`, "DELETE", undefined, [204]);
      if (r.error) return r;
      return { ok: true };
    },
  };
}

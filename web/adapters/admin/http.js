// Bearer-authenticated HTTP adapter for the Admin & Share API (implements web/ports/admin.js).
// Zero runtime imports: fetch, origin, and session token are injected by the composition root.
// Never logs or puts the token in any URL; parses JSON responses and throws structured { status, code, message } errors.

/** Structured error thrown by httpAdmin on HTTP failure, malformed JSON, or network error. */
export class AdminHttpError extends Error {
  /**
   * @param {number} status   HTTP status code (0 on network failure)
   * @param {string} code     server error code (e.g. "forbidden", "bad-request", "last-owner", "network")
   * @param {string} message  human-readable description
   */
  constructor(status, code, message) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
    this.code = code;
  }
}

const enc = v => encodeURIComponent(String(v));

function query(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * @param {{ origin?: string, token: string, fetch: typeof globalThis.fetch }} o
 * @returns {import("../../ports/admin.js").AdminPort}
 */
export function httpAdmin({ origin = "", token, fetch }) {
  if (typeof fetch !== "function") throw new TypeError("httpAdmin: fetch is required");
  if (typeof token !== "string" || !token) throw new TypeError("httpAdmin: token is required");
  const base = typeof origin === "string" ? origin.replace(/\/+$/, "") : "";

  async function request(method, path, body) {
    const headers = { Authorization: `Bearer ${token}` };
    /** @type {RequestInit} */
    const init = { method, headers, cache: "no-store", redirect: "error" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (err) {
      throw new AdminHttpError(0, "network", String(err?.message || "Network request failed"));
    }
    if (res.status === 204) return undefined;
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const code = (data && typeof data.error === "string" && data.error) ? data.error : "http-error";
      const msg = (data && typeof data.message === "string" && data.message)
        ? data.message
        : (data && typeof data.error === "string" && data.error) ? data.error : `HTTP ${res.status}`;
      throw new AdminHttpError(res.status, code, msg);
    }
    if (data === null) {
      throw new AdminHttpError(res.status, "malformed", "Invalid JSON response from server");
    }
    return data;
  }

  return {
    listBoards() {
      return request("GET", "/boards");
    },
    createBoard({ title, memberRole } = {}) {
      const payload = {};
      if (title !== undefined) payload.title = title;
      if (memberRole !== undefined) payload.memberRole = memberRole;
      return request("POST", "/boards", payload);
    },
    listLinks(board) {
      return request("GET", `/boards/${enc(board)}/links`);
    },
    createLink(board, { role, expiresAt } = {}) {
      const payload = { role };
      if (expiresAt !== undefined) payload.expiresAt = expiresAt;
      return request("POST", `/boards/${enc(board)}/links`, payload);
    },
    revokeLink(board, id) {
      return request("DELETE", `/boards/${enc(board)}/links/${enc(id)}`);
    },
    listInvites(board) {
      return request("GET", `/boards/${enc(board)}/invites`);
    },
    createInvite(board, { email, role, expiresAt } = {}) {
      const payload = { email, role };
      if (expiresAt !== undefined) payload.expiresAt = expiresAt;
      return request("POST", `/boards/${enc(board)}/invites`, payload);
    },
    revokeInvite(board, id) {
      return request("DELETE", `/boards/${enc(board)}/invites/${enc(id)}`);
    },
    setGrant(board, user, role) {
      return request("PUT", `/boards/${enc(board)}/grants/${enc(user)}`, { role });
    },
    boardAudit(board, { limit, before } = {}) {
      return request("GET", `/boards/${enc(board)}/audit${query({ limit, before })}`);
    },
    adminAudit({ board, limit, before } = {}) {
      return request("GET", `/admin/audit${query({ board, limit, before })}`);
    },
  };
}

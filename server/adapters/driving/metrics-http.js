// @ts-check
// GET /metrics (PROTOCOL.md § Metrics): a driving adapter. It checks a bearer token and hands back whatever `render()` returns.
// Disabled (no token configured): a plain 404, indistinguishable from an unknown path. It reads no Store, Bus or board.

const text = (status, body, headers = {}) => new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const json = (status, body, headers) => text(status, JSON.stringify(body), headers);
const enc = new TextEncoder();
const digest = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** Constant-time string equality: both sides are hashed to 32 bytes, so neither length nor content shows in the time. */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** The shortest token the start accepts, in characters (main.js checks it with this). */
export const METRICS_TOKEN_MIN = 16;
/** RFC 6750 token68 (letters, digits, -._~+/ and trailing =): what a bearer header carries unambiguously; no whitespace anywhere. */
export const METRICS_TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * @param {{ token?: string | null, render?: () => string, log?: { error(msg: string, fields?: object): void } } | null} [o]  no token (or no render) = disabled
 * @returns {{ handle(req: Request): Promise<Response> }}  answers every request to /metrics, enabled or not
 */
export function metricsRoute(o) {
  const { token, render, log } = o ?? {};
  if (!token || typeof render !== "function") return { async handle() { return json(404, { error: "not-found" }); } };
  return {
    async handle(req) {
      const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
      if (!m || !(await sameSecret(m[1], token))) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      if (req.method !== "GET") return json(405, { error: "method-not-allowed" }, { allow: "GET" });
      try { return text(200, render(), { "content-type": "text/plain; version=0.0.4; charset=utf-8" }); }
      catch (err) { log?.error("metrics render failed", { err }); return json(500, { error: "internal" }); }
    },
  };
}

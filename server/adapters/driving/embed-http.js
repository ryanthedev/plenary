// @ts-check
// Driving HTTP adapter for embedding Plenary boards elsewhere (Issue #23):
//   - GET /embed/:board  — minimal chrome-free read-only iframe shell that connects live via WS `hello`
//                          using a verified read-only embed token (never leaked in logs or WS URLs),
//                          with tenant-aware `Content-Security-Policy: frame-ancestors ...`.
//   - GET /oembed        — standard oEmbed 1.0 JSON response (`type: "rich"`, `html: "<iframe ...>"`).
//   - renderUnfurlMetaTags() — OpenGraph, Twitter Card, and Slack oEmbed discovery `<meta>` / `<link>` tags.

import { isId } from "../../core/ids.js";
import { quietLogger } from "../../core/log.js";

const DEFAULT_OEMBED_WIDTH = 800;
const DEFAULT_OEMBED_HEIGHT = 500;
const MIN_OEMBED_WIDTH = 200;
const MIN_OEMBED_HEIGHT = 150;
const MAX_OEMBED_WIDTH = 1920;
const MAX_OEMBED_HEIGHT = 1080;

const SAFE_ANCESTOR_ORIGIN_RE = /^https:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/i;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

/** Escape text for safe interpolation into HTML text nodes and double-quoted attributes. */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a JSON value for safe embedding inside a `<script>` block. */
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Build a safe `frame-ancestors` CSP directive from a tenant allow-list.
 * Defaults to `'self'` when no origins are configured. Strips unsafe characters and non-https origins.
 * @param {readonly string[] | null | undefined} allowAncestors
 * @returns {string}
 */
export function buildFrameAncestorsDirective(allowAncestors) {
  if (!Array.isArray(allowAncestors) || allowAncestors.length === 0) {
    return "frame-ancestors 'self'";
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of allowAncestors) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item) continue;
    if (item === "'none'") return "frame-ancestors 'none'";
    if (item === "'self'") {
      if (!seen.has("'self'")) {
        seen.add("'self'");
        out.push("'self'");
      }
      continue;
    }
    if (/[\s;"'\r\n<>]/.test(item)) continue;
    if (item === "https:" || SAFE_ANCESTOR_ORIGIN_RE.test(item)) {
      const normalized = item.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
  }
  if (!out.length) return "frame-ancestors 'self'";
  return `frame-ancestors ${out.join(" ")}`;
}

/**
 * Build the full Content-Security-Policy header for `/embed/:board`.
 * @param {readonly string[] | null | undefined} allowAncestors
 * @returns {string}
 */
export function buildEmbedCsp(allowAncestors) {
  const frameAncestors = buildFrameAncestorsDirective(allowAncestors);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    frameAncestors,
  ].join("; ");
}

/**
 * Render OpenGraph, Twitter Card, and oEmbed discovery `<meta>` / `<link>` tags for Slack/Discord/web unfurls.
 * @param {{
 *   title: string,
 *   description?: string,
 *   url: string,
 *   oembedUrl?: string,
 *   imageUrl?: string | null,
 *   siteName?: string,
 * }} meta
 * @returns {string}
 */
export function renderUnfurlMetaTags({
  title,
  description = "Live collaborative whiteboard on Plenary",
  url,
  oembedUrl = "",
  imageUrl = null,
  siteName = "Plenary",
}) {
  const safeTitle = escapeHtml(title || "Plenary Board");
  const safeDesc = escapeHtml(description || "Live collaborative whiteboard on Plenary");
  const safeUrl = escapeHtml(url || "");
  const safeSite = escapeHtml(siteName);
  const lines = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${safeSite}">`,
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDesc}">`,
    `<meta property="og:url" content="${safeUrl}">`,
    `<meta name="twitter:card" content="${imageUrl ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${safeTitle}">`,
    `<meta name="twitter:description" content="${safeDesc}">`,
  ];
  if (typeof imageUrl === "string" && /^https:\/\//i.test(imageUrl)) {
    const safeImg = escapeHtml(imageUrl);
    lines.push(`<meta property="og:image" content="${safeImg}">`);
    lines.push(`<meta name="twitter:image" content="${safeImg}">`);
  }
  if (oembedUrl) {
    lines.push(
      `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${safeTitle}">`,
    );
  }
  return lines.join("\n  ");
}

function clampDim(raw, fallback, min, max) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Extract a board id from `/embed/:board`, `/b/:board`, or `/boards/:board`. */
function extractBoardFromUrl(targetUrl) {
  const m = /^\/(?:embed|b|boards)\/([a-z0-9][a-z0-9-]{0,63})\/?$/i.exec(targetUrl.pathname);
  if (!m) return null;
  const id = m[1].toLowerCase();
  return isId(id) ? id : null;
}

/** Render the minimal, chrome-free read-only iframe HTML shell. */
function renderEmbedShellHtml({ board, title, description, canonicalUrl, oembedUrl, imageUrl, token, wsPath = "/ws" }) {
  const safeTitle = escapeHtml(title);
  const metaTags = renderUnfurlMetaTags({
    title,
    description,
    url: canonicalUrl,
    oembedUrl,
    imageUrl,
  });
  const bootPayload = safeJsonForScript({ board, token, wsPath });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle} — Plenary</title>
  ${metaTags}
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #121216; color: #f4f4f5; font-family: system-ui, -apple-system, sans-serif; }
    #plenary-embed-root { position: relative; width: 100%; height: 100%; }
    #plenary-embed-canvas { display: block; width: 100%; height: 100%; }
    #plenary-embed-badge { position: absolute; right: 10px; bottom: 10px; padding: 4px 10px; border-radius: 9999px; background: rgba(18, 18, 22, 0.82); border: 1px solid rgba(255, 255, 255, 0.14); font-size: 11px; color: #d4d4d8; pointer-events: none; }
  </style>
</head>
<body>
  <div id="plenary-embed-root" data-plenary-embed="readonly" data-board="${escapeHtml(board)}">
    <canvas id="plenary-embed-canvas" aria-label="${safeTitle}"></canvas>
    <div id="plenary-embed-badge" role="status">Plenary · Live Read-only</div>
  </div>
  <script>
    (function () {
      var cfg = ${bootPayload};
      try {
        if (window.history && typeof window.history.replaceState === "function") {
          var clean = new URL(window.location.href);
          clean.searchParams.delete("token");
          window.history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
        }
      } catch (e) {}
      var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      var ws = new WebSocket(proto + "//" + window.location.host + cfg.wsPath);
      ws.addEventListener("open", function () {
        ws.send(JSON.stringify({ t: "hello", board: cfg.board, token: cfg.token, scope: "embed", role: "viewer" }));
      });
      window.__plenaryEmbed = { board: cfg.board, readonly: true, socket: ws };
    })();
  </script>
</body>
</html>`;
}

/**
 * Create the driving HTTP route handler for `/embed/:board` and `/oembed`.
 * @param {{
 *   tokens: ReturnType<typeof import("../../core/auth/embed-token.js").createEmbedTokens>,
 *   resolveBoard: (boardId: string, tenant?: string | null) => Promise<{
 *     id: string,
 *     tenant?: string,
 *     title?: string,
 *     description?: string,
 *     imageUrl?: string | null,
 *     embedPolicy?: { frameAncestors?: readonly string[] } | null,
 *   } | null>,
 *   publicUrl?: string,
 *   frameAncestors?: readonly string[] | null,
 *   log?: { debug?(msg: string, f?: object): void, info(msg: string, f?: object): void, warn(msg: string, f?: object): void, error(msg: string, f?: object): void },
 * }} opts
 */
export function embedRoutes({
  tokens,
  resolveBoard,
  publicUrl = "",
  frameAncestors = null,
  log = quietLogger,
}) {
  if (!tokens || typeof tokens.verify !== "function") {
    throw new TypeError("embedRoutes needs tokens.verify");
  }
  if (typeof resolveBoard !== "function") {
    throw new TypeError("embedRoutes needs resolveBoard");
  }
  const baseOrigin = publicUrl.replace(/\/+$/, "");

  return {
    /**
     * Handle `/embed/:board` and `/oembed`. Returns `undefined` for all other paths.
     * @param {Request} req
     * @param {URL} url
     * @returns {Promise<Response | undefined>}
     */
    async handle(req, url) {
      // 1. GET /oembed?url=...&format=json
      if (url.pathname === "/oembed") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
        }
        const format = (url.searchParams.get("format") ?? "json").toLowerCase();
        if (format !== "json") {
          return json(501, { error: "unsupported-format" });
        }
        const rawTarget = url.searchParams.get("url");
        if (!rawTarget) {
          return json(400, { error: "missing-url" });
        }
        let targetUrl;
        try {
          targetUrl = new URL(rawTarget);
        } catch {
          return json(400, { error: "invalid-url" });
        }
        if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
          return json(400, { error: "invalid-url" });
        }
        if (baseOrigin && targetUrl.origin !== baseOrigin) {
          return json(400, { error: "untrusted-origin" });
        }
        const boardId = extractBoardFromUrl(targetUrl);
        if (!boardId) {
          return json(400, { error: "invalid-board-url" });
        }

        // If target URL carries an embed token, verify it before disclosing board metadata.
        const targetToken = targetUrl.searchParams.get("token");
        let tenant = null;
        if (targetToken) {
          const v = await tokens.verify(targetToken, { board: boardId });
          if (v.ok === false) {
            log.warn("oembed token rejected", { board: boardId, code: v.code });
            return json(v.code === "wrong-board" ? 403 : 401, { error: v.code });
          }
          tenant = v.claims.tenant;
        }

        const board = await resolveBoard(boardId, tenant);
        if (!board) {
          return json(404, { error: "not-found" });
        }

        const width = clampDim(url.searchParams.get("maxwidth"), DEFAULT_OEMBED_WIDTH, MIN_OEMBED_WIDTH, MAX_OEMBED_WIDTH);
        const height = clampDim(url.searchParams.get("maxheight"), DEFAULT_OEMBED_HEIGHT, MIN_OEMBED_HEIGHT, MAX_OEMBED_HEIGHT);
        const origin = baseOrigin || url.origin;
        const iframeSrc = targetToken
          ? `${origin}/embed/${boardId}?token=${encodeURIComponent(targetToken)}`
          : `${origin}/embed/${boardId}`;
        const title = board.title || `Board ${boardId}`;
        const html = `<iframe src="${escapeHtml(iframeSrc)}" width="${width}" height="${height}" frameborder="0" allowfullscreen loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin" title="${escapeHtml(title)}"></iframe>`;

        const payload = {
          version: "1.0",
          type: "rich",
          provider_name: "Plenary",
          provider_url: origin,
          title,
          width,
          height,
          html,
        };
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }
        return json(200, payload);
      }

      // 2. GET /embed/:board
      if (!url.pathname.startsWith("/embed/")) return undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
      }
      const boardId = url.pathname.slice("/embed/".length);
      if (!boardId || boardId.includes("/") || !isId(boardId)) {
        return json(400, { error: "bad-board" });
      }

      const authHeader = req.headers.get("authorization") ?? "";
      const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
      const token = url.searchParams.get("token") || bearer;
      if (!token) {
        return json(401, { error: "missing-token" });
      }

      const verified = await tokens.verify(token, { board: boardId });
      if (verified.ok === false) {
        // Never log the raw token value.
        log.warn("embed token rejected", { board: boardId, code: verified.code });
        const status = verified.code === "wrong-board" || verified.code === "bad-scope" ? 403 : 401;
        return json(status, { error: verified.code });
      }

      const board = await resolveBoard(boardId, verified.claims.tenant);
      if (!board) {
        return json(404, { error: "not-found" });
      }

      const allowedAncestors = board.embedPolicy?.frameAncestors ?? frameAncestors;
      const csp = buildEmbedCsp(allowedAncestors);
      const origin = baseOrigin || url.origin;
      const canonicalUrl = `${origin}/embed/${boardId}`;
      const oembedUrl = `${origin}/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
      const html = renderEmbedShellHtml({
        board: boardId,
        title: board.title || `Board ${boardId}`,
        description: board.description || "Live collaborative whiteboard on Plenary",
        canonicalUrl,
        oembedUrl,
        imageUrl: board.imageUrl ?? null,
        token,
      });

      return new Response(req.method === "HEAD" ? null : html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": csp,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    },
  };
}

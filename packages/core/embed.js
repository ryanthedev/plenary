// @ts-check
// Pure content URL embed parser, sanitizer, tenant allow-list policy, and element builder (Issues #112, #24).
// Strictly pure: no DOM, Node, or network globals. Produces 100% Protocol v1.1-valid
// Excalidraw rectangle elements with `link` and `customData.embed`.

import { BASE_LAYER, makeElement } from "./model.js";

export const MAX_EMBED_URL_LENGTH = 2048;
export const EMBED_DEFAULT_WIDTH = 480;
export const EMBED_DEFAULT_HEIGHT = 270;
export const EMBED_IMAGE_WIDTH = 360;
export const EMBED_IMAGE_HEIGHT = 240;
export const EMBED_DOC_WIDTH = 560;
export const EMBED_DOC_HEIGHT = 400;
export const EMBED_PDF_WIDTH = 480;
export const EMBED_PDF_HEIGHT = 620;
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";
export const FIGMA_EMBED_ORIGIN = "https://www.figma.com";

export const EMBED_SANDBOX = Object.freeze({
  youtube: "allow-scripts allow-same-origin allow-presentation",
  figma: "allow-scripts allow-same-origin allow-popups allow-forms",
  doc: "allow-scripts allow-same-origin allow-popups allow-forms",
  pdf: "allow-scripts allow-same-origin",
});

export const EMBED_PROVIDERS = Object.freeze({
  youtube: Object.freeze({
    id: "youtube",
    name: "YouTube",
    accent: "#FF0033",
    badgeBg: "#FF0033",
    badgeFg: "#FFFFFF",
  }),
  video: Object.freeze({
    id: "video",
    name: "Video",
    accent: "#3B82F6",
    badgeBg: "#2563EB",
    badgeFg: "#FFFFFF",
  }),
  image: Object.freeze({
    id: "image",
    name: "Image",
    accent: "#10B981",
    badgeBg: "#059669",
    badgeFg: "#FFFFFF",
  }),
  figma: Object.freeze({
    id: "figma",
    name: "Figma",
    accent: "#A259FF",
    badgeBg: "#7C3AED",
    badgeFg: "#FFFFFF",
  }),
  doc: Object.freeze({
    id: "doc",
    name: "Document",
    accent: "#4F46E5",
    badgeBg: "#4338CA",
    badgeFg: "#FFFFFF",
  }),
  pdf: Object.freeze({
    id: "pdf",
    name: "PDF",
    accent: "#EF4444",
    badgeBg: "#DC2626",
    badgeFg: "#FFFFFF",
  }),
});

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const WHITESPACE_RE = /\s/;
const UNSAFE_URL_CHAR_RE = /["'<>`]/;
const HTTPS_URL_RE = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;
const BLOB_PDF_REF_RE = /^\/blobs\/([A-Za-z0-9._-]+)(#[^?#]*)?$/;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const FIGMA_KEY_RE = /^[A-Za-z0-9_-]{4,128}$/;
const GOOGLE_DOC_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const MAX_START_SEC = 86400; // 24 hours
const MAX_PDF_PAGE = 10000;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);
const FIGMA_KINDS = Object.freeze({
  file: "Figma File",
  design: "Figma Design",
  board: "FigJam Board",
  proto: "Figma Prototype",
});

const NOTION_HOSTS = new Set(["notion.so", "www.notion.so"]);
const GOOGLE_DOC_KINDS = Object.freeze({
  document: { kind: "google-docs", title: "Google Doc", suffix: "preview" },
  spreadsheets: { kind: "google-sheets", title: "Google Sheet", suffix: "preview" },
  presentation: { kind: "google-slides", title: "Google Slides", suffix: "embed" },
});

/**
 * @typedef {{
 *   defaultDeny?: boolean,
 *   allowDomains?: readonly string[],
 *   allowProviders?: readonly string[],
 *   denyDomains?: readonly string[],
 *   denyProviders?: readonly string[],
 * }} EmbedPolicy
 */

/** Safe URI component decode that never throws. */
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** Sanitize untrusted text for embed card display (strip HTML-like brackets/control chars, collapse spaces). */
export function sanitizeEmbedText(str, maxLen = 96) {
  if (typeof str !== "string") return "";
  let s = str
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) s = s.slice(0, Math.max(1, maxLen - 1)).trimEnd() + "…";
  return s;
}

/**
 * Strictly validate an `https://` URL without host-runtime dependencies.
 * Rejects non-https schemes, `"`, `'`, `<`, `>`, backticks, backslashes, userinfo (`@`),
 * explicit ports (`:`), IPv4 literals, control characters, whitespace, and overly long URLs.
 */
function parseStrictHttpsUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_EMBED_URL_LENGTH) return null;
  if (
    CONTROL_CHAR_RE.test(trimmed) ||
    WHITESPACE_RE.test(trimmed) ||
    UNSAFE_URL_CHAR_RE.test(trimmed) ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  const m = HTTPS_URL_RE.exec(trimmed);
  if (!m) return null;
  const authority = m[1];
  // Reject userinfo (`user:pass@host`) and explicit ports or IPv6 literals (`host:8080`, `[::1]`).
  if (authority.includes("@") || authority.includes(":")) return null;
  const host = authority.toLowerCase();
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) return null;
  // Reject WHATWG URL "ends in a number" IPv4 shorthands (e.g. 127.1, 0x7f.0.0.1, 0177.0.0.1, 10.1).
  const lastLabel = host.slice(host.lastIndexOf(".") + 1);
  if (/^\d+$/.test(lastLabel) || /^0x[0-9a-f]+$/i.test(lastLabel)) return null;
  const path = m[2] ?? "/";
  const query = m[3] ?? "";
  const hash = m[4] ?? "";
  // Reject percent-encoded control chars or quotes/angle brackets in path/query/hash.
  if (/%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(path + query + hash)) return null;
  const segments = path.split("/").filter(Boolean);
  return {
    host,
    path,
    query,
    hash,
    segments,
    url: `https://${host}${path}${query}${hash}`,
    baseUrl: `https://${host}${path}${query}`,
  };
}

/**
 * Strictly validate a first-party signed blob PDF ref (`/blobs/<token>` or `/blobs/<token>#page=N`).
 */
function parseSignedBlobPdfRef(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_EMBED_URL_LENGTH) return null;
  if (
    CONTROL_CHAR_RE.test(trimmed) ||
    WHITESPACE_RE.test(trimmed) ||
    UNSAFE_URL_CHAR_RE.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    return null;
  }
  const m = BLOB_PDF_REF_RE.exec(trimmed);
  if (!m) return null;
  const token = m[1];
  const hash = m[2] ?? "";
  if (/%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(token + hash)) return null;
  return {
    token,
    hash,
    baseUrl: `/blobs/${token}`,
    url: `/blobs/${token}${hash}`,
  };
}

/** Extract a query parameter value from a raw `?a=1&b=2` query string. */
function queryParam(query, name) {
  if (!query || query[0] !== "?") return null;
  const pairs = query.slice(1).split("&");
  for (const pair of pairs) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    if (k === name) return eq < 0 ? "" : safeDecode(pair.slice(eq + 1));
  }
  return null;
}

/**
 * Parse a YouTube timestamp query parameter (`90`, `90s`, `1m30s`, `1h2m30s`).
 * Returns a positive integer number of seconds (clamped to MAX_START_SEC), or `undefined`.
 */
export function parseYouTubeTime(raw) {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (/^\d+s?$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_START_SEC) : undefined;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const total = (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
  return Number.isFinite(total) && total > 0 ? Math.min(total, MAX_START_SEC) : undefined;
}

/**
 * Parse a PDF page fragment (`#page=3`, `#zoom=100&page=12`).
 * Returns a positive integer (1..MAX_PDF_PAGE), or `undefined`.
 * @param {string} hash
 */
export function parsePdfPage(hash) {
  if (typeof hash !== "string" || !hash) return undefined;
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of body.split("&")) {
    const m = /^page=(\d+)$/i.exec(part.trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) return Math.min(n, MAX_PDF_PAGE);
    }
  }
  return undefined;
}

/** Extract a clean display title from the last path segment of a media URL. */
function filenameTitle(segments, fallback) {
  if (!segments.length) return fallback;
  const raw = safeDecode(segments[segments.length - 1]);
  const clean = sanitizeEmbedText(raw, 72);
  return clean || fallback;
}

/** Extract a clean title from a slug segment (hyphens/underscores to spaces). */
function slugTitle(seg, fallback) {
  if (!seg) return fallback;
  const decoded = safeDecode(seg).replace(/[-_]+/g, " ");
  const clean = sanitizeEmbedText(decoded, 72);
  return clean || fallback;
}

/** Check whether `host` matches a domain pattern (`example.com` matches exact + subdomains; `*.example.com` matches subdomains only). */
function matchesDomainPattern(host, pattern) {
  if (typeof host !== "string" || typeof pattern !== "string") return false;
  const h = host.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!h || !p) return false;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    if (!base || !HOSTNAME_RE.test(base)) return false;
    return h.length > base.length + 1 && h.endsWith("." + base);
  }
  if (p === "self") return h === "self";
  if (!HOSTNAME_RE.test(p)) return false;
  return h === p || h.endsWith("." + p);
}

function listMatchesDomain(host, list) {
  if (!Array.isArray(list) || !list.length) return false;
  return list.some(pattern => matchesDomainPattern(host, pattern));
}

function listMatchesProvider(provider, list) {
  if (!provider || !Array.isArray(list) || !list.length) return false;
  const p = String(provider).toLowerCase();
  return list.some(item => typeof item === "string" && item.trim().toLowerCase() === p);
}

/**
 * Evaluate a URL against a tenant embed allow-list policy.
 * Supports `allowDomains`, `allowProviders`, `denyDomains`, `denyProviders`, and `defaultDeny`.
 * Pure and side-effect-free.
 * @param {string} raw
 * @param {EmbedPolicy | null | undefined} [policy]
 * @param {string | null} [providerHint]
 * @returns {{ allowed: boolean, reason: string, host?: string, provider?: string | null }}
 */
export function checkEmbedPolicy(raw, policy = null, providerHint = null) {
  const blobRef = parseSignedBlobPdfRef(raw);
  const https = blobRef ? null : parseStrictHttpsUrl(raw);
  if (!blobRef && !https) {
    return { allowed: false, reason: "invalid-url" };
  }
  const host = blobRef ? "self" : https.host;
  const detected = providerHint ?? parseEmbedUrlWithoutPolicy(raw)?.provider ?? (blobRef ? "pdf" : null);

  if (!policy || typeof policy !== "object") {
    return { allowed: true, reason: "no-policy", host, provider: detected };
  }

  if (listMatchesDomain(host, policy.denyDomains)) {
    return { allowed: false, reason: "domain-denied", host, provider: detected };
  }
  if (listMatchesProvider(detected, policy.denyProviders)) {
    return { allowed: false, reason: "provider-denied", host, provider: detected };
  }

  const hasDomainAllow = Array.isArray(policy.allowDomains) && policy.allowDomains.length > 0;
  const hasProviderAllow = Array.isArray(policy.allowProviders) && policy.allowProviders.length > 0;
  const enforceAllowList = policy.defaultDeny === true || hasDomainAllow || hasProviderAllow;

  if (!enforceAllowList) {
    return { allowed: true, reason: "allowed", host, provider: detected };
  }

  const domainAllowed = hasDomainAllow && listMatchesDomain(host, policy.allowDomains);
  const providerAllowed = hasProviderAllow && listMatchesProvider(detected, policy.allowProviders);

  if (domainAllowed || providerAllowed) {
    return { allowed: true, reason: domainAllowed ? "domain-allowed" : "provider-allowed", host, provider: detected };
  }

  return {
    allowed: false,
    reason: policy.defaultDeny ? "default-deny" : "not-in-allowlist",
    host,
    provider: detected,
  };
}

/**
 * Boolean convenience wrapper for tenant embed allow-list checks.
 * @param {string} raw
 * @param {EmbedPolicy | null | undefined} [policy]
 * @param {string | null} [providerHint]
 * @returns {boolean}
 */
export function isEmbedAllowed(raw, policy = null, providerHint = null) {
  return checkEmbedPolicy(raw, policy, providerHint).allowed;
}

/** Internal parser for known built-in providers (without generic policy-gated docs). */
function parseEmbedUrlWithoutPolicy(raw) {
  // 0. First-party signed PDF blob ref (`/blobs/<token>#page=N`)
  const blob = parseSignedBlobPdfRef(raw);
  if (blob) {
    const page = parsePdfPage(blob.hash);
    const embedUrl = page ? `${blob.baseUrl}#page=${page}` : blob.baseUrl;
    return {
      provider: "pdf",
      providerName: EMBED_PROVIDERS.pdf.name,
      url: embedUrl,
      embedUrl,
      host: "self",
      title: page ? `PDF Document (p. ${page})` : "PDF Document",
      sandbox: EMBED_SANDBOX.pdf,
      isBlobRef: true,
      ...(page ? { page } : {}),
    };
  }

  const u = parseStrictHttpsUrl(raw);
  if (!u) return null;
  const { host, query, hash, segments } = u;

  // 1. YouTube
  if (YOUTUBE_HOSTS.has(host)) {
    let videoId = null;
    if (host === "youtu.be" || host === "www.youtu.be") {
      if (segments.length === 1) videoId = segments[0];
    } else if (segments.length === 1 && segments[0] === "watch") {
      videoId = queryParam(query, "v");
    } else if (segments.length === 2 && (segments[0] === "shorts" || segments[0] === "embed")) {
      videoId = segments[1];
    }
    if (!videoId || !YOUTUBE_ID_RE.test(videoId)) return null;
    const startSec = parseYouTubeTime(queryParam(query, "t") ?? queryParam(query, "start") ?? "");
    const embedUrl = `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}?rel=0${startSec ? `&start=${startSec}` : ""}`;
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}${startSec ? `&t=${startSec}` : ""}`;
    return {
      provider: "youtube",
      providerName: EMBED_PROVIDERS.youtube.name,
      url: canonicalUrl,
      embedUrl,
      videoId,
      host: "youtube.com",
      title: "YouTube Video",
      sandbox: EMBED_SANDBOX.youtube,
      ...(startSec ? { startSec } : {}),
    };
  }

  // 2. Figma (file, design, board, proto)
  if (FIGMA_HOSTS.has(host) && segments.length >= 2) {
    const kind = segments[0].toLowerCase();
    const fileKey = segments[1];
    if (kind in FIGMA_KINDS && FIGMA_KEY_RE.test(fileKey)) {
      const canonicalUrl = `https://www.figma.com/${kind}/${fileKey}${segments[2] ? "/" + segments[2] : ""}${query}${hash}`;
      const embedUrl = `${FIGMA_EMBED_ORIGIN}/embed?embed_host=plenary&url=${encodeURIComponent(canonicalUrl)}`;
      return {
        provider: "figma",
        providerName: EMBED_PROVIDERS.figma.name,
        url: canonicalUrl,
        embedUrl,
        host: "figma.com",
        figmaKind: kind,
        fileKey,
        title: segments[2] ? slugTitle(segments[2], FIGMA_KINDS[kind]) : FIGMA_KINDS[kind],
        sandbox: EMBED_SANDBOX.figma,
      };
    }
  }

  // 3. Google Docs / Sheets / Slides
  if (host === "docs.google.com" && segments.length >= 3 && segments[1] === "d") {
    const spec = GOOGLE_DOC_KINDS[segments[0].toLowerCase()];
    const docId = segments[2];
    if (spec && GOOGLE_DOC_ID_RE.test(docId)) {
      const canonicalUrl = `https://docs.google.com/${segments[0].toLowerCase()}/d/${docId}/${spec.suffix}`;
      return {
        provider: "doc",
        providerName: EMBED_PROVIDERS.doc.name,
        docKind: spec.kind,
        docId,
        url: u.url,
        embedUrl: canonicalUrl,
        host: "docs.google.com",
        title: spec.title,
        sandbox: EMBED_SANDBOX.doc,
      };
    }
  }

  // 4. Notion public embeds (notion.so, www.notion.so, *.notion.site)
  if ((NOTION_HOSTS.has(host) || host.endsWith(".notion.site")) && segments.length >= 1) {
    const last = segments[segments.length - 1];
    const withoutId = last.replace(/-[0-9a-f]{32}$/i, "");
    const title = slugTitle(withoutId || last, "Notion Page");
    return {
      provider: "doc",
      providerName: EMBED_PROVIDERS.doc.name,
      docKind: "notion",
      url: u.url,
      embedUrl: u.url,
      host,
      title,
      sandbox: EMBED_SANDBOX.doc,
    };
  }

  const lastSeg = segments.length ? segments[segments.length - 1] : "";

  // 5. Direct PDF URL (.pdf with optional #page=N)
  if (lastSeg && PDF_EXT_RE.test(lastSeg) && lastSeg.indexOf(".") > 0) {
    const page = parsePdfPage(hash);
    const embedUrl = page ? `${u.baseUrl}#page=${page}` : u.baseUrl;
    return {
      provider: "pdf",
      providerName: EMBED_PROVIDERS.pdf.name,
      url: page ? `${u.baseUrl}#page=${page}` : u.url,
      embedUrl,
      host,
      title: filenameTitle(segments, "PDF Document"),
      sandbox: EMBED_SANDBOX.pdf,
      ...(page ? { page } : {}),
    };
  }

  // 6. Direct Video URL (.mp4, .webm, .mov)
  if (lastSeg && VIDEO_EXT_RE.test(lastSeg) && lastSeg.indexOf(".") > 0) {
    return {
      provider: "video",
      providerName: EMBED_PROVIDERS.video.name,
      url: u.url,
      embedUrl: u.url,
      host,
      title: filenameTitle(segments, "Video"),
    };
  }

  // 7. Direct Image URL (.png, .jpg, .jpeg, .webp, .gif)
  if (lastSeg && IMAGE_EXT_RE.test(lastSeg) && lastSeg.indexOf(".") > 0) {
    return {
      provider: "image",
      providerName: EMBED_PROVIDERS.image.name,
      url: u.url,
      embedUrl: u.url,
      host,
      title: filenameTitle(segments, "Image"),
    };
  }

  return null;
}

/**
 * Parse a YouTube, Figma, Document (Google Docs/Slides/Sheets, Notion, or allow-listed HTTPS doc),
 * PDF (`.pdf` or signed `/blobs/...` ref with `#page=N`), direct video, or direct image URL into
 * normalized, sandboxed embed metadata.
 * Returns `null` if the input is not a strictly valid, supported URL (or disallowed when `opts.enforcePolicy` is true).
 * @param {string} raw
 * @param {{ policy?: EmbedPolicy | null, enforcePolicy?: boolean }} [opts]
 */
export function parseEmbedUrl(raw, opts = {}) {
  const policy = opts?.policy ?? null;
  let parsed = parseEmbedUrlWithoutPolicy(raw);

  // Generic HTTPS document embed when explicitly allow-listed by tenant `allowDomains`.
  if (!parsed && policy && Array.isArray(policy.allowDomains) && policy.allowDomains.length > 0) {
    const u = parseStrictHttpsUrl(raw);
    if (u && listMatchesDomain(u.host, policy.allowDomains) && !listMatchesDomain(u.host, policy.denyDomains)) {
      parsed = {
        provider: "doc",
        providerName: EMBED_PROVIDERS.doc.name,
        docKind: "generic",
        url: u.url,
        embedUrl: u.url,
        host: u.host,
        title: filenameTitle(u.segments, u.host),
        sandbox: EMBED_SANDBOX.doc,
      };
    }
  }

  if (!parsed) return null;
  if (opts?.enforcePolicy && policy && !isEmbedAllowed(parsed.url, policy, parsed.provider)) {
    return null;
  }
  return parsed;
}

/** Return a strictly validated canonical embed URL, or `null`. */
export function safeEmbedUrl(raw, opts = {}) {
  return parseEmbedUrl(raw, opts)?.url ?? null;
}

/**
 * Build a 100% Protocol v1.1-valid Excalidraw `rectangle` element representing a media/content embed card.
 * Accepts either a parsed embed object from `parseEmbedUrl` or a raw URL string; always re-parses.
 * When `opts.policy` is provided, enforces the tenant allow-list at insert time (returns `null` if disallowed).
 */
export function buildEmbedElement(parsedOrUrl, opts = {}) {
  const rawUrl = typeof parsedOrUrl === "string" ? parsedOrUrl : parsedOrUrl?.url;
  const policy = opts?.policy ?? null;
  const parsed = parseEmbedUrl(rawUrl, { policy, enforcePolicy: Boolean(policy) });
  if (!parsed) return null;

  let defaultW = EMBED_DEFAULT_WIDTH;
  let defaultH = EMBED_DEFAULT_HEIGHT;
  if (parsed.provider === "image") {
    defaultW = EMBED_IMAGE_WIDTH;
    defaultH = EMBED_IMAGE_HEIGHT;
  } else if (parsed.provider === "doc" || parsed.provider === "figma") {
    defaultW = EMBED_DOC_WIDTH;
    defaultH = EMBED_DOC_HEIGHT;
  } else if (parsed.provider === "pdf") {
    defaultW = EMBED_PDF_WIDTH;
    defaultH = EMBED_PDF_HEIGHT;
  }

  const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : defaultW;
  const height = Number.isFinite(opts.height) && opts.height > 0 ? opts.height : defaultH;
  const x = Number.isFinite(opts.x) ? opts.x : 0;
  const y = Number.isFinite(opts.y) ? opts.y : 0;
  const title = opts.title ? sanitizeEmbedText(opts.title, 96) || parsed.title : parsed.title;

  /** @type {Record<string, any>} */
  const embedData = {
    version: 1,
    provider: parsed.provider,
    url: parsed.url,
    embedUrl: parsed.embedUrl,
    title,
  };
  /** @type {any} */
  const p = parsed;
  if (p.videoId) embedData.videoId = p.videoId;
  if (p.startSec) embedData.startSec = p.startSec;
  if (p.page) embedData.page = p.page;
  if (p.figmaKind) embedData.figmaKind = p.figmaKind;
  if (p.fileKey) embedData.fileKey = p.fileKey;
  if (p.docKind) embedData.docKind = p.docKind;

  const fields = {
    x,
    y,
    width,
    height,
    strokeColor: "#2e2e38",
    backgroundColor: "#121216",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 3 },
    opacity: 100,
    link: parsed.url,
    customData: {
      layer: opts.layer ?? BASE_LAYER,
      z: Number.isFinite(opts.z) ? opts.z : 0,
      embed: embedData,
    },
  };
  if (typeof opts.id === "string" && opts.id.length > 0 && opts.id.length <= 64) fields.id = opts.id;
  return makeElement("rectangle", fields);
}

/**
 * Detect and parse content embed metadata from a board element.
 * Returns parsed metadata ONLY when `el.customData?.embed` is explicitly present.
 * Always re-validates the URL with `parseEmbedUrl` so tampered `customData` can never
 * inject unsafe origins, non-https URLs, or spoofed providers.
 * @param {any} el
 * @param {{ policy?: EmbedPolicy | null }} [opts]
 */
export function parseEmbedFromElement(el, opts = {}) {
  if (!el || el.type !== "rectangle") return null;
  const custom = el.customData?.embed;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const rawUrl = typeof el.link === "string" && el.link ? el.link : (typeof custom.url === "string" ? custom.url : "");
  if (!rawUrl) return null;
  const parsed = parseEmbedUrl(rawUrl, { policy: opts?.policy ?? null });
  if (!parsed) return null;
  const customTitle = typeof custom.title === "string" ? sanitizeEmbedText(custom.title, 96) : "";
  return {
    ...parsed,
    title: customTitle || parsed.title,
    meta: EMBED_PROVIDERS[parsed.provider],
  };
}

export const isEmbedElement = (el, opts = {}) => parseEmbedFromElement(el, opts) !== null;

/**
 * Local (unrotated) hit rectangle for the centered play medallion on an embed poster card,
 * or `null` when the card is too small.
 */
export function embedPlayButtonRect(el) {
  const x = Math.min(el.x, el.x + el.width);
  const y = Math.min(el.y, el.y + el.height);
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  if (w < 48 || h < 36) return null;
  const footerH = h >= 88 ? Math.min(44, Math.max(26, h * 0.22)) : 0;
  const stageH = Math.max(24, h - footerH);
  const size = Math.min(56, Math.max(22, Math.min(w, stageH) * 0.32));
  return {
    x: x + (w - size) / 2,
    y: y + (stageH - size) / 2,
    w: size,
    h: size,
  };
}

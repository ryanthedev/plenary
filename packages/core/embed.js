// @ts-check
// Pure YouTube & direct media URL embed parser, sanitizer, and element builder (Issue #112).
// Strictly pure: no DOM, Node, or network globals. Produces 100% Protocol v1.1-valid
// Excalidraw rectangle elements with `link` and `customData.embed`.

import { BASE_LAYER, makeElement } from "./model.js";

export const MAX_EMBED_URL_LENGTH = 2048;
export const EMBED_DEFAULT_WIDTH = 480;
export const EMBED_DEFAULT_HEIGHT = 270;
export const EMBED_IMAGE_WIDTH = 360;
export const EMBED_IMAGE_HEIGHT = 240;
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

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
});

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const WHITESPACE_RE = /\s/;
const UNSAFE_URL_CHAR_RE = /["'<>`]/;
const HTTPS_URL_RE = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif)$/i;
const MAX_START_SEC = 86400; // 24 hours

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

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

/** Extract a clean display title from the last path segment of a media URL. */
function filenameTitle(segments, fallback) {
  if (!segments.length) return fallback;
  const raw = safeDecode(segments[segments.length - 1]);
  const clean = sanitizeEmbedText(raw, 72);
  return clean || fallback;
}

/**
 * Parse a YouTube, direct video (`.mp4`/`.webm`/`.mov`), or direct image
 * (`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`) `https://` URL into normalized embed metadata.
 * Returns `null` if the input is not a strictly valid, supported `https://` URL.
 * @param {string} raw
 * @returns {{ provider: "youtube" | "video" | "image", providerName: string, url: string, embedUrl: string, host: string, title: string, videoId?: string, startSec?: number } | null}
 */
export function parseEmbedUrl(raw) {
  const u = parseStrictHttpsUrl(raw);
  if (!u) return null;
  const { host, path, query, segments } = u;

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
      ...(startSec ? { startSec } : {}),
    };
  }

  // 2. Direct Video URL (.mp4, .webm, .mov)
  const lastSeg = segments.length ? segments[segments.length - 1] : "";
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

  // 3. Direct Image URL (.png, .jpg, .jpeg, .webp, .gif)
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

/** Return a strictly validated canonical `https://` embed URL, or `null`. */
export function safeEmbedUrl(raw) {
  return parseEmbedUrl(raw)?.url ?? null;
}

/**
 * Build a 100% Protocol v1.1-valid Excalidraw `rectangle` element representing a media embed card.
 * Accepts either a parsed embed object from `parseEmbedUrl` or a raw URL string; always re-parses.
 */
export function buildEmbedElement(parsedOrUrl, opts = {}) {
  const rawUrl = typeof parsedOrUrl === "string" ? parsedOrUrl : parsedOrUrl?.url;
  const parsed = parseEmbedUrl(rawUrl);
  if (!parsed) return null;

  const isImg = parsed.provider === "image";
  const defaultW = isImg ? EMBED_IMAGE_WIDTH : EMBED_DEFAULT_WIDTH;
  const defaultH = isImg ? EMBED_IMAGE_HEIGHT : EMBED_DEFAULT_HEIGHT;
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
  if (parsed.videoId) embedData.videoId = parsed.videoId;
  if (parsed.startSec) embedData.startSec = parsed.startSec;

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
 * Detect and parse media embed metadata from a board element.
 * Returns parsed metadata ONLY when `el.customData?.embed` is explicitly present.
 * Always re-validates the URL with `parseEmbedUrl` so tampered `customData` can never
 * inject unsafe origins, non-https URLs, or spoofed providers.
 */
export function parseEmbedFromElement(el) {
  if (!el || el.type !== "rectangle") return null;
  const custom = el.customData?.embed;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const rawUrl = typeof el.link === "string" && el.link ? el.link : (typeof custom.url === "string" ? custom.url : "");
  if (!rawUrl) return null;
  const parsed = parseEmbedUrl(rawUrl);
  if (!parsed) return null;
  const customTitle = typeof custom.title === "string" ? sanitizeEmbedText(custom.title, 96) : "";
  return {
    ...parsed,
    title: customTitle || parsed.title,
    meta: EMBED_PROVIDERS[parsed.provider],
  };
}

export const isEmbedElement = el => parseEmbedFromElement(el) !== null;

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

// @ts-check
// Pure Jira, Linear & GitHub rich link card URL parser, sanitizer, and element builder.
// Strictly pure: no DOM, Node, or network globals. Produces 100% protocol v1.1-valid
// Excalidraw rectangle elements with `link` and `customData.linkCard`.

import { BASE_LAYER, makeElement } from "./model.js";

export const MAX_LINK_CARD_URL_LENGTH = 2048;
export const LINK_CARD_WIDTH = 340;
export const LINK_CARD_HEIGHT = 112;
export const LINK_CARD_OPEN_BADGE_SIZE = 24;
export const LINK_CARD_OPEN_BADGE_PAD = 12;

export const LINK_CARD_PROVIDERS = Object.freeze({
  github: Object.freeze({
    id: "github",
    name: "GitHub",
    accent: "#24292F",
    accentDark: "#E6EDF3",
    badgeBg: "#24292F",
    badgeBgDark: "#30363D",
    badgeFg: "#FFFFFF",
    pillBg: "#EAEEF2",
    pillBgDark: "#2D333B",
    pillFg: "#24292F",
    pillFgDark: "#CDD9E5",
  }),
  linear: Object.freeze({
    id: "linear",
    name: "Linear",
    accent: "#5E6AD2",
    accentDark: "#818CF8",
    badgeBg: "#5E6AD2",
    badgeBgDark: "#5E6AD2",
    badgeFg: "#FFFFFF",
    pillBg: "#EEF0FF",
    pillBgDark: "#2A2E52",
    pillFg: "#4338CA",
    pillFgDark: "#C7D2FE",
  }),
  jira: Object.freeze({
    id: "jira",
    name: "Jira",
    accent: "#0052CC",
    accentDark: "#4C9AFF",
    badgeBg: "#0052CC",
    badgeBgDark: "#0052CC",
    badgeFg: "#FFFFFF",
    pillBg: "#E9F2FF",
    pillBgDark: "#1C2E4A",
    pillFg: "#0052CC",
    pillFgDark: "#85B8FF",
  }),
});

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const WHITESPACE_RE = /\s/;
const UNSAFE_URL_CHAR_RE = /["<>]/;
const HTTPS_URL_RE = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_NUM_RE = /^[1-9][0-9]{0,9}$/;
const GITHUB_PR_SUBPATHS = new Set(["files", "commits", "checks"]);
const LINEAR_WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LINEAR_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-[1-9][0-9]{0,9}$/;
const JIRA_HOST_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/;
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,9}$/;

/** Safe URI component decode that never throws and rejects control characters. */
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** Sanitize untrusted text for card display (strip HTML-like brackets/control chars, collapse spaces). */
export function sanitizeCardText(str, maxLen = 96) {
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

/** Convert a URL slug like "fix-login-timeout-on-safari" into a clean display title. */
function slugToTitle(rawSlug) {
  if (typeof rawSlug !== "string" || !rawSlug) return "";
  const decoded = safeDecode(rawSlug);
  const spaced = decoded.replace(/[-_]+/g, " ");
  const clean = sanitizeCardText(spaced, 96);
  if (!clean) return "";
  return clean === clean.toLowerCase() ? clean[0].toUpperCase() + clean.slice(1) : clean;
}

/**
 * Strictly validate an `https://` URL without host-runtime dependencies.
 * Rejects non-https schemes, userinfo credentials, non-default ports, backslashes,
 * control characters, embedded whitespace, and overly long URLs.
 */
function parseStrictHttpsUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LINK_CARD_URL_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(trimmed) || WHITESPACE_RE.test(trimmed) || UNSAFE_URL_CHAR_RE.test(trimmed) || trimmed.includes("\\")) return null;
  const m = HTTPS_URL_RE.exec(trimmed);
  if (!m) return null;
  const authority = m[1];
  // Reject userinfo (`user:pass@host`) and explicit ports (`host:8080`).
  if (authority.includes("@") || authority.includes(":")) return null;
  const host = authority.toLowerCase();
  if (!HOSTNAME_RE.test(host)) return null;
  const path = m[2] ?? "/";
  const query = m[3] ?? "";
  const hash = m[4] ?? "";
  // Reject percent-encoded control chars in path/query/hash.
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
 * Parse a single Jira, Linear, or GitHub issue/PR/discussion URL into structured card metadata.
 * Returns `null` if the input is not a strictly valid, supported `https://` URL.
 */
export function parseLinkCardUrl(raw) {
  const u = parseStrictHttpsUrl(raw);
  if (!u) return null;
  const { host, segments, query } = u;

  // 1. GitHub: https://github.com/<owner>/<repo>/(issues|pull|discussions)/<num>
  if (host === "github.com" || host === "www.github.com") {
    if (segments.length < 4 || segments.length > 5) return null;
    const [owner, repo, section, num, extra] = segments;
    if (!GITHUB_OWNER_RE.test(owner)) return null;
    if (!GITHUB_REPO_RE.test(repo) || repo === "." || repo === "..") return null;
    if (!GITHUB_NUM_RE.test(num)) return null;
    const kind = section === "issues" ? "Issue" : section === "pull" ? "PR" : section === "discussions" ? "Discussion" : null;
    if (!kind) return null;
    if (extra !== undefined && !(section === "pull" && GITHUB_PR_SUBPATHS.has(extra))) return null;
    const canonicalHost = "github.com";
    const canonicalUrl = `https://${canonicalHost}${u.path}${u.query}${u.hash}`;
    const subtitle = `${owner}/${repo}`;
    const key = `${subtitle}#${num}`;
    return {
      provider: "github",
      providerName: LINK_CARD_PROVIDERS.github.name,
      kind,
      key,
      shortKey: `#${num}`,
      subtitle,
      title: `${kind} #${num} · ${subtitle}`,
      url: canonicalUrl,
      displayUrl: `${canonicalHost}/${subtitle}/${section}/${num}`,
    };
  }

  // 2. Linear: https://linear.app/<workspace>/issue/<TEAM-123>[/<slug>]
  if (host === "linear.app" || host === "www.linear.app") {
    if (segments.length < 3 || segments.length > 4) return null;
    const [workspace, section, rawKey, rawSlug] = segments;
    if (!LINEAR_WORKSPACE_RE.test(workspace) || section !== "issue") return null;
    if (!LINEAR_KEY_RE.test(rawKey)) return null;
    const key = rawKey.toUpperCase();
    const slugTitle = rawSlug ? slugToTitle(rawSlug) : "";
    const title = slugTitle || `${workspace} / ${key}`;
    const canonicalHost = "linear.app";
    const canonicalUrl = `https://${canonicalHost}${u.path}${u.query}${u.hash}`;
    return {
      provider: "linear",
      providerName: LINK_CARD_PROVIDERS.linear.name,
      kind: "Issue",
      key,
      shortKey: key,
      subtitle: workspace,
      title,
      url: canonicalUrl,
      displayUrl: `${canonicalHost}/${workspace}/issue/${key}`,
    };
  }

  // 3. Jira: https://<subdomain>.atlassian.net/browse/<PROJ-123>
  //       or https://<subdomain>.atlassian.net/jira/...?selectedIssue=<PROJ-123>
  //       or https://<subdomain>.atlassian.net/jira/.../selectedIssue=<PROJ-123>
  const jiraHost = JIRA_HOST_RE.exec(host);
  if (jiraHost) {
    let rawKey = null;
    if (segments.length === 2 && segments[0] === "browse") {
      rawKey = segments[1];
    } else if (segments.length >= 2 && segments[0] === "jira") {
      rawKey = queryParam(query, "selectedIssue");
      if (!rawKey) {
        const seg = segments.find(s => s.startsWith("selectedIssue="));
        if (seg) rawKey = safeDecode(seg.slice("selectedIssue=".length));
      }
    }
    if (!rawKey || !JIRA_KEY_RE.test(rawKey)) return null;
    const key = rawKey.toUpperCase();
    return {
      provider: "jira",
      providerName: LINK_CARD_PROVIDERS.jira.name,
      kind: "Issue",
      key,
      shortKey: key,
      subtitle: host,
      title: `${key} · Jira Issue`,
      url: u.url,
      displayUrl: `${host}/browse/${key}`,
    };
  }

  return null;
}

/** Return a strictly validated `https://` URL for a supported link card, or `null`. */
export function safeLinkCardUrl(raw) {
  return parseLinkCardUrl(raw)?.url ?? null;
}

/**
 * Build a 100% protocol v1.1-valid Excalidraw `rectangle` element representing a rich link card.
 * Accepts either a parsed link-card object from `parseLinkCardUrl` or a raw URL string.
 */
export function buildLinkCard(parsedOrUrl, opts = {}) {
  const parsed = typeof parsedOrUrl === "string" ? parseLinkCardUrl(parsedOrUrl) : (parsedOrUrl?.url ? parseLinkCardUrl(parsedOrUrl.url) : null);
  if (!parsed) return null;
  const meta = LINK_CARD_PROVIDERS[parsed.provider];
  const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : LINK_CARD_WIDTH;
  const height = Number.isFinite(opts.height) && opts.height > 0 ? opts.height : LINK_CARD_HEIGHT;
  const x = Number.isFinite(opts.x) ? opts.x : 0;
  const y = Number.isFinite(opts.y) ? opts.y : 0;
  const title = opts.title ? sanitizeCardText(opts.title, 96) || parsed.title : parsed.title;
  const fields = {
    x,
    y,
    width,
    height,
    strokeColor: meta.accent,
    backgroundColor: "#ffffff",
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
      linkCard: {
        version: 1,
        provider: parsed.provider,
        kind: parsed.kind,
        key: parsed.key,
        title,
        subtitle: parsed.subtitle,
      },
    },
  };
  if (typeof opts.id === "string" && opts.id.length > 0 && opts.id.length <= 64) fields.id = opts.id;
  return makeElement("rectangle", fields);
}

/**
 * Detect and parse rich link card metadata from a board element.
 * Always re-validates `el.link` with `parseLinkCardUrl` so tampered `customData`
 * can never inject unsafe URLs or spoof providers.
 */
export function parseLinkCardFromElement(el) {
  if (!el || el.type !== "rectangle" || typeof el.link !== "string" || !el.link) return null;
  // Only recognize explicit Plenary rich link cards (`customData.linkCard`); never hijack
  // arbitrary imported Excalidraw rectangles that happen to carry a Jira/Linear/GitHub `link`.
  const custom = el.customData?.linkCard;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const parsed = parseLinkCardUrl(el.link);
  if (!parsed) return null;
  const customTitle = typeof custom.title === "string" ? sanitizeCardText(custom.title, 96) : "";
  return {
    ...parsed,
    title: customTitle || parsed.title,
    meta: LINK_CARD_PROVIDERS[parsed.provider],
  };
}

export const isLinkCard = el => parseLinkCardFromElement(el) !== null;

/**
 * Local (unrotated) hit rectangle for the top-right open-link (`↗`) badge on a rich link card,
 * or `null` when the card is too small to display the badge inside its bounds.
 * Shared by `render.js` (drawing) and `editor.js` / `app.js` (hit-testing & pointer cursor).
 */
export function linkCardOpenBadgeRect(el) {
  const x = Math.min(el.x, el.x + el.width);
  const y = Math.min(el.y, el.y + el.height);
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  if (w < 32 || h < 24) return null;
  const pad = Math.min(LINK_CARD_OPEN_BADGE_PAD, Math.max(2, Math.min(w, h) * 0.12));
  const maxSize = Math.min(w - pad * 2, h - pad * 2);
  if (maxSize < 12) return null;
  const size = Math.min(LINK_CARD_OPEN_BADGE_SIZE, maxSize, Math.max(12, Math.min(w, h) * 0.28));
  return { x: x + w - pad - size, y: y + pad, w: size, h: size };
}

/** Test whether a scene point `p` (accounting for element rotation) hits the card's `↗` open badge. */
export function isPointInLinkCardOpenAction(el, p, pad = 4) {
  if (!isLinkCard(el) || !p) return false;
  const r = linkCardOpenBadgeRect(el);
  if (!r) return false;
  const x = Math.min(el.x, el.x + el.width);
  const y = Math.min(el.y, el.y + el.height);
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  let lx = p.x, ly = p.y;
  const a = el.angle || 0;
  if (a) {
    const cx = x + w / 2, cy = y + h / 2;
    const s = Math.sin(-a), c = Math.cos(-a);
    const dx = p.x - cx, dy = p.y - cy;
    lx = cx + dx * c - dy * s;
    ly = cy + dx * s + dy * c;
  }
  if (lx < x || lx > x + w || ly < y || ly > y + h) return false;
  return lx >= r.x - pad && lx <= r.x + r.w + pad && ly >= r.y - pad && ly <= r.y + r.h + pad;
}

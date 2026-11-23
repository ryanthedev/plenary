// @ts-check
// Click-to-activate DOM overlay manager for content embeds: YouTube, Figma, docs, PDF pages, and direct media (Issues #112, #24).
// Modeled on web/adapters/dom/video-overlay.js:
// - Mounts ZERO iframes or remote media elements until the user explicitly clicks Play/Open (or calls activate(id)),
//   preventing viewer waves from hammering external hosts.
// - Enforces tenant embed allow-list policy at render and activation time, showing a clear blocked notice when disallowed.
// - Once activated, mounts a tightly sandboxed <iframe> (or mobile-safe `<video controls playsinline>` / `<img>`),
//   synced to camera pan/zoom, with a Close button to return immediately to the lightweight 60fps canvas poster card.
//
// Hexagonal boundary: DOM adapter only (lives under web/adapters/dom/). No imports from other adapters.

import {
  parseEmbedFromElement,
  isEmbedAllowed,
  YOUTUBE_EMBED_ORIGIN,
  FIGMA_EMBED_ORIGIN,
  EMBED_SANDBOX,
} from "../../../packages/core/embed.js";

const YOUTUBE_EMBED_PREFIX = `${YOUTUBE_EMBED_ORIGIN}/embed/`;
const FIGMA_EMBED_PREFIX = `${FIGMA_EMBED_ORIGIN}/embed?`;
const IFRAME_SANDBOX = EMBED_SANDBOX.youtube;
const IFRAME_ALLOW = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen";

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

/**
 * Pure world-to-screen geometry for an embed card element.
 * Mirrors packages/core/geometry.js `bbox` + packages/core/render.js `project`.
 * @param {{ x: number, y: number, width: number, height: number, angle?: number }} el
 * @param {{ x: number, y: number, scale: number }} view
 */
export function embedScreenRect(el, view) {
  const bx = Math.min(num(el.x), num(el.x) + num(el.width));
  const by = Math.min(num(el.y), num(el.y) + num(el.height));
  const bw = Math.abs(num(el.width));
  const bh = Math.abs(num(el.height));
  const s = num(view?.scale, 1);
  const vx = num(view?.x, 0);
  const vy = num(view?.y, 0);
  const left = (bx + vx) * s;
  const top = (by + vy) * s;
  const w = bw * s;
  const h = bh * s;
  const angle = num(el.angle, 0);
  const cx = left + w / 2;
  const cy = top + h / 2;
  return {
    left,
    top,
    w,
    h,
    angle,
    cx,
    cy,
    transform: `translate3d(${left}px, ${top}px, 0) rotate(${angle}rad)`,
  };
}

/**
 * Axis-aligned viewport culling test for a (possibly rotated) screen rect.
 * @param {{ left: number, top: number, w: number, h: number, angle: number, cx: number, cy: number }} rect
 * @param {{ w: number, h: number }} viewport
 * @param {number} [margin]
 */
export function isEmbedVisible(rect, viewport, margin = 64) {
  const vw = num(viewport?.w, 0);
  const vh = num(viewport?.h, 0);
  if (vw <= 0 || vh <= 0 || rect.w < 1 || rect.h < 1) return false;
  let x0 = rect.left;
  let y0 = rect.top;
  let x1 = rect.left + rect.w;
  let y1 = rect.top + rect.h;
  if (rect.angle) {
    const c = Math.abs(Math.cos(rect.angle));
    const s = Math.abs(Math.sin(rect.angle));
    const hw = (rect.w * c + rect.h * s) / 2;
    const hh = (rect.w * s + rect.h * c) / 2;
    x0 = rect.cx - hw;
    x1 = rect.cx + hw;
    y0 = rect.cy - hh;
    y1 = rect.cy + hh;
  }
  return x1 >= -margin && x0 <= vw + margin && y1 >= -margin && y0 <= vh + margin;
}

/**
 * Mount the click-to-activate DOM overlay manager for content embed cards.
 * Dependencies (`doc`, `win`) are injectable for headless unit tests.
 * @param {{
 *   root?: HTMLElement,
 *   doc?: Document,
 *   win?: typeof globalThis,
 *   cullMargin?: number,
 *   policy?: import("../../../packages/core/embed.js").EmbedPolicy | null,
 *   onActivate?: ((id: string) => void) | null,
 *   onDeactivate?: ((id: string) => void) | null,
 * }} [opts]
 */
export function createEmbedOverlay({
  root,
  doc = globalThis.document,
  win = globalThis.window ?? globalThis,
  cullMargin = 64,
  policy = null,
  onActivate = null,
  onDeactivate = null,
} = {}) {
  if (!root || !doc) throw new TypeError("createEmbedOverlay needs root and document");

  const appendNode = (parent, child) => (typeof parent.appendChild === "function" ? parent.appendChild(child) : parent.append?.(child));
  const removeNode = node => {
    if (node.parentNode && typeof node.parentNode.removeChild === "function") node.parentNode.removeChild(node);
    else node.remove?.();
  };

  let activePolicy = policy;

  const layer = doc.createElement("div");
  layer.className = "embed-overlay-layer";
  layer.setAttribute("aria-label", "Media embeds");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "2",
  });
  appendNode(root, layer);

  /** @type {Set<string>} */
  const active = new Set();
  /** @type {Map<string, { wrap: HTMLElement, playBtn: HTMLButtonElement, mediaWrap: HTMLElement, media: HTMLElement | null, blockedNotice: HTMLElement, closeBtn: HTMLButtonElement, selFrame: HTMLElement, active: boolean, blocked: boolean, provider: string | null, embedUrl: string | null }>} */
  const mounted = new Map();
  /** @type {Map<string, { el: any, embed: any }>} */
  const lastTargets = new Map();
  let lastSyncArgs = null;
  let destroyed = false;

  function stopMedia(media) {
    if (!media) return;
    const tag = String(media.tagName || "").toUpperCase();
    if (tag === "VIDEO") {
      try {
        if (!media.paused && typeof media.pause === "function") media.pause();
        media.removeAttribute?.("src");
        media.src = "";
        media.load?.();
      } catch {}
    } else if (tag === "IFRAME") {
      try {
        media.removeAttribute?.("src");
        media.src = "about:blank";
      } catch {}
    } else if (tag === "IMG") {
      try {
        media.removeAttribute?.("src");
        media.src = "";
      } catch {}
    }
  }

  function clearMedia(entry) {
    if (entry.media) {
      stopMedia(entry.media);
      removeNode(entry.media);
      entry.media = null;
    }
    entry.active = false;
    entry.provider = null;
    entry.embedUrl = null;
    entry.mediaWrap.style.display = "none";
    entry.mediaWrap.style.pointerEvents = "none";
    entry.closeBtn.style.display = "none";
    if (!entry.blocked) entry.playBtn.style.display = "block";
  }

  function attachErrorFallback(entry, media, embed) {
    media.addEventListener?.("error", () => {
      if (entry.media !== media) return;
      const fallback = doc.createElement("div");
      fallback.className = "embed-fallback";
      Object.assign(fallback.style, {
        position: "absolute",
        inset: "0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        padding: "16px",
        background: "#121216",
        color: "#F4F4F5",
        fontSize: "13px",
        textAlign: "center",
      });
      const msg = doc.createElement("span");
      msg.textContent = "Media blocked or unavailable inline";
      const link = doc.createElement("a");
      link.className = "embed-fallback-link";
      link.setAttribute("href", embed.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.textContent = `Open on ${embed.host} ↗`;
      Object.assign(link.style, {
        color: "#93C5FD",
        textDecoration: "underline",
        pointerEvents: "auto",
      });
      appendNode(fallback, msg);
      appendNode(fallback, link);
      stopMedia(media);
      removeNode(media);
      entry.media = fallback;
      appendNode(entry.mediaWrap, fallback);
    });
  }

  function buildMediaNode(embed, entry) {
    if (embed.provider === "youtube") {
      if (typeof embed.embedUrl !== "string" || !embed.embedUrl.startsWith(YOUTUBE_EMBED_PREFIX)) return null;
      const iframe = doc.createElement("iframe");
      iframe.className = "embed-iframe";
      iframe.setAttribute("sandbox", IFRAME_SANDBOX);
      iframe.setAttribute("allow", IFRAME_ALLOW);
      iframe.setAttribute("allowfullscreen", "");
      // YouTube's embed player requires a Referer origin (Error 153 under no-referrer).
      iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("title", embed.title || "YouTube Video");
      iframe.setAttribute("frameborder", "0");
      iframe.src = embed.embedUrl;
      Object.assign(iframe.style, {
        width: "100%",
        height: "100%",
        border: "0",
        display: "block",
        background: "#000000",
      });
      return iframe;
    }

    if (embed.provider === "figma") {
      if (typeof embed.embedUrl !== "string" || !embed.embedUrl.startsWith(FIGMA_EMBED_PREFIX)) return null;
      const iframe = doc.createElement("iframe");
      iframe.className = "embed-iframe embed-figma";
      iframe.setAttribute("sandbox", EMBED_SANDBOX.figma);
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("title", embed.title || "Figma");
      iframe.setAttribute("frameborder", "0");
      iframe.src = embed.embedUrl;
      Object.assign(iframe.style, {
        width: "100%",
        height: "100%",
        border: "0",
        display: "block",
        background: "#1E1E1E",
      });
      return iframe;
    }

    if (embed.provider === "doc") {
      if (typeof embed.embedUrl !== "string" || !embed.embedUrl.startsWith("https://")) return null;
      const iframe = doc.createElement("iframe");
      iframe.className = "embed-iframe embed-doc";
      iframe.setAttribute("sandbox", EMBED_SANDBOX.doc);
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("title", embed.title || "Document");
      iframe.setAttribute("frameborder", "0");
      iframe.src = embed.embedUrl;
      Object.assign(iframe.style, {
        width: "100%",
        height: "100%",
        border: "0",
        display: "block",
        background: "#FFFFFF",
      });
      return iframe;
    }

    if (embed.provider === "pdf") {
      if (typeof embed.embedUrl !== "string" || (!embed.embedUrl.startsWith("https://") && !embed.embedUrl.startsWith("/blobs/"))) {
        return null;
      }
      const iframe = doc.createElement("iframe");
      iframe.className = "embed-iframe embed-pdf";
      iframe.setAttribute("sandbox", EMBED_SANDBOX.pdf);
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("title", embed.title || "PDF Document");
      iframe.setAttribute("frameborder", "0");
      if (embed.page) iframe.setAttribute("data-pdf-page", String(embed.page));
      iframe.src = embed.embedUrl;
      Object.assign(iframe.style, {
        width: "100%",
        height: "100%",
        border: "0",
        display: "block",
        background: "#26262B",
      });
      return iframe;
    }

    if (embed.provider === "video") {
      if (typeof embed.embedUrl !== "string" || !embed.embedUrl.startsWith("https://")) return null;
      const video = doc.createElement("video");
      video.className = "embed-video";
      video.controls = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.preload = "metadata";
      video.src = embed.embedUrl;
      Object.assign(video.style, {
        width: "100%",
        height: "100%",
        objectFit: "contain",
        display: "block",
        background: "#000000",
      });
      attachErrorFallback(entry, video, embed);
      return video;
    }

    if (embed.provider === "image") {
      if (typeof embed.embedUrl !== "string" || !embed.embedUrl.startsWith("https://")) return null;
      const img = doc.createElement("img");
      img.className = "embed-image";
      img.setAttribute("referrerpolicy", "no-referrer");
      img.setAttribute("alt", embed.title || "Embedded image");
      img.src = embed.embedUrl;
      Object.assign(img.style, {
        width: "100%",
        height: "100%",
        objectFit: "contain",
        display: "block",
        background: "#121216",
      });
      attachErrorFallback(entry, img, embed);
      return img;
    }

    return null;
  }

  function mountEntry(id, embed) {
    const wrap = doc.createElement("div");
    wrap.className = "embed-el";
    wrap.setAttribute("data-element-id", id);
    wrap.setAttribute("data-embed-provider", embed.provider);
    Object.assign(wrap.style, {
      position: "absolute",
      left: "0",
      top: "0",
      transformOrigin: "50% 50%",
      pointerEvents: "none",
      overflow: "hidden",
    });

    // Transparent click-to-activate trigger aligned over the poster medallion (no network requests until clicked)
    const playBtn = doc.createElement("button");
    playBtn.type = "button";
    playBtn.className = "embed-play-btn";
    playBtn.setAttribute("aria-label", `Play ${embed.providerName || "media"} embed`);
    Object.assign(playBtn.style, {
      position: "absolute",
      left: "50%",
      top: "42%",
      width: "64px",
      height: "64px",
      transform: "translate(-50%, -50%)",
      background: "transparent",
      border: "0",
      borderRadius: "9999px",
      cursor: "pointer",
      pointerEvents: "auto",
    });

    const mediaWrap = doc.createElement("div");
    mediaWrap.className = "embed-media-wrap";
    Object.assign(mediaWrap.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      pointerEvents: "none",
    });

    const blockedNotice = doc.createElement("div");
    blockedNotice.className = "embed-blocked-notice";
    blockedNotice.setAttribute("role", "status");
    Object.assign(blockedNotice.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      padding: "16px",
      background: "rgba(18, 18, 22, 0.94)",
      color: "#F4F4F5",
      fontSize: "13px",
      textAlign: "center",
      pointerEvents: "none",
    });

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "embed-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close embed");
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      width: "28px",
      height: "28px",
      borderRadius: "9999px",
      border: "1px solid rgba(255,255,255,0.22)",
      background: "rgba(18,18,22,0.88)",
      color: "#F4F4F5",
      cursor: "pointer",
      display: "none",
      pointerEvents: "auto",
      zIndex: "2",
    });

    const selFrame = doc.createElement("div");
    selFrame.className = "embed-sel-frame";
    selFrame.setAttribute("aria-hidden", "true");
    Object.assign(selFrame.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      display: "none",
    });

    const entry = {
      wrap,
      playBtn,
      mediaWrap,
      media: null,
      blockedNotice,
      closeBtn,
      selFrame,
      active: false,
      blocked: false,
      provider: null,
      embedUrl: null,
    };

    const stopBubble = e => { e.stopPropagation?.(); };
    playBtn.addEventListener("pointerdown", stopBubble);
    closeBtn.addEventListener("pointerdown", stopBubble);

    playBtn.addEventListener("click", e => {
      e.stopPropagation?.();
      activate(id);
    });

    closeBtn.addEventListener("click", e => {
      e.stopPropagation?.();
      deactivate(id);
    });

    appendNode(wrap, playBtn);
    appendNode(wrap, mediaWrap);
    appendNode(wrap, blockedNotice);
    appendNode(wrap, closeBtn);
    appendNode(wrap, selFrame);
    appendNode(layer, wrap);
    mounted.set(id, entry);
    return entry;
  }

  function unmountEntry(id) {
    const entry = mounted.get(id);
    if (!entry) return;
    clearMedia(entry);
    removeNode(entry.wrap);
    mounted.delete(id);
  }

  function applyBlockedState(id, entry, embed, allowed) {
    entry.blocked = !allowed;
    entry.wrap.setAttribute("data-embed-blocked", allowed ? "false" : "true");
    if (!allowed) {
      if (active.has(id)) active.delete(id);
      if (entry.active || entry.media) clearMedia(entry);
      entry.playBtn.style.display = "none";
      entry.playBtn.style.pointerEvents = "none";
      entry.blockedNotice.textContent = `Embed blocked by tenant policy (${embed.host || embed.provider})`;
      entry.blockedNotice.style.display = "flex";
    } else {
      entry.blockedNotice.style.display = "none";
    }
  }

  function applyActiveMedia(id, entry, embed, dragging) {
    if (entry.blocked) return;
    if (!active.has(id)) {
      if (entry.active || entry.media) clearMedia(entry);
      return;
    }
    if (!entry.media || entry.provider !== embed.provider || entry.embedUrl !== embed.embedUrl) {
      clearMedia(entry);
      const node = buildMediaNode(embed, entry);
      if (!node) {
        active.delete(id);
        return;
      }
      entry.media = node;
      entry.active = true;
      entry.provider = embed.provider;
      entry.embedUrl = embed.embedUrl;
      appendNode(entry.mediaWrap, node);
    }
    entry.playBtn.style.display = "none";
    entry.mediaWrap.style.display = "block";
    entry.mediaWrap.style.pointerEvents = dragging ? "none" : "auto";
    entry.closeBtn.style.display = "block";
    entry.closeBtn.style.pointerEvents = dragging ? "none" : "auto";
  }

  function activate(id) {
    if (destroyed || typeof id !== "string" || !id) return false;
    const target = lastTargets.get(id);
    if (!target) return false;
    const embed = parseEmbedFromElement(target.el, { policy: activePolicy });
    if (!embed) return false;
    if (!isEmbedAllowed(embed.url, activePolicy, embed.provider)) {
      const entry = mounted.get(id);
      if (entry) applyBlockedState(id, entry, embed, false);
      return false;
    }
    active.add(id);
    const entry = mounted.get(id);
    if (entry) applyActiveMedia(id, entry, embed, !!lastSyncArgs?.dragging);
    onActivate?.(id);
    return true;
  }

  function deactivate(id) {
    const wasActive = active.delete(id);
    const entry = mounted.get(id);
    if (entry) clearMedia(entry);
    if (wasActive) onDeactivate?.(id);
    return wasActive;
  }

  function deactivateAll() {
    for (const id of [...active]) deactivate(id);
  }

  function pauseAll() {
    for (const entry of mounted.values()) {
      if (entry.media && String(entry.media.tagName || "").toUpperCase() === "VIDEO") {
        const video = /** @type {HTMLVideoElement} */ (entry.media);
        try {
          if (!video.paused && typeof video.pause === "function") video.pause();
        } catch {}
      }
    }
  }

  const onVisibilityChange = () => {
    if (doc.hidden || doc.visibilityState === "hidden") pauseAll();
  };
  const onPageHide = () => {
    pauseAll();
  };

  doc.addEventListener?.("visibilitychange", onVisibilityChange);
  win?.addEventListener?.("pagehide", onPageHide);

  return {
    layer,
    /**
     * Synchronize embed overlay containers with visible embed elements and camera transform.
     * No iframe/video/img is created for an element unless it has been activated and is allowed by policy.
     */
    sync({ elements = [], view = { x: 0, y: 0, scale: 1 }, viewport = { w: 0, h: 0 }, selectedIds = null, dragging = false, policy: syncPolicy = undefined } = {}) {
      if (destroyed) return;
      if (syncPolicy !== undefined) activePolicy = syncPolicy;
      lastSyncArgs = { elements, view, viewport, selectedIds, dragging };
      lastTargets.clear();

      const liveIds = new Set();
      const visibleIds = new Set();

      for (const el of elements) {
        if (!el || el.isDeleted) continue;
        const embed = parseEmbedFromElement(el, { policy: activePolicy });
        if (!embed) continue;
        liveIds.add(el.id);
        lastTargets.set(el.id, { el, embed });

        const rect = embedScreenRect(el, view);
        if (!isEmbedVisible(rect, viewport, cullMargin)) continue;
        visibleIds.add(el.id);

        const entry = mounted.get(el.id) ?? mountEntry(el.id, embed);
        entry.wrap.setAttribute("data-embed-provider", embed.provider);
        const pdfPage = /** @type {any} */ (embed).page;
        if (pdfPage) entry.wrap.setAttribute("data-pdf-page", String(pdfPage));
        else entry.wrap.removeAttribute?.("data-pdf-page");
        entry.wrap.style.transform = rect.transform;
        entry.wrap.style.width = `${rect.w}px`;
        entry.wrap.style.height = `${rect.h}px`;
        entry.wrap.style.opacity = String(Math.max(0, Math.min(1, num(el.opacity, 100) / 100)));

        const isSelected = selectedIds ? selectedIds.has(el.id) : false;
        entry.wrap.setAttribute("data-selected", isSelected ? "true" : "false");
        entry.wrap.className = isSelected ? "embed-el selected" : "embed-el";
        entry.selFrame.style.display = isSelected ? "block" : "none";

        const allowed = isEmbedAllowed(embed.url, activePolicy, embed.provider);
        applyBlockedState(el.id, entry, embed, allowed);

        if (allowed) {
          const playVisible = rect.w >= 48 && rect.h >= 36 && !active.has(el.id);
          entry.playBtn.style.display = playVisible ? "block" : "none";
          entry.playBtn.style.pointerEvents = !dragging && playVisible ? "auto" : "none";
          applyActiveMedia(el.id, entry, embed, dragging);
        }
      }

      // Cull off-screen or deleted embeds
      for (const id of [...mounted.keys()]) {
        if (!visibleIds.has(id)) unmountEntry(id);
      }
      // Drop active state for deleted elements
      for (const id of [...active]) {
        if (!liveIds.has(id)) active.delete(id);
      }
    },
    setPolicy(nextPolicy) {
      activePolicy = nextPolicy ?? null;
      if (lastSyncArgs) this.sync(lastSyncArgs);
    },
    activate,
    deactivate,
    deactivateAll,
    pauseAll,
    activeIds() { return [...active]; },
    mountedIds() { return [...mounted.keys()]; },
    getEntry(id) { return mounted.get(id) ?? null; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener?.("visibilitychange", onVisibilityChange);
      win?.removeEventListener?.("pagehide", onPageHide);
      active.clear();
      lastTargets.clear();
      for (const id of [...mounted.keys()]) unmountEntry(id);
      removeNode(layer);
    },
  };
}

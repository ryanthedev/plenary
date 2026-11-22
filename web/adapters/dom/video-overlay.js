// Mobile-safe inline <video> DOM overlay manager for canvas video elements.
// Aligns real <video> elements to each visible video element's exact world-to-screen transform
// (or directly from paintScene's projected `t: "video"` display-list items), culls off-screen videos,
// pauses all playing videos on backgrounding (visibilitychange/pagehide), keeps selection outlines
// and corner handles visible, and revokes object URLs + removes DOM nodes on delete or unmount.
//
// Hexagonal boundary: DOM adapter only (lives under web/adapters/dom/). No imports from other adapters.

const VIDEO_DATA_URL = /^data:video\/(?:mp4|webm|quicktime);base64,[A-Za-z0-9+/=]+$/;
const SAFE_MEDIA_URL = /^(?:blob:|data:video\/(?:mp4|webm|quicktime);base64,)/;
const POSTER_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_POSTER_DATA_URL_CHARS = 65536;

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

export function isValidPosterDataUrl(v) {
  return typeof v === "string" && v.length <= MAX_POSTER_DATA_URL_CHARS && POSTER_DATA_URL.test(v);
}

/**
 * Pure world-to-screen geometry for a video element.
 * Mirrors packages/core/geometry.js `bbox` + packages/core/render.js `project`.
 * @param {{ x: number, y: number, width: number, height: number, angle?: number }} el
 * @param {{ x: number, y: number, scale: number }} view
 */
export function videoScreenRect(el, view) {
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

/** Convert a projected display-list item `{ t: "video", x, y, w, h, angle, cx, cy }` into a screen rect. */
function rectFromDisplayItem(it) {
  const left = num(it.x);
  const top = num(it.y);
  const w = Math.abs(num(it.w));
  const h = Math.abs(num(it.h));
  const angle = num(it.angle, 0);
  const cx = Number.isFinite(+it.cx) ? +it.cx : left + w / 2;
  const cy = Number.isFinite(+it.cy) ? +it.cy : top + h / 2;
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
export function isVideoVisible(rect, viewport, margin = 64) {
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
 * Mount the DOM overlay manager that renders inline <video> elements over the board canvas.
 * Dependencies (`doc`, `win`, `urlApi`, `BlobCtor`) are injectable for headless unit tests.
 */
export function createVideoOverlay({
  root,
  doc = globalThis.document,
  win = globalThis.window ?? globalThis,
  urlApi = globalThis.URL,
  BlobCtor = globalThis.Blob,
  cullMargin = 64,
} = {}) {
  if (!root || !doc) throw new TypeError("createVideoOverlay needs root and document");

  const appendNode = (parent, child) => (typeof parent.appendChild === "function" ? parent.appendChild(child) : parent.append?.(child));
  const removeNode = node => {
    if (node.parentNode && typeof node.parentNode.removeChild === "function") node.parentNode.removeChild(node);
    else node.remove?.();
  };

  const layer = doc.createElement("div");
  layer.className = "video-overlay-layer";
  layer.setAttribute("aria-label", "Video elements");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "1",
  });
  appendNode(root, layer);

  /** @type {Map<string, { wrap: HTMLElement, video: HTMLVideoElement, controls: HTMLElement, playBtn: HTMLButtonElement, muteBtn: HTMLButtonElement, selFrame: HTMLElement, fileId: string | null, src: string | null }>} */
  const mounted = new Map();
  /** Object URLs created and owned by this overlay manager, keyed by fileId (revoked when unreferenced or destroyed). */
  const ownedObjectUrls = new Map();
  let destroyed = false;

  function revokeUrl(url) {
    if (typeof url === "string" && url.startsWith("blob:") && typeof urlApi?.revokeObjectURL === "function") {
      try { urlApi.revokeObjectURL(url); } catch {}
    }
  }

  function resolveSrc(fileId, file, mimeType) {
    if (!fileId || !file) return null;
    if (ownedObjectUrls.has(fileId)) return ownedObjectUrls.get(fileId);
    // Prefer raw bytes so this overlay owns the object URL lifecycle (undo/redo cleanly recreates a fresh URL).
    if (file.bytes instanceof Uint8Array && typeof urlApi?.createObjectURL === "function" && typeof BlobCtor === "function") {
      const blob = new BlobCtor([file.bytes], { type: file.mimeType || mimeType || "video/mp4" });
      const objUrl = urlApi.createObjectURL(blob);
      ownedObjectUrls.set(fileId, objUrl);
      return objUrl;
    }
    if (typeof file.dataURL === "string" && VIDEO_DATA_URL.test(file.dataURL)) {
      return file.dataURL;
    }
    if (typeof file.url === "string" && SAFE_MEDIA_URL.test(file.url)) {
      return file.url;
    }
    return null;
  }

  function pauseVideo(video) {
    if (!video) return;
    try {
      if (!video.paused && typeof video.pause === "function") video.pause();
    } catch {}
  }

  function pauseAll() {
    for (const entry of mounted.values()) {
      pauseVideo(entry.video);
      updateButtonLabels(entry);
    }
  }

  function updateButtonLabels(entry) {
    const playing = !entry.video.paused;
    entry.playBtn.textContent = playing ? "⏸" : "▶";
    entry.playBtn.setAttribute("aria-label", playing ? "Pause video" : "Play video");
    const muted = !!entry.video.muted;
    entry.muteBtn.textContent = muted ? "🔇" : "🔊";
    entry.muteBtn.setAttribute("aria-label", muted ? "Unmute video" : "Mute video");
  }

  function mountEntry(el) {
    const wrap = doc.createElement("div");
    wrap.className = "video-el";
    wrap.setAttribute("data-element-id", el.id);
    Object.assign(wrap.style, {
      position: "absolute",
      left: "0",
      top: "0",
      transformOrigin: "50% 50%",
      pointerEvents: "none",
      overflow: "hidden",
    });

    const video = doc.createElement("video");
    video.className = "video-media";
    // Mobile-safe inline playback attributes (iOS Safari / WKWebView / Android Chrome)
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "metadata";
    video.controls = false;
    video.muted = el.muted !== false;
    video.loop = !!el.loop;
    Object.assign(video.style, {
      width: "100%",
      height: "100%",
      objectFit: "fill",
      display: "block",
      pointerEvents: "none",
    });

    const controls = doc.createElement("div");
    controls.className = "video-controls";
    Object.assign(controls.style, {
      position: "absolute",
      left: "8px",
      bottom: "8px",
      display: "flex",
      gap: "6px",
      pointerEvents: "auto",
    });

    const playBtn = doc.createElement("button");
    playBtn.type = "button";
    playBtn.className = "video-btn video-play-btn";
    const muteBtn = doc.createElement("button");
    muteBtn.type = "button";
    muteBtn.className = "video-btn video-mute-btn";

    // Non-interactive selection frame & corner handle markers visible above the <video> surface
    const selFrame = doc.createElement("div");
    selFrame.className = "video-sel-frame";
    selFrame.setAttribute("aria-hidden", "true");
    Object.assign(selFrame.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      display: "none",
    });
    for (const corner of ["nw", "ne", "se", "sw"]) {
      const dot = doc.createElement("span");
      dot.className = `video-handle video-handle-${corner}`;
      appendNode(selFrame, dot);
    }

    const entry = { wrap, video, controls, playBtn, muteBtn, selFrame, fileId: el.fileId ?? null, src: null };

    const stopBubble = e => { e.stopPropagation?.(); };
    playBtn.addEventListener("pointerdown", stopBubble);
    muteBtn.addEventListener("pointerdown", stopBubble);

    playBtn.addEventListener("click", e => {
      e.stopPropagation?.();
      if (video.paused) {
        try {
          const p = video.play?.();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {}
      } else {
        pauseVideo(video);
      }
      updateButtonLabels(entry);
    });

    muteBtn.addEventListener("click", e => {
      e.stopPropagation?.();
      video.muted = !video.muted;
      updateButtonLabels(entry);
    });

    video.addEventListener("play", () => updateButtonLabels(entry));
    video.addEventListener("pause", () => updateButtonLabels(entry));
    video.addEventListener("ended", () => updateButtonLabels(entry));

    updateButtonLabels(entry);
    appendNode(controls, playBtn);
    appendNode(controls, muteBtn);
    appendNode(wrap, video);
    appendNode(wrap, controls);
    appendNode(wrap, selFrame);
    appendNode(layer, wrap);
    mounted.set(el.id, entry);
    return entry;
  }

  function unmountEntry(id) {
    const entry = mounted.get(id);
    if (!entry) return;
    pauseVideo(entry.video);
    try {
      entry.video.removeAttribute?.("src");
      entry.video.src = "";
      entry.video.load?.();
    } catch {}
    removeNode(entry.wrap);
    mounted.delete(id);
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
     * Synchronize mounted <video> nodes with current live video elements, viewport, and files.
     * When `displayItems` (from `paintScene` / `S.displayList`) is provided, projected `t: "video"`
     * screen geometry and opacity are used directly so timeline animations stay aligned.
     */
    sync({ displayItems = null, elements = [], files = {}, view = { x: 0, y: 0, scale: 1 }, viewport = { w: 0, h: 0 }, selectedIds = null, dragging = false } = {}) {
      if (destroyed) return;
      const elById = new Map();
      const liveVideos = [];
      const liveFileIds = new Set();
      for (const el of elements) {
        if (!el || el.isDeleted || el.type !== "video") continue;
        elById.set(el.id, el);
        liveVideos.push(el);
        if (el.fileId) liveFileIds.add(el.fileId);
      }

      // Build list of { id, el, rect, opacity } either from rendered displayItems or raw elements+view
      const targets = [];
      if (Array.isArray(displayItems)) {
        for (const it of displayItems) {
          if (!it || it.t !== "video") continue;
          const el = elById.get(it.id) ?? it;
          if (el.fileId) liveFileIds.add(el.fileId);
          targets.push({
            id: it.id,
            el,
            rect: rectFromDisplayItem(it),
            opacity: Math.max(0, Math.min(1, num(it.opacity, 1))),
          });
        }
      } else {
        for (const el of liveVideos) {
          targets.push({
            id: el.id,
            el,
            rect: videoScreenRect(el, view),
            opacity: Math.max(0, Math.min(1, num(el.opacity, 100) / 100)),
          });
        }
      }

      const visibleIds = new Set();
      for (const { id, el, rect, opacity } of targets) {
        if (!isVideoVisible(rect, viewport, cullMargin)) continue;
        visibleIds.add(id);

        const entry = mounted.get(id) ?? mountEntry({ ...el, id });
        entry.fileId = el.fileId ?? null;

        // World-to-screen transform alignment
        entry.wrap.style.transform = rect.transform;
        entry.wrap.style.width = `${rect.w}px`;
        entry.wrap.style.height = `${rect.h}px`;
        entry.wrap.style.opacity = String(opacity);

        // Gate control pointer events while dragging/resizing so canvas gestures never snag on buttons
        const controlsVisible = rect.w >= 48 && rect.h >= 36;
        entry.controls.style.pointerEvents = !dragging && controlsVisible ? "auto" : "none";
        entry.controls.style.display = controlsVisible ? "flex" : "none";

        // Keep selection outline and corner handles visible above video pixels
        const isSelected = selectedIds ? selectedIds.has(id) : false;
        entry.wrap.setAttribute("data-selected", isSelected ? "true" : "false");
        entry.wrap.className = isSelected ? "video-el selected" : "video-el";
        entry.wrap.style.overflow = isSelected ? "visible" : "hidden";
        entry.selFrame.style.display = isSelected ? "block" : "none";

        // Sync media flags and strictly validate posterDataUrl before assigning
        entry.video.loop = !!el.loop;
        const safePoster = isValidPosterDataUrl(el.posterDataUrl) ? el.posterDataUrl : "";
        if (safePoster) {
          if (entry.video.poster !== safePoster) entry.video.poster = safePoster;
        } else if (entry.video.poster) {
          entry.video.removeAttribute?.("poster");
          entry.video.poster = "";
        }

        // Resolve media source
        const nextSrc = resolveSrc(el.fileId, files?.[el.fileId], el.mimeType);
        if (nextSrc !== entry.src) {
          entry.src = nextSrc;
          if (nextSrc) {
            entry.video.src = nextSrc;
            // Mobile-safe autoplay: only attempt autoplay when muted
            if (el.autoplay && entry.video.muted) {
              try {
                const p = entry.video.play?.();
                if (p && typeof p.catch === "function") p.catch(() => {});
              } catch {}
            }
          } else {
            pauseVideo(entry.video);
            try { entry.video.removeAttribute?.("src"); entry.video.src = ""; } catch {}
          }
        }
      }

      // Unmount culled or deleted videos
      for (const id of [...mounted.keys()]) {
        if (!visibleIds.has(id)) unmountEntry(id);
      }

      // Revoke owned object URLs for deleted/unreferenced fileIds
      for (const [fid, url] of [...ownedObjectUrls.entries()]) {
        if (!liveFileIds.has(fid)) {
          revokeUrl(url);
          ownedObjectUrls.delete(fid);
        }
      }
    },
    pauseAll,
    mountedIds() { return [...mounted.keys()]; },
    getEntry(id) { return mounted.get(id) ?? null; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener?.("visibilitychange", onVisibilityChange);
      win?.removeEventListener?.("pagehide", onPageHide);
      for (const id of [...mounted.keys()]) unmountEntry(id);
      for (const url of ownedObjectUrls.values()) revokeUrl(url);
      ownedObjectUrls.clear();
      removeNode(layer);
    },
  };
}

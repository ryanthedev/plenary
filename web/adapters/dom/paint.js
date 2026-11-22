// Display list → Canvas2D. Paints what core's render.js / Editor.displayList emits, already in screen
// pixels (logical, zoom 1), so the board's own view is never applied here:
//   { t: "path", cmds, stroke, width, dash?, opacity? }   cmds: ["M",x,y] ["L",x,y] ["Q",x,y,cx,cy]
//   { t: "path", cmds, fill, opacity? }                    closed polygon
//   { t: "text", x, y, text, size, color, align, box?, lineHeight, font?, angle?, cx?, cy?, opacity?, reveal? }
//   { t: "image", fileId, x, y, w, h, angle, cx, cy, opacity? }
// Matches herdr-draw's SVG adapter (adapters/svg/svg.js): text baselines at lineHeight·(i + 0.75), labels
// centred in their box, rotation about (cx, cy), `reveal` as a typewriter.
//
// Pure: paint(ctx, items, view) touches only ctx. Pictures come in through view.image(fileId), which returns
// something drawImage takes, or null while it loads (the page owns loading; see imageCache).

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
// Board content is untrusted: only hex colors reach the context (as in the SVG adapter).
export const color = c => (HEX.test(c ?? "") ? c : "#888888");

export const FACES = {
  hand: "Excalifont, Virgil, 'Chalkboard SE', 'Comic Sans MS', cursive",
  mono: "'Cascadia Code', Menlo, Consolas, monospace",
  sans: "Helvetica, Arial, sans-serif",
};

/** Maximum canvas backing-store pixel area (≈ 8 MP): keeps 3× iPhones crisp within WKWebView GPU limits. */
export const MAX_CANVAS_PIXELS = 8_388_608;

/** Compute effective DPR capped so `cssW * cssH * dpr^2 <= maxPixels`. */
export function cappedDpr(cssW, cssH, dpr = 1, maxPixels = MAX_CANVAS_PIXELS) {
  const w = Math.max(1, num(cssW, 1)), h = Math.max(1, num(cssH, 1));
  const raw = num(dpr, 1) > 0 ? num(dpr, 1) : 1;
  const area = w * h * raw * raw;
  if (area <= maxPixels) return raw;
  return Math.max(1, Math.sqrt(maxPixels / (w * h)));
}

/** Light and dark themes in core's shape ({ fg, bg, accent, dim }), synced with Warm Studio Paper / Obsidian Studio tokens. */
export const THEMES = {
  light: { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" },
  dark: { fg: "#F4F4F5", bg: "#111113", accent: "#818CF8", dim: "#91919E" },
};

function trace(ctx, cmds) {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === "M") ctx.moveTo(num(c[1]), num(c[2]));
    else if (c[0] === "L") ctx.lineTo(num(c[1]), num(c[2]));
    else if (c[0] === "Q") ctx.quadraticCurveTo(num(c[3]), num(c[4]), num(c[1]), num(c[2]));   // [Q, x, y, cx, cy]
  }
}

function rotated(ctx, it, draw) {
  const a = num(it.angle);
  if (!a) return draw();
  ctx.save();
  ctx.translate(num(it.cx), num(it.cy)); ctx.rotate(a); ctx.translate(-num(it.cx), -num(it.cy));
  draw();
  ctx.restore();
}

/**
 * Paint a display list.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} items  editor.displayList(theme)
 * @param {{ width: number, height: number, dpr?: number, background?: string,
 *           image?: (fileId: string) => CanvasImageSource | null, faces?: Record<string, string> }} view
 */
export function paint(ctx, items, view) {
  const dpr = num(view.dpr, 1) > 0 ? num(view.dpr, 1) : 1, faces = view.faces ?? FACES;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (view.background) { ctx.fillStyle = color(view.background); ctx.fillRect(0, 0, num(view.width), num(view.height)); }
  else ctx.clearRect(0, 0, num(view.width), num(view.height));
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const it of items) {
    const op = Math.max(0, Math.min(1, num(it.opacity, 1)));
    if (op <= 0) continue;
    ctx.globalAlpha = op;
    if (it.t === "path") {
      if (!Array.isArray(it.cmds) || !it.cmds.length) continue;
      trace(ctx, it.cmds);
      if (it.fill) { ctx.closePath(); ctx.fillStyle = color(it.fill); ctx.fill(); }
      else {
        const w = num(it.width, 1);
        if (!(w > 0)) continue;   // canvas ignores a width of 0 or less and would keep the previous one
        ctx.strokeStyle = color(it.stroke); ctx.lineWidth = w;
        ctx.setLineDash(Array.isArray(it.dash) ? it.dash.map(v => num(v)) : []);
        ctx.stroke();
      }
    } else if (it.t === "text") {
      let text = String(it.text ?? "");
      if (it.reveal != null && it.reveal < 1) text = text.slice(0, Math.round(text.length * Math.max(0, it.reveal)));
      if (!text) continue;
      const size = num(it.size, 16), lh = size * num(it.lineHeight, 1.25), lines = text.split("\n");
      const face = Object.prototype.hasOwnProperty.call(faces, it.font) ? faces[it.font] : faces.sans;   // own keys only
      ctx.font = `${size.toFixed(1)}px ${face}`;
      ctx.fillStyle = color(it.color);
      ctx.textBaseline = "alphabetic";
      rotated(ctx, it, () => {
        if (it.box) {
          const cx = num(it.box.x) + num(it.box.w) / 2, top = num(it.box.y) + num(it.box.h) / 2 - (lines.length * lh) / 2;
          ctx.textAlign = "center";
          lines.forEach((l, i) => ctx.fillText(l, cx, top + lh * (i + 0.75)));
        } else {
          ctx.textAlign = "left";
          lines.forEach((l, i) => ctx.fillText(l, num(it.x), num(it.y) + lh * (i + 0.75)));
        }
      });
    } else if (it.t === "image") {
      const src = view.image?.(it.fileId);
      if (!src) continue;
      rotated(ctx, it, () => ctx.drawImage(src, num(it.x), num(it.y), Math.max(0, num(it.w)), Math.max(0, num(it.h))));
    } else if (it.t === "video") {
      const x = num(it.x), y = num(it.y), w = Math.max(0, num(it.w)), h = Math.max(0, num(it.h));
      rotated(ctx, it, () => {
        ctx.fillStyle = "#18181b";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#52525b";
        ctx.lineWidth = 1;
        ctx.setLineDash(it.status === "pending" ? [6, 4] : []);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        // Centered play-icon badge for canvas fallback / PNG exports / thumbnails
        const r = Math.min(24, Math.max(8, Math.min(w, h) * 0.16));
        const cx = x + w / 2, cy = y + h / 2;
        if (w >= 24 && h >= 24) {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255,0.22)";
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(cx - r * 0.32, cy - r * 0.45);
          ctx.lineTo(cx + r * 0.5, cy);
          ctx.lineTo(cx - r * 0.32, cy + r * 0.45);
          ctx.closePath();
          ctx.fillStyle = "#ffffff";
          ctx.fill();
        }
      });
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// Only base64 raster data URLs become pictures: a board's files are untrusted. SVG is left out (unlike the
// SVG adapter): some browsers taint a canvas that drew one, which would break PNG export.
export const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * A browser-side picture cache for view.image: decodes each file once, calls onLoad when one is ready.
 * @param {() => Record<string, { dataURL?: string }>} files  the Editor's doc.files (read each time)
 */
export function imageCache(files, onLoad = () => {}, make = () => new Image()) {
  const cache = new Map();
  return fileId => {
    if (cache.has(fileId)) { const c = cache.get(fileId); return c.ready ? c.img : null; }
    const url = files()?.[fileId]?.dataURL;
    if (typeof url !== "string" || !DATA_URL.test(url)) return null;
    const c = { img: make(), ready: false };
    cache.set(fileId, c);
    c.img.onload = () => { c.ready = true; onLoad(fileId); };
    c.img.src = url;
    return null;
  };
}

// @ts-check
// Canvas overlays for others' presence: selections, previews, laser trails, cursors with name tags. Pure draw
// functions: each takes a 2D context and the view and paints in screen pixels (CSS px; scale the context for
// devicePixelRatio first). Names are drawn with fillText, which never parses anything.
// `view`: { toScreen({x, y}) → {x, y} } plus the zoom as `scale` or `view.scale` (an Editor works as is).

import { LASER_FADE_MS } from "../../../core/collab/presence-model.js";

export const LASER = { light: "#e03131", dark: "#ff6b6b" };
const FONT = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
export const scaleOf = view => view.scale ?? view.view?.scale ?? 1;

/** The screen rectangle of a world box. */
function screenBox(view, b) {
  const a = view.toScreen({ x: b.x, y: b.y }), s = scaleOf(view);
  return { x: a.x, y: a.y, w: b.width * s, h: b.height * s };
}

/** A name tag: a colored rounded box with white text, its top-left at (x, y). */
export function tag(ctx, x, y, text, color) {
  ctx.font = FONT;
  const label = String(text).length > 40 ? `${String(text).slice(0, 39)}…` : String(text);
  const w = ctx.measureText(label).width + 12, hh = 18;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hh, [3, 9, 9, 9]); else ctx.rect(x, y, w, hh);
  ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
  ctx.fillText(label, x + 6, y + hh / 2 + 0.5);
}

/** Others' selections: a dashed box per element, "Name selected" once. */
export function drawSelections(ctx, selections, view, element) {
  for (const s of selections) {
    let first = null;
    ctx.save(); ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = s.color;
    for (const id of s.ids.slice(0, 200)) {
      const b = element(s.stream, id);
      if (!b) continue;
      const r = screenBox(view, b);
      ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      first ??= r;
    }
    ctx.restore();
    if (first) tag(ctx, first.x - 4, first.y + first.h + 7, `${s.name} selected`, s.color);
  }
}

/** Others' drags and strokes in flight: a dashed outline and "Name · drawing" (the shapes themselves are painted by the board). */
export function drawPreviews(ctx, previews, view, colorFor) {
  const seen = new Set();
  for (const { el, user, name } of previews) {
    if (!el || !Number.isFinite(el.x) || !Number.isFinite(el.y)) continue;
    const r = screenBox(view, { x: el.x, y: el.y, width: Math.abs(el.width ?? 0), height: Math.abs(el.height ?? 0) }), color = colorFor(user);
    ctx.save(); ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.globalAlpha = 0.7;
    ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6); ctx.restore();
    if (!seen.has(user)) { seen.add(user); tag(ctx, r.x + r.w + 6, r.y + r.h + 6, `${name} · drawing`, color); }
  }
}

/** Laser trails: each point fades out over LASER_FADE_MS; the newest end glows. */
export function drawLasers(ctx, lasers, view, theme = "light") {
  const color = LASER[theme] ?? LASER.light;
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = color; ctx.fillStyle = color;
  for (const l of lasers) {
    const pts = l.pts.map(p => ({ ...view.toScreen(p), a: Number.isFinite(p.alpha) ? p.alpha : Math.max(0, 1 - p.age / LASER_FADE_MS) }));
    for (let i = 1; i < pts.length; i++) {
      const a = Math.min(pts[i - 1].a, pts[i].a);
      if (a <= 0) continue;
      ctx.globalAlpha = a; ctx.lineWidth = 2 + 3 * a;
      ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
    }
    const last = pts[pts.length - 1];
    if (last && last.a > 0) {
      ctx.globalAlpha = last.a; ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
}

/** Others' cursors: an arrow in their color and their name. */
export function drawCursors(ctx, cursors, view) {
  for (const c of cursors) {
    const p = view.toScreen(c);
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.beginPath(); ctx.moveTo(1, 1); ctx.lineTo(16, 9); ctx.lineTo(9, 11); ctx.lineTo(6, 18); ctx.closePath();
    ctx.fillStyle = c.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
    ctx.restore();
    tag(ctx, p.x + 14, p.y + 16, c.name, c.color);
  }
}

/**
 * Everything, in order (selections under cursors). `pv` = presence view(); `previews` = [{ el, user, name }].
 * @returns {boolean} true while something is still animating or fading (keep painting)
 */
export function drawPresence(ctx, pv, view, { element, previews = pv.previews ?? [], colorFor, theme = "light" }) {
  drawSelections(ctx, pv.selections, view, element);
  drawPreviews(ctx, previews, view, colorFor);
  drawLasers(ctx, pv.lasers, view, theme);
  drawCursors(ctx, pv.cursors, view);
  return pv.needsFrame !== undefined ? !!pv.needsFrame : pv.lasers.length > 0;
}

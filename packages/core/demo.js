// @ts-check
// The Plenary demo board: a short animated tour that teaches the keys and core features by showing them.
// Spell keys out (Cmd, Shift): the hand font has no ⌘/⇧ glyphs.
// Built fresh each time (never saved): the pane plays it in its own Editor, beside the person's
// board, so trying things in the demo can't touch their file.

import { makeElement, emptyScene, isLabel, textSize } from "./model.js";
import { mermaidToElements } from "./mermaid.js";
import { bbox, unionBox } from "./geometry.js";
import { timelineEnd } from "./anim.js";
import { buildLinkCard } from "./link-card.js";

const anim = (preset, start, duration = 600) => ({ preset, start, duration });

function text(str, x, y, fields = {}) {
  const fontSize = fields.fontSize ?? 20;
  const fontFamily = fields.fontFamily ?? 1;
  const sz = textSize(str, fontSize, 1.25, fontFamily);
  return makeElement("text", {
    x,
    y,
    width: Math.ceil(sz.w),
    height: Math.ceil(sz.h),
    text: str,
    originalText: str,
    fontSize,
    fontFamily,
    ...fields,
  });
}

export function demoScene() {
  const els = [];
  let t = 0;
  const at = (el, preset, start, dur) => {
    el.customData = { ...el.customData, anim: anim(preset, start, dur) };
    return el;
  };

  // 1. Title.
  els.push(at(text("Plenary: a quick tour", 0, 0, { fontSize: 36, fontFamily: 2 }), "pop", t, 650));
  els.push(at(text("watch it build, then press the keys yourself", 2, 54, { fontSize: 16, fontFamily: 2, strokeColor: "#495057" }), "dissolve-in", t += 450, 600));

  // 2. Shapes, each named by its key, joined by perimeter-bound arrows.
  const flow = mermaidToElements([
    "flowchart LR",
    "  R[R: rectangle] --> D{D: diamond}",
    "  D -->|A: arrow| O((O: ellipse))",
  ].join("\n"), { origin: { x: 0, y: 120 } });
  const nodes = flow.elements.filter(e => !isLabel(e) && e.type !== "arrow" && e.type !== "line");
  const fills = ["#a5d8ff", "#ffec99", "#b2f2bb"];
  t += 550;
  nodes.forEach((n, i) => {
    n.backgroundColor = fills[i % fills.length];
    at(n, "pop", t + i * 800, 550);
  });
  for (const e of flow.elements) {
    if (e.type === "arrow" || e.type === "line") {
      const from = nodes.findIndex(n => n.id === e.startBinding?.elementId);
      at(e, "draw", t + Math.max(0, from) * 800 + 480, 450);
    }
  }
  // Labels animate with their shape or arrow.
  for (const l of flow.elements.filter(isLabel)) {
    const host = flow.elements.find(e => e.id === l.containerId);
    if (host?.customData?.anim) l.customData = { ...l.customData, anim: { ...host.customData.anim } };
  }
  els.push(...flow.elements);
  t += nodes.length * 800 + 200;

  const box = unionBox(flow.elements.filter(e => !isLabel(e)).map(bbox)) ?? { x: 0, y: 120, w: 600, h: 120 };
  let y = box.y + box.h + 48;

  // 3. A pen stroke, drawn on.
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([i * 6, Math.sin(i / 4) * 14]);
  const pen = makeElement("freedraw", { x: 0, y: y + 14, points: pts, width: 240, height: 28, strokeColor: "#e03131", strokeWidth: 2 });
  els.push(at(pen, "draw", t, 850));
  els.push(at(text("P: pen", 264, y + 6, { strokeColor: "#e03131", fontFamily: 2 }), "fade", t + 280, 500));
  t += 1000;
  y += 68;

  // 4. Core shortcuts, revealed one line at a time.
  const lines = [
    "T or double-click: write text (Cmd+Enter finishes)",
    "V: select · drag a corner to resize · the top dot rotates",
    "C B S W: color, fill, dash, width of the selection",
    "F: frame · I: layers, views & Animate (pop, dissolve, wipe, draw)",
    "Shift+Space plays the timeline, like this Plenary tour",
  ];
  for (const l of lines) {
    els.push(at(text(l, 0, y, { fontFamily: 2 }), "wipe-right", t, 750));
    t += 850;
    y += 38;
  }

  // 5. Sample rich link card (GitHub / Linear / Jira / ADO).
  const card = buildLinkCard("https://github.com/ryanthedev/plenary/pull/42", {
    x: 0,
    y: y + 16,
    width: 360,
    height: 112,
    title: "Paste GitHub, Linear, Jira or ADO URLs",
  });
  if (card) {
    at(card, "pop", t, 600);
    els.push(card);
    t += 700;
    y += 144;
  }

  // 6. Where help lives.
  const help = makeElement("rectangle", {
    x: 0,
    y: y + 12,
    width: 500,
    height: 56,
    backgroundColor: "#eebefa",
    roundness: { type: 3 },
    strokeColor: "#9c36b5",
  });
  const hl = makeElement("text", {
    x: 0,
    y: 0,
    text: "? shows every shortcut · Esc leaves the demo",
    originalText: "? shows every shortcut · Esc leaves the demo",
    fontSize: 18,
    fontFamily: 2,
    containerId: help.id,
    textAlign: "center",
    verticalAlign: "middle",
  });
  help.boundElements = [{ id: hl.id, type: "text" }];
  at(help, "pop", t, 600);
  hl.customData = { ...hl.customData, anim: anim("pop", t, 600) };
  els.push(help, hl);

  // z order: as listed.
  els.forEach((e, i) => { e.customData = { ...e.customData, z: i + 1 }; });
  const scene = emptyScene();
  scene.source = "plenary";
  scene.elements = els;
  scene.appState.herdr.timeline = { duration: timelineEnd(els) + 800 };
  return scene;
}

// Pure parts of the canvas chrome: role tables, key gating, pill text, panel model, export writers.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Editor, TOOLS } from "../../packages/core/editor.js";
import { defaultPanel, applyPanel, panelSections } from "../../packages/core/panel.js";
import { uiRole, toolsFor, mayUseTool, streamFor, viewKey, clipboardKey, pillFor } from "../../web/core/roles.js";
import { propsModel, availableFor, STYLE_ROWS, loadLibrary, saveLibrary } from "../../web/adapters/dom/panel.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { toSvg, exportSvg, paintPng } from "../../web/adapters/dom/export.js";

test("header ellipsis rules cover 1024, 1279, and 1280 pixel desktop widths", () => {
  const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.board-name\s*\{[^}]*min-width:\s*56px[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*flex:\s*0 1 auto/s);
  expect(css).toMatch(/\.watching\s*\{[^}]*max-width:\s*150px[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*flex:\s*0 1 auto/s);
  expect(css).toMatch(/\.topbar \.board-name\s*\{[^}]*max-width:\s*clamp\(56px, 12vw, 150px\)/s);
  expect(css).toMatch(/\.watching\s*\{[^}]*max-width:\s*96px/s);
  expect(css).toMatch(/\.header-actions\s*\{[^}]*flex-shrink:\s*0/s);
  expect(css).toMatch(/\.watching\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*flex:\s*0 1 auto/s);
  expect(css).toMatch(/\.collab-pop\s*\{[^}]*overflow-y:\s*auto/s);
  expect(css).toMatch(/\.collab-pop > header, \.collab-pop > \.reply\s*\{[^}]*flex-shrink:\s*0/s);
  expect(css).toMatch(/\.collab-pop \.body\s*\{[^}]*flex:\s*0 0 auto[^}]*min-height:\s*3\.5em[^}]*overflow:\s*visible/s);
  expect(css).toMatch(/\.collab-pop\s*\{\s*background:[^}]*radial-gradient[^}]*rgba\(0,\s*0,\s*0[^}]*var\(--raised\)/s);
  expect(css).toMatch(/@media\s*\(max-width:\s*360px\)[\s\S]*?\.dock \.tb\s*\{[^}]*font-size:\s*0/s);
  expect(css).toMatch(/@media\s*\(max-width:\s*360px\)[\s\S]*?\.dock \.tb \.ic\s*\{[^}]*font-size:\s*18px/s);
  expect(css).not.toMatch(/font-size:\s*7\.5px|letter-spacing:\s*-\.03em/);
  expect(css).toMatch(/\.dock \.tb\s*\{[^}]*font-size:\s*8\.75px/s);
  expect(css).toMatch(/@media\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1023px\)[\s\S]*?\.dock \.tb\s*\{[^}]*font-size:\s*10px/s);
  expect(css).toMatch(/\.panel\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*left:\s*0[^}]*right:\s*0/s);
});

test("canvas page has a page heading", () => {
  const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  expect(html).toMatch(/<h1\b[^>]*>\s*Plenary\s*<\/h1>/);
});

test("role → chrome, and the tools each gets", () => {
  expect(["owner", "editor", "annotator", "commenter", "viewer", null, "root"].map(uiRole)).toEqual(["presenter", "presenter", "annotator", "viewer", "viewer", "viewer", "viewer"]);
  expect(toolsFor("presenter").map(t => t.id)).toEqual([...TOOLS.map(t => t.id), "image", "note", "highlighter"]);
  expect(toolsFor("annotator").map(t => t.id)).toEqual(["select", "hand", "arrow", "freedraw", "text", "eraser", "image", "note", "highlighter"]);
  expect(toolsFor("viewer").map(t => t.id)).toEqual(["hand"]);
  expect(mayUseTool("annotator", "rectangle")).toBe(false);
  expect(streamFor("presenter", "rectangle")).toBe("board");
  expect(streamFor("presenter", "highlighter")).toBe("notes");
  expect(streamFor("annotator", "freedraw")).toBe("notes");
});

test("view-only keys never include a writing key", () => {
  for (const k of ["h", "pageup", "pagedown"]) expect(viewKey(k)).toBe(true);
  for (const k of ["=", "-", "0"]) expect(viewKey(k, { cmd: true })).toBe(true);
  expect(viewKey("1", { shift: true })).toBe(true);
  for (const k of ["escape", "delete", "backspace", "enter", "left", "c", "b", "q", "r", "v", "space"]) expect(viewKey(k)).toBe(false);
  for (const k of ["z", "y", "d", "v", "x", "g", "'", "a"]) expect(viewKey(k, { cmd: true })).toBe(false);
  expect(clipboardKey("v", { cmd: true })).toBe(true);
  expect(clipboardKey("v", {})).toBe(false);
});

test("pill: viewers never show edits waiting", () => {
  expect(pillFor({ status: "live", pending: 0, role: "presenter" })).toEqual({ cls: "connected", text: "Live", sub: "" });
  expect(pillFor({ status: "catching-up", pending: 3, role: "presenter" }).sub).toBe("3 edits waiting");
  expect(pillFor({ status: "catching-up", pending: 3, role: "viewer" }).sub).toBe("");
  expect(pillFor({ status: "live", online: false, pending: 1, role: "annotator" })).toEqual({ cls: "offline", text: "Offline", sub: "1 edit waiting" });
  expect(pillFor({ status: "live", role: "viewer" }).text).toBe("View only");
  expect(pillFor({ status: "live", role: "presenter", readOnly: true }).cls).toBe("readonly");
  expect(pillFor({ status: "refused", role: "presenter" }).cls).toBe("offline");
});

test("panel model follows the selection, else the next-shape style", () => {
  const ed = new Editor(); ed.setSize(800, 600);
  expect(propsModel(ed)).toMatchObject({ count: 0, strokeWidth: 2, font: "sans", fontSize: 20, arrowType: "sharp" });
  ed.setTool("rectangle"); ed.pointerDown({ x: 10, y: 10 }); ed.pointerMove({ x: 100, y: 80 }); ed.pointerUp({ x: 100, y: 80 });
  ed.setStyle({ strokeWidth: 4, backgroundColor: "#a5d8ff", roundness: { type: 3 } });
  expect(propsModel(ed)).toMatchObject({ count: 1, strokeWidth: 4, backgroundColor: "#a5d8ff", round: true });
  // Every Properties row has a value the editor reports back as on.
  for (const [, , prop] of STYLE_ROWS) expect(prop in ed.style || prop === "roundness").toBe(true);
  const avail = availableFor({ eds: { board: ed, notes: new Editor() } });
  expect(avail("arrange")).toBe(true); expect(avail("frames")).toBe(false);
  ed.select([]); expect(avail("arrange")).toBe(false);
});

test("panel state: tabs and stack through applyPanel; sections hide when empty", () => {
  let s = defaultPanel();
  s = applyPanel(s, { type: "tab", id: "animate" });
  expect(s.mode).toBe("tabs");
  const secs = panelSections(s, id => id !== "arrange" && id !== "frames");
  expect(secs.filter(x => x.active).map(x => x.id)).toEqual(["animate"]);
  expect(secs.map(x => x.id)).not.toContain("arrange");
  s = applyPanel(s, { type: "mode", mode: "stack" });
  expect(panelSections(s).every(x => x.active)).toBe(true);
});

test("library round-trips through storage; junk reads as empty", () => {
  const store = memoryStore(), mem = { set: (k, v) => store.set(k, v) };
  expect(loadLibrary(store)).toEqual([]);
  mem.set("plenary.library", "{not json"); expect(loadLibrary(store)).toEqual([]);
  const ed = new Editor(); ed.setTool("ellipse"); ed.pointerDown({ x: 0, y: 0 }); ed.pointerMove({ x: 50, y: 50 }); ed.pointerUp({ x: 50, y: 50 });
  const item = ed.libraryItem("Dot");
  saveLibrary(store, [item]);
  expect(loadLibrary(store).map(i => i.name)).toEqual(["Dot"]);
  // An unavailable store (private mode, blocked site data): reads as empty, saving never throws.
  const gone = memoryStore({ unavailable: true });
  expect(loadLibrary(gone)).toEqual([]);
  expect(() => saveLibrary(gone, [item])).not.toThrow();
});

test("SVG export: board only, cropped, sanitised", () => {
  const ed = new Editor(); ed.setSize(800, 600);
  ed.setTool("rectangle"); ed.pointerDown({ x: 100, y: 100 }); ed.pointerMove({ x: 300, y: 200 }); ed.pointerUp({ x: 300, y: 200 });
  ed.setTool("text"); ed.pointerDown({ x: 120, y: 260 }); ed.setText("a <b>&\"x\""); ed.commitText();
  const svg = exportSvg(ed.doc, { scale: 2 });
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("a &lt;b&gt;&amp;&quot;x&quot;");
  expect(svg).not.toContain("<b>");
  const [, w, h, vw] = /width="([\d.]+)" height="([\d.]+)" viewBox="0 0 (\d+)/.exec(svg);
  expect(+w).toBe(+vw * 2);
  expect(+vw).toBeLessThan(300);                        // cropped to the drawing (+32 padding), not the view
  // Untrusted colours and image URLs never reach the markup.
  const bad = toSvg([{ t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "red\" onload=\"x" }, { t: "image", fileId: "f", x: 0, y: 0, w: 1, h: 1 }],
    { width: 10, height: 10, files: { f: { dataURL: "javascript:alert(1)" } } });
  expect(bad).not.toContain("onload"); expect(bad).not.toContain("javascript"); expect(bad).toContain("#888888");
  // White page ignores the theme; dark theme uses the dark page for a board without its own color.
  expect(exportSvg(ed.doc, { page: "white", theme: "dark" })).toContain('fill="#ffffff"');
  expect(exportSvg(ed.doc, { theme: "dark" })).toContain('fill="#111113"');
});

test("PNG export paints the same items at scale into a canvas", () => {
  const ed = new Editor(); ed.setSize(800, 600);
  ed.setTool("ellipse"); ed.pointerDown({ x: 10, y: 10 }); ed.pointerMove({ x: 110, y: 60 }); ed.pointerUp({ x: 110, y: 60 });
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : (...a) => calls.push(k)), set: () => true });
  const CTX = {};
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  paintPng(ed.doc, canvas, { scale: 2 });
  const svg = exportSvg(ed.doc, { scale: 2 }), [, w, h] = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  expect([canvas.width, canvas.height]).toEqual([Math.round(+w), Math.round(+h)]);
  expect(calls).toContain("fillRect");                  // the page
  expect(calls).toContain("stroke");                    // the ellipse
});

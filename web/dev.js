// @ts-check
// Dev page: two core Editors side by side, each bound (web/core/sync.js) to one in-process reference Room
// (web/adapters/transport/local.js), each painted by web/adapters/dom/paint.js. A composition root. A bare tool picker from TOOLS and nothing else: the product chrome comes after
// the design mock. Everything protocol-side goes through web/core/sync.js.

import { Editor, TOOLS } from "../packages/core/editor.js";
import { bindEditor } from "./core/sync.js";
import { localRoom } from "./adapters/transport/local.js";
import { browserClock } from "./adapters/clock/browser.js";
import { paint, imageCache, THEMES } from "./adapters/dom/paint.js";

const USERS = { "dev-owner": { user: "ada", role: "owner" }, "dev-editor": { user: "bo", role: "editor" } };
const net = localRoom({ users: USERS, auto: true });
const clock = browserClock();

let themeName = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
const panes = [];

// Browser key names → the GPUI-style names core's Editor.key takes.
const KEYS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Backspace: "backspace", Delete: "delete", Escape: "escape", Enter: "enter", " ": "space", PageUp: "pageup", PageDown: "pagedown", Tab: "tab" };
const keyName = e => KEYS[e.key] ?? (/^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
const mods = e => ({ shift: e.shiftKey, alt: e.altKey, cmd: e.metaKey, ctrl: e.ctrlKey });
const BUTTONS = ["left", "middle", "right"];

function addPane(token, label) {
  const el = document.createElement("section"); el.className = "pane";
  el.innerHTML = `<div class="bar"></div><div class="stage"><canvas tabindex="0"></canvas><textarea spellcheck="false"></textarea></div>`;
  document.getElementById("panes").append(el);
  const bar = el.querySelector(".bar"), stage = el.querySelector(".stage"), canvas = el.querySelector("canvas"), input = el.querySelector("textarea");
  const ctx = canvas.getContext("2d");

  const editor = new Editor();
  const pane = { editor, canvas, dirty: true, seen: -1, space: false };
  /** @type {{ cancelGesture(): void, status: string, pending: number }} */
  const sync = /** @type {any} */ (bindEditor(editor, { transport: net.join(), token, board: "b1", client: label, clock, onStatus: () => { pane.dirty = true; } }));
  pane.sync = sync;
  const image = imageCache(() => editor.doc.files, () => { pane.dirty = true; });

  // Tool picker: TOOLS as they are, nothing more.
  /** @type {[string, HTMLButtonElement][]} */
  const buttons = TOOLS.map(t => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = t.icon; b.title = `${t.name} (${t.keys.join(", ")})`;
    b.onclick = () => { editor.setTool(t.id); canvas.focus(); };
    bar.append(b); return [t.id, b];
  });
  const who = document.createElement("span"); who.className = "who"; bar.append(who);

  const at = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // Pointer events carry no click count (detail is 0 on pointerdown), and preventDefault on pointerdown
  // suppresses the mouse events that would: count presses at the same spot within 400 ms ourselves.
  let last = { t: 0, x: 0, y: 0, n: 0 };
  const countClick = e => {
    const p = at(e), now = performance.now();
    const n = now - last.t < 400 && Math.hypot(p.x - last.x, p.y - last.y) < 6 ? last.n + 1 : 1;
    last = { t: now, ...p, n }; return n;
  };
  let clicks = 1;
  const pmods = e => ({ ...mods(e), button: BUTTONS[e.button] ?? "left", clickCount: clicks, space: pane.space });

  canvas.addEventListener("pointerdown", e => {
    canvas.focus(); canvas.setPointerCapture(e.pointerId);
    clicks = Math.max(e.detail || 0, countClick(e));
    editor.pointerDown(at(e), pmods(e)); e.preventDefault();
  });
  canvas.addEventListener("pointermove", e => editor.pointerMove(at(e), pmods(e)));
  canvas.addEventListener("pointerup", e => editor.pointerUp(at(e), pmods(e)));
  // A cancelled pointer (touch taken over by the browser) must not commit a half-made gesture.
  canvas.addEventListener("pointercancel", () => sync.cancelGesture());
  // Lines/pages → pixels; a mouse wheel's ctrl+zoom steps are clamped (one notch of 240 would hit the cap).
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? editor.size.h : 1, zoom = e.ctrlKey || e.metaKey;
    const clamp = v => (zoom ? Math.max(-50, Math.min(50, v * k)) : v * k);
    editor.wheel({ x: clamp(e.deltaX), y: clamp(e.deltaY) }, at(e), mods(e));
  }, { passive: false });
  canvas.addEventListener("keydown", e => {
    if (e.key === " ") pane.space = true;
    if (editor.key(keyName(e), mods(e))) e.preventDefault();
  });
  canvas.addEventListener("keyup", e => { if (e.key === " ") pane.space = false; });

  // Typing: core asks the adapter for a text input where editor.textBox() says.
  input.addEventListener("input", () => editor.setText(input.value));
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); editor.commitText(); canvas.focus(); }
  });
  input.addEventListener("blur", () => { if (editor.text) editor.commitText(); });
  pane.syncText = () => {
    const box = editor.textBox();
    if (!box) { if (input.style.display !== "none") input.style.display = "none"; return; }
    Object.assign(input.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, fontSize: `${box.size}px`, textAlign: box.align });
    if (input.value !== editor.text.value) input.value = editor.text.value;
    if (document.activeElement !== input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  };

  new ResizeObserver(() => {
    const r = stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    editor.setSize(r.width, r.height); pane.dirty = true;
  }).observe(stage);

  pane.draw = () => {
    if (editor.needsTick()) editor.tick();   // laser fade, timeline playback
    if (!pane.dirty && pane.seen === editor.version) return;
    pane.dirty = false; pane.seen = editor.version;
    const theme = THEMES[themeName];
    paint(ctx, editor.displayList(theme), { width: editor.size.w, height: editor.size.h, dpr: canvas.width / Math.max(1, editor.size.w), background: theme.bg, image });
    canvas.style.cursor = editor.cursor() ?? "default";
    for (const [id, b] of buttons) b.setAttribute("aria-pressed", String(editor.tool === id));
    who.textContent = `${label} · ${USERS[token].role} · ${sync.status}${sync.pending ? ` · ${sync.pending} pending` : ""}`;
    pane.syncText();
  };
  panes.push(pane);
}

addPane("dev-owner", "ada");
addPane("dev-editor", "bo");

const setTheme = name => { themeName = name; document.documentElement.dataset.theme = name; for (const p of panes) p.dirty = true; };
setTheme(themeName);
document.getElementById("theme").onclick = () => setTheme(themeName === "dark" ? "light" : "dark");

const seq = document.getElementById("seq");
(function frame() {
  for (const p of panes) p.draw();
  seq.textContent = `room seq ${net.seq}`;
  requestAnimationFrame(frame);
})();

// For poking at it from the console.
globalThis.plenary = { net, panes };

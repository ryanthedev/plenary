// Dev page for web/collab: the collab UI over the fake port. Fake data only. Two peers (Maya presenting with a
// laser and a drag, Dev selecting), annotators with cursors, a hostile display name, and a crowd of viewers
// sending emotes. Click the board to comment on a spot; click a shape to comment on it.
import { createFakePort } from "./fake-port.js";
import { mountCollab } from "./ui.js";
import { h, replace } from "./dom.js";
import { ROLES, EMOTES } from "./limits.js";

const q = new URLSearchParams(location.search);
const pick = (k, list, d) => (list.includes(q.get(k)) ? q.get(k) : d);
const role = pick("role", ROLES, "editor"), theme = pick("theme", ["light", "dark"], "light"), still = q.get("still") === "1";
document.documentElement.dataset.theme = theme;
const t0 = Date.now(), MIN = 60_000;

// ── a fake board: a few shapes (world units) ──
const SHAPES = [
  { id: "rev", x: 60, y: 80, width: 200, height: 110, fill: "#b2f2bb", label: "Revenue +18%" },
  { id: "nps", x: 290, y: 80, width: 200, height: 110, fill: "#a5d8ff", label: "NPS 61" },
  { id: "regions", x: 520, y: 80, width: 220, height: 110, fill: "#ffec99", label: "3 new regions" },
  { id: "review", x: 300, y: 300, width: 170, height: 90, fill: "#eebefa", label: "Review?" },
  { id: "ship", x: 560, y: 300, width: 150, height: 80, fill: "#b2f2bb", label: "Ship" },
];
const NOTES = [
  { id: "n1", type: "rectangle", x: 60, y: 440, width: 170, height: 70, backgroundColor: "#ffec99", updated: 3 },
  { id: "n1t", type: "text", containerId: "n1", text: "Can we see Q3 next to Q4?", x: 0, y: 0 },
  { id: "n2", type: "rectangle", x: 250, y: 440, width: 170, height: 70, backgroundColor: "#ffc9c9", updated: 2 },
  { id: "n2t", type: "text", containerId: "n2", text: "Hiring plan for the new regions?", x: 0, y: 0 },
  { id: "n3", type: "freedraw", x: 60, y: 120, width: 200, height: 20, strokeColor: "#ffd43b", updated: 1 },
  { id: "n4", type: "rectangle", x: 440, y: 440, width: 170, height: 70, backgroundColor: "#b2f2bb", updated: 4 },
  { id: "n4t", type: "text", containerId: "n4", text: "<img src=x onerror=alert('note')> Ship it!", x: 0, y: 0 },
];
const elements = Object.fromEntries(SHAPES.map(s => [`board:${s.id}`, s]));
const EVIL = "<img src=x onerror=alert(1)> Mallory";
const me = { user: "me", name: role === "viewer" ? "You" : "Jordan P.", client: "me-tab" };

const port = createFakePort({
  role, me, elements, notes: NOTES, autoAck: false,
  noteAuthors: { n1: "pri", n2: "me", n3: "pri", n4: "mal" },
  threads: [
    { id: "ship", anchor: { stream: "board", element: "ship", x: 710, y: 300 }, by: "maya", name: "Maya", at: t0 - 4 * MIN, comments: [
      { id: "ship", by: "maya", name: "Maya", at: t0 - 4 * MIN, text: "Ship date is Jan 14 — is that locked?", reactions: { "👀": ["pri", "tom", "me"] } },
      { id: "s2", by: "dev", name: "Dev K.", at: t0 - 3 * MIN, text: "Pending the security review.\nJan 21 is more likely.", reactions: { "👍": ["maya", "pri"], "😬": ["tom"] } },
      { id: "s3", by: "mal", name: EVIL, at: t0 - 1 * MIN, text: "</p><script>alert('comment')</script> +1, can the board show that risk?", reactions: {} }] },
    { id: "spot", anchor: { point: { x: 820, y: 470 } }, by: "tom", name: "Tom", at: t0 - 2 * MIN, comments: [
      { id: "spot", by: "tom", name: "Tom", at: t0 - 2 * MIN, text: "Will this board stay open after the meeting?", reactions: {} }] },
    { id: "nps", anchor: { stream: "board", element: "nps", x: 490, y: 80 }, by: "dev", name: "Dev K.", at: t0 - 9 * MIN, resolved: { by: "maya", name: "Maya", at: t0 - 6 * MIN }, comments: [
      { id: "nps", by: "dev", name: "Dev K.", at: t0 - 9 * MIN, text: "NPS was 58 in the deck, which is right?", reactions: {} },
      { id: "n2", by: "maya", name: "Maya", at: t0 - 6 * MIN, text: "61 is the final number. Fixed the deck.", reactions: {} }] },
    { id: "gone", anchor: { stream: "board", element: "deleted-chart", x: 780, y: 120 }, by: "pri", name: "Priya", at: t0 - 5 * MIN, comments: [
      { id: "gone", by: "pri", name: "Priya", at: t0 - 5 * MIN, text: "This chart was here a minute ago.", reactions: {} }] },
  ],
});

// ── the view: fit the board into the canvas ──
const canvas = document.getElementById("canvas"), board = document.getElementById("board");
const view = { x: 0, y: 0, scale: 1, toScreen(p) { return { x: (p.x + this.x) * this.scale, y: (p.y + this.y) * this.scale }; }, toWorld(p) { return { x: p.x / this.scale - this.x, y: p.y / this.scale - this.y }; } };
function fit() {
  const r = canvas.getBoundingClientRect(), W = 900, H = 560;
  view.scale = Math.min(1.2, (r.width - 24) / W, (r.height - 90) / H);
  view.x = (r.width / view.scale - W) / 2; view.y = 16 / view.scale;
}
function paintBoard() {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  board.width = r.width * dpr; board.height = r.height * dpr;
  const ctx = board.getContext("2d"), ink = theme === "dark" ? "#e9ecef" : "#1e1e1e";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  ctx.save(); ctx.translate(view.x * view.scale, view.y * view.scale); ctx.scale(view.scale, view.scale);
  ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.font = "16px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const s of SHAPES) { ctx.fillStyle = s.fill; ctx.beginPath(); ctx.roundRect(s.x, s.y, s.width, s.height, 10); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#1e1e1e"; ctx.fillText(s.label, s.x + s.width / 2, s.y + s.height / 2); }
  ctx.beginPath(); ctx.moveTo(470, 345); ctx.lineTo(558, 345); ctx.stroke();
  for (const n of NOTES.filter(n => n.type === "rectangle")) { ctx.fillStyle = n.backgroundColor; ctx.fillRect(n.x, n.y, n.width, n.height); ctx.fillStyle = "#1e1e1e"; ctx.font = "13px -apple-system, sans-serif"; ctx.fillText(NOTES.find(t => t.containerId === n.id).text.slice(0, 26), n.x + n.width / 2, n.y + n.height / 2); }
  ctx.globalAlpha = 0.45; ctx.strokeStyle = "#ffd43b"; ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(70, 165); ctx.lineTo(250, 165); ctx.stroke();
  ctx.restore();
}

fit(); paintBoard();
const collab = mountCollab({ root: canvas, canvasOverlay: document.getElementById("overlay"), port, view, theme });
document.getElementById("avatars").replaceWith(collab.parts.avatars);
document.getElementById("hudBC").append(collab.parts.emotes);
document.getElementById("hudBR").append(collab.parts.emoteButton);
document.getElementById("drawer").append(collab.parts.drawer);
collab.showDrawer(q.get("drawer") === "notes" ? "notes" : "comments");
addEventListener("resize", () => { fit(); paintBoard(); collab.layout(); });

// Theme toggle and a role switcher (dev only).
const themeBtn = document.getElementById("themeBtn");
themeBtn.textContent = theme === "dark" ? "☀" : "☾";
themeBtn.onclick = () => { q.set("theme", theme === "dark" ? "light" : "dark"); location.search = q; };
replace(document.getElementById("devbar"), "as ", h("select", { onchange: e => { q.set("role", e.currentTarget.value); location.search = q; } },
  ROLES.map(r => { const o = h("option", { value: r }, r); if (r === role) o.selected = true; return o; })),
  " ", h("button.btn", { onclick: () => port.ackAll() }, "ack pending"), " ", h("button.btn", { onclick: () => port.setStatus(port.status === "live" ? "connecting" : "live") }, "toggle live"));

// Click the board: comment on a shape, or on a spot. Pointer moves are my cursor.
canvas.addEventListener("pointermove", e => { const r = canvas.getBoundingClientRect(); collab.pointer(view.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top })); });
board.addEventListener("click", e => {
  const r = canvas.getBoundingClientRect(), w = view.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  const s = SHAPES.find(s => w.x >= s.x && w.x <= s.x + s.width && w.y >= s.y && w.y <= s.y + s.height);
  collab.startComment(w, s ? { stream: "board", element: s.id } : null);
});

// ── the fake room's others ──
port.here({ writers: [
  { user: "maya", name: "Maya", role: "owner" }, { user: "dev", name: "Dev K.", role: "editor" },
  { user: "pri", name: "Priya", role: "annotator" }, { user: "tom", name: "Tom", role: "annotator" }, { user: "mal", name: EVIL, role: "commenter" },
  ...Array.from({ length: 12 }, (_, i) => ({ user: `a${i}`, name: `Annotator ${i}`, role: "annotator" })),
], writerCount: 42, viewers: 12408 });
function peers(t) {
  const a = t / 900;
  const laser = Array.from({ length: 24 }, (_, i) => { const b = a - i * 0.06; return [630 + Math.cos(b * 2) * 120, 135 + Math.sin(b * 2) * 50, t - i * 25]; }).reverse();
  port.presence([
    { user: "maya", client: "m1", k: "cursor", x: laser.at(-1)[0], y: laser.at(-1)[1] },
    { user: "maya", client: "m1", k: "laser", pts: laser.slice(-6) },
    { user: "dev", client: "d1", k: "cursor", x: 420 + Math.sin(a) * 30, y: 330 },
    { user: "dev", client: "d1", k: "select", stream: "board", ids: ["review"] },
    { user: "pri", client: "p1", k: "cursor", x: 160 + Math.cos(a / 2) * 40, y: 150 },
    { user: "tom", client: "t1", k: "cursor", x: 330, y: 480 + Math.sin(a) * 10 },
    { user: "mal", client: "x1", k: "cursor", x: 760, y: 420 },
  ]);
  port.setPreviews("board", [{ el: { id: "tmp", type: "freedraw", x: 600 + Math.sin(a) * 6, y: 220, width: 90, height: 40 }, user: "maya", client: "m1" }]);
}
let crowd = 0;
function tickCrowd() {
  crowd++;
  const counts = { "👏": 1200 + crowd * 7, "👍": 482, "🎉": 340, "❤️": 210, "😂": 36, "🔥": 58 };
  port.emotes({ counts: Object.fromEntries(Object.entries(counts).map(([e, n]) => [e, Math.round(n / 20)])) });
  if (crowd % 3 === 0) port.presence([{ user: "pri", client: "p1", k: "emote", e: EMOTES[crowd % 8] }]);
}
if (still) {
  // The same frame over and over (lasers fade and peers expire if nothing repeats them).
  setInterval(() => peers(4000), 50);
  for (let i = 0; i < 20; i++) tickCrowd();
  const floatSome = () => port.presence([{ user: "maya", client: "m1", k: "emote", e: "👏" }, { user: "pri", client: "p1", k: "emote", e: "🎉" }, { user: "tom", client: "t1", k: "emote", e: "🔥" }]);
  floatSome(); setInterval(floatSome, 1000);
} else {
  setInterval(() => peers(Date.now() - t0), 50);
  setInterval(tickCrowd, 500);
}
const open = q.get("open");
if (q.get("pending") === "1") { port.reply({ id: "p1", thread: "ship", text: "Mine, not acknowledged yet" }); port.react({ id: "s2", emoji: "🔥" }); }
if (open === "compose") collab.startComment({ x: 120, y: 330 });
else if (open) collab.openThread(open);
if (q.get("picker") === "1") collab.parts.emotes.lastChild.click();
if (q.get("conn") === "offline") setTimeout(() => port.setStatus("connecting"), 300);
window.collab = collab; window.port = port;

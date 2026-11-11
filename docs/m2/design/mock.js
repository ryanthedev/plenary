// Plenary design mock: renders every surface from fake data. State lives in the URL so any view can be
// linked or screenshotted: ?role=&theme=&conn=&panel=&open=&drawer=&sheet=&src=1 (README.md lists them).
// Names follow packages/core: TOOLS (editor.js), SECTIONS (panel.js), STROKES/FILLS/WIDTHS/STYLES, PRESETS (anim.js).

// ── copied from packages/core (values verbatim) ──
const TOOLS = [
  { id: "select", keys: ["v", "1"], icon: "↖", name: "Select" },
  { id: "hand", keys: ["h"], icon: "✋", name: "Hand" },
  { id: "rectangle", keys: ["r", "2"], icon: "▭", name: "Rectangle" },
  { id: "diamond", keys: ["d", "3"], icon: "◇", name: "Diamond" },
  { id: "ellipse", keys: ["o", "4"], icon: "◯", name: "Ellipse" },
  { id: "arrow", keys: ["a", "5"], icon: "→", name: "Arrow" },
  { id: "line", keys: ["l", "6"], icon: "╱", name: "Line" },
  { id: "freedraw", keys: ["p", "7"], icon: "✎", name: "Pen" },
  { id: "text", keys: ["t", "8"], icon: "T", name: "Text" },
  { id: "eraser", keys: ["e", "0"], icon: "⌫", name: "Eraser" },
  { id: "frame", keys: ["f"], icon: "#", name: "Frame" },
  { id: "laser", keys: ["k"], icon: "✦", name: "Laser" },
];
const STROKES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599"];
const FILLS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#eebefa", "#99e9f2"];
const SECTIONS = [
  { id: "properties", title: "Properties" }, { id: "arrange", title: "Arrange" }, { id: "frames", title: "Frames" },
  { id: "animate", title: "Animate" }, { id: "layers", title: "Layers" }, { id: "library", title: "Library" },
];
const PRESET_NAMES = ["fade", "rise", "slide", "pop", "draw", "pulse", "out"];

// Extras the brief asks for that are not core tool ids.
const EXTRAS = [
  { id: "image", icon: "⊡", name: "Image", src: "core addImage · v1 Blobs (signed URLs)" },
  { id: "note", icon: "❏", name: "Note", src: "notes stream · new in web/" },
  { id: "highlighter", icon: "▰", name: "Highlighter", src: "v1 draft: freedraw in notes · new in web/" },
];

// Which tools each role gets. Presenter = owner/editor, annotator = annotator (PROTOCOL.md roles).
const ROLE_TOOLS = {
  presenter: { tools: TOOLS.map(t => t.id), extras: ["image", "note", "highlighter"] },
  annotator: { tools: ["select", "hand", "arrow", "freedraw", "text", "eraser"], extras: ["image", "note", "highlighter"] },
  viewer: { tools: ["hand"], extras: [] },
};
const ME = { presenter: { name: "Alex R.", ini: "AR" }, annotator: { name: "Jordan P.", ini: "JP" }, viewer: { name: "You", ini: "Y" } };

const PEOPLE = {
  maya: { name: "Maya", ini: "M", c: "var(--u-maya)", role: "presenter" },
  dev: { name: "Dev K.", ini: "DK", c: "var(--u-dev)", role: "presenter" },
  priya: { name: "Priya", ini: "P", c: "var(--u-priya)", role: "annotator" },
  tom: { name: "Tom", ini: "T", c: "var(--u-tom)", role: "annotator" },
  sam: { name: "Sam", ini: "S", c: "var(--u-sam)", role: "annotator" },
  me: { name: "You", ini: "JP", c: "var(--u-me)", role: "annotator" },
};

const NOTES = [
  { who: "priya", text: "Can we see Q3 next to Q4?", at: "2 min", fill: "#ffec99", box: [60, 530, 190] },
  { who: "tom", text: "Which 3 regions?  (+ arrow to the ellipse)", at: "1 min", fill: "#ffec99", box: [270, 545, 190] },
  { who: "me", text: "Hiring plan for the new regions?", at: "now", fill: "#ffc9c9", box: [480, 530, 190] },
  { who: "sam", text: "🎉 Ship it!", at: "now", fill: "#b2f2bb", box: [980, 512, 170] },
  { who: "priya", text: "Highlight on Revenue +18%", at: "3 min", fill: "#ffd43b", kind: "highlight" },
  { who: "tom", text: "Is uptime per region or global?", at: "4 min", fill: "#ffec99" },
  { who: "sam", text: "Love the launch flow", at: "5 min", fill: "#b2f2bb" },
];
const THREADS = {
  thread: { pin: [1380, 300], who: "maya", anchor: "On “Ship” · Launch flow", src: "v1 comments (element anchor)", msgs: [
    ["maya", "4 min", "Ship date is Jan 14 — is that locked?", [["👀", 14, true]]],
    ["dev", "3 min", "Pending the security review. Jan 21 is more likely.", [["👍", 31, false], ["😬", 6, false]]],
    ["priya", "1 min", "+1, can the board show that risk?", [["👍", 9, false]]]] },
  point: { pin: [700, 610], who: "tom", anchor: "On a spot on the board · no element", src: "v1 comments (point anchor)", msgs: [
    ["tom", "2 min", "Will this board stay open after the meeting?"]] },
  resolved: { pin: [392, 150], who: "dev", anchor: "On “NPS 61” · Q4 at a glance", resolved: "Resolved by Maya · 6 min ago", src: "v1 comments (resolved)", msgs: [
    ["dev", "9 min", "NPS was 58 in the deck, which is right?"],
    ["maya", "6 min", "61 is the final number. Fixed the deck."]] },
};
// Emotes (presence, never saved): a fixed set; the numbers are the room's live counts (v1 draft `emotes`).
const REACTIONS = [["👍", "482"], ["👏", "1.2k"], ["🎉", "340"], ["❤️", "210"], ["😂", "36"], ["❓", "58"]];
const EMOTES = ["👍", "👏", "🎉", "❤️", "😂", "❓", "🔥", "👀"];   // the one fixed set; the bar shows the first six

// ── state ──
const DEFAULTS = { role: "presenter", theme: "light", conn: "connected", panel: "stack", tab: "properties", open: "", drawer: "", sheet: "", src: "" };
const S = { ...DEFAULTS };
const q = new URLSearchParams(location.search);
// Only known values are taken from the URL (anything else falls back to the default), so no URL text ever
// reaches the innerHTML templates below.
const VALID = {
  role: ["presenter", "annotator", "viewer"], theme: ["light", "dark"], conn: ["connected", "reconnecting", "offline", "readonly"],
  panel: ["stack", "tabs", "closed"], tab: SECTIONS.map(s => s.id), open: ["", "thread", "point", "resolved", "emote", "mermaid", "export"],
  drawer: ["", "notes", "comments"], sheet: ["", "panel", "tools", "notes", "comments"], src: ["", "1"],
};
for (const k of Object.keys(DEFAULTS)) if (q.has(k) && VALID[k].includes(q.get(k))) S[k] = q.get(k);
if (!q.has("drawer") && S.role === "annotator") S.drawer = "notes";

const $ = s => document.querySelector(s);
const h = (html) => html;   // templates are plain strings
const isPhone = () => window.matchMedia("(max-width: 640px)").matches;
const pill = () => (S.conn === "connected" && S.role === "viewer" ? "readonly" : S.conn);
const canEdit = () => S.role !== "viewer" && S.conn !== "readonly";
const key = t => t.keys.map(k => k.toUpperCase()).join(" ");

function save() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(S)) if (v !== DEFAULTS[k] && !(k === "drawer" && S.role === "annotator" && v === "notes")) p.set(k, v);
  if (S.role === "annotator" && !S.drawer) p.set("drawer", "");
  history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
}
function set(k, v) { if (!VALID[k]?.includes(v)) return; S[k] = v; save(); render(); }

// ── view (world → screen) ──
let V = { x: 0, y: 0, s: 1 };
function fitView() {
  const c = $("#canvas").getBoundingClientRect();
  if (isPhone()) { const s = Math.min(0.56, (c.width - 16) / 650); V = { s, x: 8 - 40 * s, y: 70 - 40 * s }; }
  else {
    const W = 1470, H = 650, s = Math.min(0.9, (c.width - 40) / W, (c.height - 80) / H);
    V = { s, x: (c.width - W * s) / 2 - 35 * s, y: Math.max(16, (c.height - 60 - H * s) / 2) - 30 * s };
  }
  $("#world").setAttribute("transform", `translate(${V.x} ${V.y}) scale(${V.s})`);
}
const sx = x => V.x + x * V.s, sy = y => V.y + y * V.s;

// ── pieces ──
const av = (p, extra = "") => `<span class="av ${extra}" style="background:${p.c}" title="${p.name}">${p.ini}</span>`;
function toolBtn(t, on, extra = "") {
  return `<button class="tb ${on ? "on" : ""} ${extra}" title="${t.name}${t.keys ? " — " + key(t) : ""}" ${canEdit() || t.id === "hand" ? "" : "disabled"}>
    <span class="ic">${t.icon}</span>${t.keys ? `<span class="k">${t.keys[0].toUpperCase()}</span>` : ""}</button>`;
}

function topbar() {
  const r = ROLE_TOOLS[S.role], tools = TOOLS.filter(t => r.tools.includes(t.id)), extras = EXTRAS.filter(e => r.extras.includes(e.id));
  const active = S.role === "annotator" ? "highlighter" : S.role === "viewer" ? "hand" : "select";
  const P = pill(), waiting = S.role === "viewer" ? "" : "3 edits waiting";   // viewers write nothing durable: never pending
  const pillText = { connected: ["Live", ""], reconnecting: ["Reconnecting…", waiting], offline: ["Offline", waiting], readonly: ["View only", ""] }[P];
  const people = S.role === "viewer" ? [PEOPLE.maya, PEOPLE.dev] : [PEOPLE.maya, PEOPLE.dev, PEOPLE.priya, PEOPLE.tom, PEOPLE.sam];
  return `
    <div class="tools desk-only" data-src="core TOOLS + Q lock">
      ${tools.map(t => toolBtn(t, t.id === active)).join("")}
      ${extras.length ? `<span class="sep"></span>` : ""}
      ${extras.map(e => `<span data-src="${e.src}" style="display:inline-flex">${toolBtn(e, e.id === active, "new")}</span>`).join("")}
      ${S.role !== "viewer" ? `<span class="sep"></span>
        <button class="tb ${S.role === "presenter" ? "" : ""}" title="Keep the tool after drawing (Q)" ${canEdit() ? "" : "disabled"}><span class="ic">🔓</span><span class="k">Q</span></button>
        <button class="tb" title="Undo (⌘Z)" ${canEdit() ? "" : "disabled"} data-src="core undo"><span class="ic">↶</span></button>
        <button class="tb" title="Redo (⌘⇧Z)" ${canEdit() ? "" : "disabled"} data-src="core redo"><span class="ic">↷</span></button>` : ""}
    </div>
    <span class="board-name">Q4 All-hands <small>· Acme Corp</small></span>
    <span class="spacer"></span>
    ${S.role === "presenter" ? `
      <button class="btn ghost desk-only" data-src="core importMermaid" title="Insert a Mermaid flowchart" ${dis()} onclick="set('open','mermaid')">◇→</button>
      <button class="btn ghost desk-only" data-src="core exportScene · SVG/PNG writers new in web/" title="Export SVG / PNG (⌘⇧E)" ${dis()} onclick="set('open','export')">⤓</button>` : ""}
    <button class="btn ghost desk-only" data-src="${S.drawer === "comments" ? "v1 comments" : "v0 notes stream"}" onclick="set('drawer', S.drawer ? '' : 'notes')">❏ Notes <span class="dim">214</span></button>
    <div class="avatars" data-src="v1 here (writers + viewer count)">
      <span class="stack">${people.slice(0, isPhone() ? 2 : 5).map(p => av(p, "live")).join("")}<span class="av more desk-only">+37</span></span>
      <span class="watching"><span class="desk-only">👁 </span><b>${isPhone() ? "12.4k" : "12,408"}</b> <span class="desk-only">watching</span></span>
    </div>
    <span class="pill ${P}" data-src="new in web/ (Replica pending, welcome.role)" title="${pillTitle(P)}"><span class="dot"></span>${pillText[0]}${pillText[1] ? ` <span class="sub">· ${pillText[1]}</span>` : ""}</span>
    ${S.role !== "viewer" ? `<button class="tb desk-only ${S.panel !== "closed" ? "on" : ""}" title="Side panel (I)" onclick="set('panel', S.panel==='closed'?'stack':'closed')"><span class="ic">◧</span><span class="k">I</span></button>` : ""}
    <button class="tb ${S.role === "viewer" ? "" : "theme-btn"}" title="Light / dark" data-src="core DARK/LIGHT" onclick="set('theme', S.theme==='dark'?'light':'dark')"><span class="ic">${S.theme === "dark" ? "☀" : "☾"}</span></button>`;
}
function pillTitle(P) {
  if (S.role === "viewer" && P !== "readonly") return P === "reconnecting" ? "Lost the connection; retrying. The live view is paused." : "No connection. The live view is paused until you reconnect.";
  return {
    connected: "Connected: every edit is acknowledged by the board's room.",
    reconnecting: "Lost the connection; retrying. Edits not yet acknowledged are kept and resent with the same ids (PROTOCOL.md rule 2).",
    offline: "No connection. Unacknowledged edits stay in this tab and are resent on reconnect; closing the tab loses them.",
    readonly: "The server gave this session the viewer role (welcome.role): nothing durable you do is sent. Emotes still are.",
  }[P];
}

function row(label, k, opts) { return `<div class="row"><span class="lab">${label}${k ? `<i>${k}</i>` : ""}</span><span class="opts">${opts}</span></div>`; }
// Write controls are disabled when this session can't edit (viewer role or read-only); `view` chips only move the view.
const dis = view => (view || canEdit() ? "" : "disabled");
const chip = (txt, on, title = "", view = false) => `<button class="c ${on ? "on" : ""}" title="${title}" ${dis(view)}>${txt}</button>`;
const sw = (c, on) => c === "transparent" ? `<button class="sw none ${on ? "on" : ""}" title="No fill" ${dis()}></button>` : `<button class="sw ${on ? "on" : ""}" style="background:${c}" title="${c}" ${dis()}></button>`;

function properties(note) {
  return `
    ${row("Stroke", "C", STROKES.map((c, i) => sw(c === "#1e1e1e" ? "var(--ink)" : c, i === 0)).join("") + chip("+", false, "Your palette (panel.js addColor)"))}
    ${row("Fill", "B", FILLS.map((c, i) => sw(c, note ? i === 1 : i === 4)).join("") + chip("+", false, "Your palette"))}
    ${row("Width", "W", ["thin", "bold", "extra"].map((t, i) => chip(t, i === 1, `${[1, 2, 4][i]} px`)).join(""))}
    ${row("Style", "S", ["—", "- -", "···"].map((t, i) => chip(t, i === 0, ["solid", "dashed", "dotted"][i])).join(""))}
    ${note ? "" : row("Sketch", "G", ["clean", "sketch", "loose"].map((t, i) => chip(t, i === 0, `roughness ${i}`)).join(""))}
    ${row("Opacity", "", [100, 75, 50, 25].map(o => chip(o, o === 100)).join(""))}
    ${note ? "" : row("Pattern", "", [["solid", "solid"], ["////", "hachure"], ["xxxx", "cross-hatch"]].map(([t, n], i) => chip(t, i === 0, n)).join(""))}
    ${note ? "" : row("Edges", "", chip("sharp", false) + chip("round", true))}
    ${row("Font", "", ["hand", "sans", "mono"].map(f => chip(f, f === "sans")).join(""))}
    ${row("Text", "= -", [16, 20, 28, 36].map(f => chip(f, f === 20)).join(""))}
    ${note ? "" : `<div class="hint" style="margin:8px 0 4px">With an arrow selected (or the Arrow tool):</div>
      ${row("Arrow", "", chip("╱ sharp", false) + chip("◠ curve", false) + chip("┐ elbow", true, "elbowed: routed around shapes"))}
      ${row("Heads", "", ["none", "→", "↔", "▶", "▷", "●", "◆", "⊣"].map((t, i) => chip(t, i === 1)).join(""))}`}`;
}
const sectionBody = {
  properties: () => properties(false),
  arrange: () => `
    <div class="row"><span class="opts">${["⇤ ⌥A", "⇥ ⌥D", "⤒ ⌥W", "⤓ ⌥S", "↔ ⌥H", "↕ ⌥V"].map(t => chip(t, false)).join("")}</span></div>
    <div class="row"><span class="opts">${["⇹ ⇧H", "⇳ ⇧V", "⤒ ⌘]", "↑ ]", "↓ [", "⤓ ⌘["].map(t => chip(t, false)).join("")}</span></div>
    <div class="row"><span class="opts">${["group ⌘G", "ungroup ⌘⇧G", "dup ⌘D", "lock ⌘⇧L"].map(t => chip(t, false)).join("")}</span></div>
    <div class="row"><span class="opts">${["⟲ 15° <", "⟳ 15° >", "⟳ 90°", "0°"].map(t => chip(t, false)).join("")}</span></div>`,
  frames: () => `
    <div class="list-row on"><span class="dim">1</span> Q4 at a glance</div>
    <div class="list-row"><span class="dim">2</span> Launch flow</div>
    <div class="row" style="margin-top:6px"><span class="opts">${chip("‹ prev <i>PgUp</i>", false, "", true)}${chip("next › <i>PgDn</i>", false, "", true)}${chip("all", false, "Fit everything (⇧1)", true)}</span></div>`,
  animate: () => `
    <div class="row"><span class="opts">${PRESET_NAMES.map(p => chip(p, p === "rise")).join("")}${chip("none", false, "clearAnimation")}</span></div>
    <div class="row"><span class="opts">${chip("▶ play <i>⇧Space</i>", false, "playToggle")}</span></div>
    <div class="hint">Select shapes, pick an effect: they join the timeline in order (start + 150 ms stagger).</div>`,
  layers: () => `
    <div class="list-row"><span>◉</span><span>·</span> Diagram <span class="n">11</span></div>
    <div class="list-row on"><span>◉</span><span>·</span> Layer 1 <span class="n">14</span></div>
    <div class="row" style="margin-top:6px"><span class="opts">${["+", "↑", "↓", "◐", "⇢", "✕"].map(t => chip(t, false)).join("")}</span></div>`,
  library: () => `
    <div class="lib">
      <div class="item"><svg width="44" height="30"><rect x="2" y="2" width="40" height="26" rx="4" fill="#b2f2bb" stroke="var(--ink)"/></svg><span>KPI card</span></div>
      <div class="item"><svg width="40" height="34"><path d="M20 2 L38 17 L20 32 L2 17Z" fill="#eebefa" stroke="var(--ink)"/></svg><span>Decision</span></div>
      <div class="item"><svg width="46" height="22"><rect x="1" y="4" width="16" height="14" rx="3" fill="none" stroke="var(--ink)"/><path d="M18 11 H28" stroke="var(--ink)"/><rect x="29" y="4" width="16" height="14" rx="3" fill="none" stroke="var(--ink)"/></svg><span>Step</span></div>
    </div>
    <div class="row" style="margin-top:8px"><span class="opts">${chip("+ save selection", false, "libraryItem(name)")}</span></div>
    <div class="hint">Click an item to insert it (insertLibraryItem). Drop a .excalidrawlib to add.</div>`,
};
const SEC_SRC = { properties: "core setStyle", arrange: "core align/distribute/reorder/group", frames: "core frames/goToFrame", animate: "core animate/playToggle", layers: "core addLayer…", library: "core libraryItem/insertLibraryItem" };

function panelHtml(inSheet = false) {
  if (S.role === "annotator") {
    return `<div class="sec" data-src="core setStyle (on your note)"><h4>Properties <span>· your note</span></h4>${properties(true)}
      <div class="hint">The board is the presenters'. You change only notes you made; others' notes are locked to you (rule: v0; knowing authors on the client: v1 snapshot noteAuthor).</div></div>`;
  }
  const tabs = S.panel === "tabs" || inSheet;
  const list = SECTIONS.map(s => {
    const title = s.id === "properties" ? `Properties <span>· 1 selected</span>` : s.id === "frames" ? `Frames <span>· 2</span>` : s.id === "library" ? `Library <span>· 3</span>` : s.id === "layers" ? `Layers <span>· double-click to rename</span>` : s.title;
    if (tabs && s.id !== S.tab) return "";
    return `<div class="sec ${!tabs && s.id === "library" ? "" : ""}" data-src="${SEC_SRC[s.id]}"><h4>${title}</h4>${sectionBody[s.id]()}</div>`;
  }).join("");
  const head = inSheet ? "" : `<div class="panel-head" data-src="core panel.js MODES">
    <button class="tb ${S.panel === "stack" ? "on" : ""}" title="Stack" onclick="set('panel','stack')">▤</button>
    <button class="tb ${S.panel === "tabs" ? "on" : ""}" title="Tabs" onclick="set('panel','tabs')">▭</button>
    <button class="tb" title="Fold all">⊟</button><button class="tb" title="Sections, order, width">⚙</button></div>`;
  const tabRow = tabs ? `<div class="tabs">${SECTIONS.map(s => `<button class="${s.id === S.tab ? "on" : ""}" onclick="set('tab','${s.id}')">${s.title}</button>`).join("")}</div>` : "";
  return `${inSheet ? "" : `<div class="edge" title="Drag to resize (180–520 px)"></div>`}${head}${tabRow}${list}`;
}

function drawerHtml(inSheet = false) {
  const which = (inSheet ? S.sheet : S.drawer) || "notes";
  const tabs = `<span class="seg"><button class="${which === "notes" ? "on" : ""}" onclick="set('${inSheet ? "sheet" : "drawer"}','notes')">Notes 214</button><button class="${which === "comments" ? "on" : ""}" onclick="set('${inSheet ? "sheet" : "drawer"}','comments')">Comments 12</button></span>`;
  let body;
  if (which === "notes") {
    body = `<div class="notes-list" data-src="v0 notes stream · authors: v1 noteAuthor">${NOTES.map(n => {
      const p = PEOPLE[n.who], mine = n.who === "me" && S.role === "annotator";
      const acts = !canEdit() ? `<span>jump to</span>`
        : S.role === "presenter" ? `<span>jump to</span><span>edit</span><span>delete</span>`
        : mine ? `<span>jump to</span><span>edit</span><span>delete</span>` : `<span>jump to</span><span class="lock">🔒 ${p.name}'s</span>`;
      const who = n.who === "me" ? (S.role === "annotator" ? "You" : "Jordan P.") : p.name;
      return `<div class="note-row"><span class="sw" style="background:${n.fill};width:10px;height:10px"></span><div class="txt"><div>${n.text}</div>
        <div class="meta"><span style="color:${p.c};font-weight:600">${who}</span><span>${n.at}</span>${n.kind ? `<span>highlight</span>` : ""}</div><div class="acts">${acts}</div></div></div>`;
    }).join("")}<div class="hint" style="padding:6px 8px">207 more · newest first</div></div>
    ${canEdit() ? `<div class="compose"><div class="field">Write a note… it lands at the center of your view</div></div>`
      : S.role === "viewer" ? `<div class="hint compose">Viewers read notes; only annotators and presenters add them.</div>` : `<div class="hint compose">Read-only: you can't add or change notes.</div>`}`;
  } else {
    const rows = [["thread", false], ["point", false], ["resolved", true]].map(([id, done]) => {
      const t = THREADS[id], p = PEOPLE[t.who];
      return `<div class="note-row" onclick="set('open','${id}')" style="cursor:pointer;${done ? "opacity:.6" : ""}">${av(p)}<div class="txt"><div>${t.msgs[0][2]}</div>
        <div class="meta"><span>${t.anchor}</span></div><div class="acts"><span>${t.msgs.length} ${t.msgs.length > 1 ? "messages" : "message"}</span>${done ? "<span>✓ resolved</span>" : ""}</div></div></div>`;
    }).join("");
    body = `<div class="notes-list" data-src="v1 comments">${rows}<div class="hint" style="padding:6px 8px">9 more · <u>show resolved</u></div></div>`;
  }
  if (inSheet) return `<div class="tabs" style="justify-content:center">${tabs}</div><div class="scroll">${body}</div>`;
  return `<header><h3>Annotations</h3>${tabs}<button class="tb" onclick="set('drawer','')" title="Close">✕</button></header>${body}`;
}

function overlays() {
  const out = [];
  const cur = (p, x, y, label) => out.push(`<div class="cursor" style="left:${sx(x)}px;top:${sy(y)}px" data-src="v1 presence: cursor">
    <svg width="18" height="20" viewBox="0 0 18 20"><path d="M1 1 L16 9 L9 11 L6 18 Z" fill="${p.c}" stroke="#fff" stroke-width="1.5"/></svg>
    <span class="tag" style="background:${p.c}">${label ?? p.name}</span></div>`);
  const live = pill() === "connected" || pill() === "readonly";   // presence needs a live connection; never cached
  if (!live) return out.concat(staticOverlays()).join("");
  // presenters' cursors reach everyone; annotators' cursors only reach presenters and annotators (open question, see legend)
  cur(PEOPLE.maya, 962, 418, "Maya · drawing");
  cur(PEOPLE.dev, 1176, 296);
  if (S.role !== "viewer") { cur(PEOPLE.priya, 214, 204, "Priya · highlighting"); cur(PEOPLE.tom, 420, 640); cur(PEOPLE.sam, 1120, 600); }
  // Dev's selection tag
  out.push(`<span class="sel-tag" data-src="v1 presence: select" style="background:var(--u-dev);left:${sx(1032)}px;top:${sy(306) + 3}px">Dev K. selected</span>`);
  // laser label
  out.push(`<span class="sel-tag" data-src="core laser · v1 presence: laser" style="background:var(--laser-tag);left:${sx(500)}px;top:${sy(418) + 6}px">Maya · laser</span>`);
  // emotes (presence, never saved)
  const ex = sx(1150), ey = sy(590);
  out.push(`<span class="emote" style="left:${ex}px;top:${ey - 30}px" data-src="v1 presence: emote">👏</span><span class="emote e2" style="left:${ex + 22}px;top:${ey - 30}px">🎉</span><span class="emote e3" style="left:${sx(985)}px;top:${sy(410)}px">🔥</span>`);
  return out.concat(staticOverlays()).join("");
}

// Saved things (reactions, note authors, comments) and state banners: shown whatever the connection.
function staticOverlays() {
  const out = [];
  // note author tags (notes stream elements carry their author)
  for (const n of NOTES.filter(n => n.box)) {
    const p = PEOPLE[n.who], mine = n.who === "me" && S.role === "annotator";
    const name = n.who === "me" ? (S.role === "annotator" ? "You" : "Jordan P.") : p.name;
    const lock = S.role === "annotator" && !mine ? " 🔒" : "";
    out.push(`<span class="note-tag" data-src="v1 snapshot noteAuthor" style="left:${sx(n.box[0])}px;top:${sy(n.box[1]) - 18}px"><i style="background:${p.c}">${p.ini[0]}</i>${name}${lock}</span>`);
  }
  // comment pins
  for (const [id, t] of Object.entries(THREADS)) {
    const p = PEOPLE[t.who];
    out.push(`<button class="pin ${t.resolved ? "resolved" : ""} ${S.open === id ? "active" : ""}" data-src="${t.src}" style="background:${p.c};left:${sx(t.pin[0])}px;top:${sy(t.pin[1])}px" onclick="set('open','${id}')">${t.resolved ? "✓" : t.msgs.length}</button>`);
  }
  // the thread popover
  if (Object.hasOwn(THREADS, S.open)) {
    const t = THREADS[S.open], c = $("#canvas").getBoundingClientRect();
    const canReply = S.role !== "viewer" && S.conn !== "readonly";
    let left = sx(t.pin[0]) + 20, top = sy(t.pin[1]) - 30;
    if (left + 310 > c.width) left = sx(t.pin[0]) - 316;
    top = Math.max(8, Math.min(top, c.height - 330));
    const msgs = t.resolved ? [t.msgs[0]] : t.msgs;
    out.push(`<div class="pop" style="left:${left}px;top:${top}px" data-src="${t.src}">
      <header>${t.resolved ? `<span>✓</span><b>${t.resolved}</b>` : `<span class="anchor">${t.anchor}</span>`}<span class="spacer"></span>
        ${t.resolved ? (canReply ? `<button class="btn">Reopen</button>` : "") : canReply ? `<button class="btn" title="Resolve">✓ Resolve</button>` : ""}<button class="tb" onclick="set('open','')">✕</button></header>
      <div class="body">${t.resolved ? `<div class="anchor muted" style="font-size:12px">${t.anchor}</div>` : ""}${msgs.map(([w, at, txt, rx]) => { const p = PEOPLE[w]; return `<div class="msg">${av(p)}<div><div class="who">${p.name}<span>${at}</span></div><p>${txt}</p>
          ${rx ? `<div class="react-chips" style="position:static;margin-top:5px" data-src="v1 records: react (on comments)">${rx.map(([e, n, mine]) => `<span class="chip-r ${mine && canReply ? "mine" : ""}">${e} <b>${n}</b></span>`).join("")}${canReply ? `<span class="chip-r" title="React">＋</span>` : ""}</div>` : ""}</div></div>`; }).join("")}
        ${t.resolved ? `<div class="hint">+ 1 more reply, folded</div>` : ""}</div>
      ${t.resolved ? "" : canReply ? `<div class="reply"><div class="field">Reply…</div><button class="btn primary">Send</button></div>` : `<div class="reply hint">${S.role === "viewer" ? "Viewers read comments; they can't reply or react." : "Read-only: you can't reply or react."}</div>`}
    </div>`);
  }
  // emote picker
  if (S.open === "emote" && (pill() === "connected" || pill() === "readonly")) {
    const c = $("#canvas").getBoundingClientRect();
    out.push(`<div class="emote-picker" data-src="v1 presence: emote (fixed set)" style="left:${c.width / 2 - 140}px;bottom:${isPhone() ? 130 : 62}px">${EMOTES.map(e => `<button>${e}</button>`).join("")}</div>`);
  }
  // state banners
  const viewer = S.role === "viewer";
  if (pill() === "reconnecting") out.push(viewer ? `<div class="banner" data-src="new in web/">⟳ Reconnecting… the live view is paused.</div>`
    : `<div class="banner" data-src="v0 rule 2 (resend)">⟳ Reconnecting… 3 edits waiting. Keep working: they're resent with the same ids when the room is back.</div>`);
  if (pill() === "offline") out.push(viewer ? `<div class="banner" data-src="new in web/">⚠ You're offline. The live view is paused until you reconnect. <button class="btn">Retry now</button></div>`
    : `<div class="banner" data-src="v0 Replica pending">⚠ You're offline. 3 edits wait in this tab and send when you reconnect. Closing the tab loses them. <button class="btn">Retry now</button></div>`);
  if (S.conn === "readonly" && S.role !== "viewer") out.push(`<div class="banner" data-src="v0 welcome.role">👁 Read-only: the server gave this session the viewer role. Ask the board's owner for edit access.</div>`);
  return out;
}

function localSelection() {
  const g = $("#localSel");
  const box = S.role === "presenter" ? [444, 144, 212, 112] : S.role === "annotator" ? [474, 524, 202, 108] : null;
  if (!box || !canEdit()) { g.innerHTML = ""; return; }
  const [x, y, w, hh] = box, k = 8 / V.s;
  const hs = [[x, y], [x + w / 2, y], [x + w, y], [x, y + hh / 2], [x + w, y + hh / 2], [x, y + hh], [x + w / 2, y + hh], [x + w, y + hh]];
  g.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="none" stroke="var(--accent)" stroke-width="${1.5 / V.s}"/>
    ${hs.map(([a, b]) => `<rect x="${a - k / 2}" y="${b - k / 2}" width="${k}" height="${k}" fill="var(--page)" stroke="var(--accent)" stroke-width="${1.2 / V.s}" rx="${1.5 / V.s}"/>`).join("")}
    <line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y - 24 / V.s}" stroke="var(--accent)" stroke-width="${1.2 / V.s}"/>
    <circle cx="${x + w / 2}" cy="${y - 24 / V.s}" r="${4.5 / V.s}" fill="var(--page)" stroke="var(--accent)" stroke-width="${1.2 / V.s}"/>`;
}

function hud() {
  const pct = Math.round(V.s * 100);
  $("#hudBL").innerHTML = `
    <div class="grp ${S.role === "viewer" ? "desk-only" : ""}" data-src="core goToFrame/stepFrame"><button class="tb" title="Previous frame (PgUp)">‹</button><span class="pct">1 / 2</span><button class="tb" title="Next frame (PgDn)">›</button></div>
    <div class="grp desk-only" data-src="core zoomAt/fit"><button class="tb" title="Zoom out (⌘-)">−</button><span class="pct">${pct}%</span><button class="tb" title="Zoom in (⌘=)">+</button><button class="tb" title="Fit everything (⇧1)">⤢</button></div>
    ${S.role === "viewer" ? "" : `<div class="grp phone-only" data-src="core fit"><button class="tb" title="Fit everything">⤢</button></div>`}
    ${S.role !== "viewer" ? `<div class="grp phone-only" data-src="core undo/redo"><button class="tb" ${canEdit() ? "" : "disabled"}>↶</button><button class="tb" ${canEdit() ? "" : "disabled"}>↷</button></div>` : ""}`;
  const live = pill() === "connected" || pill() === "readonly";
  $("#hudBC").innerHTML = `<div class="grp reactions" data-src="v1 presence: emote + emotes counts">
    ${REACTIONS.map(([e, n]) => !live ? `<button class="tb" disabled title="Emotes need a live connection">${e}</button>` : `<button class="tb" title="Send ${e}: never saved. Presenters' and annotators' emotes float up live; viewers' are summed by the room every 500 ms. The number: viewers' ${e} in the latest count.">${e} <b>${n}</b></button>`).join("")}
    <span class="sep"></span><button class="tb ${S.open === "emote" ? "on" : ""}" ${live ? "" : "disabled"} title="More emotes" onclick="set('open', S.open==='emote'?'':'emote')">✨</button></div>`;
  $("#hudBR").innerHTML = `<div class="grp phone-only"><button class="tb" ${live ? "" : "disabled"} onclick="set('open', S.open==='emote'?'':'emote')" title="${live ? "Emotes" : "Emotes need a live connection"}">👏</button></div>`;
}

function dock() {
  const t = id => TOOLS.find(x => x.id === id) ?? EXTRAS.find(x => x.id === id);
  const btn = (ic, label, on, click = "", dis = false) => `<button class="tb ${on ? "on" : ""}" ${click ? `onclick="${click}"` : ""} ${dis ? "disabled" : ""}><span class="ic">${ic}</span>${label}</button>`;
  let items;
  const more = btn("⋯", "More", S.sheet === "tools", "set('sheet', S.sheet==='tools'?'':'tools')");
  const style = btn("◧", "Style", S.sheet === "panel", "set('sheet', S.sheet==='panel'?'':'panel')");
  const notes = btn("❏", "Notes", S.sheet === "notes", "set('sheet', S.sheet==='notes'?'':'notes')");
  const comments = btn("💬", "Comments", S.sheet === "comments", "set('sheet', S.sheet==='comments'?'':'comments')");
  if (S.role === "presenter") items = ["select", "freedraw", "rectangle", "text"].map(id => btn(t(id).icon, t(id).name, id === "select", "", !canEdit())).concat(more, style, notes, comments);
  else if (S.role === "annotator") items = ["select", "note", "highlighter", "freedraw"].map(id => btn(t(id).icon, t(id).name, id === "highlighter", "", !canEdit())).concat(more, style, notes);
  else items = [btn("‹", "Prev"), btn("⤢", "Fit"), btn("›", "Next"), btn("❏", "Notes", S.sheet === "notes", "set('sheet', S.sheet==='notes'?'':'notes')"), btn("💬", "Comments", S.sheet === "comments", "set('sheet', S.sheet==='comments'?'':'comments')")];
  $("#dock").innerHTML = items.join("");
  $("#dock").setAttribute("data-src", "new in web/ (touch layout)");
}

function sheet() {
  const el = $("#sheet");
  if (!S.sheet || !isPhone()) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  let body;
  if (S.sheet === "tools") {
    const r = ROLE_TOOLS[S.role];
    const all = TOOLS.filter(t => r.tools.includes(t.id)).concat(EXTRAS.filter(e => r.extras.includes(e.id)));
    body = `<div class="tool-grid">${all.map(t => `<button class="tb ${t.src ? "new" : ""}"><span class="ic">${t.icon}</span>${t.name}</button>`).join("")}
      ${S.role === "presenter" ? `<button class="tb" onclick="set('open','mermaid')"><span class="ic">◇→</span>Mermaid</button><button class="tb" onclick="set('open','export')"><span class="ic">⤓</span>Export</button>` : ""}
      <button class="tb"><span class="ic">🔓</span>Lock tool</button>
      <button class="tb" onclick="set('theme', S.theme==='dark'?'light':'dark')"><span class="ic">${S.theme === "dark" ? "☀" : "☾"}</span>${S.theme === "dark" ? "Light" : "Dark"}</button></div>`;
  } else if (S.sheet === "panel") body = `<div class="scroll">${panelHtml(true)}</div>`;
  else body = drawerHtml(true);
  el.innerHTML = `<div class="grab"></div>${body}`;
  el.setAttribute("data-src", S.sheet === "panel" ? "core panel.js (as a sheet)" : "new in web/ (touch layout)");
}

function dialogs() {
  const d = $("#dialogs");
  if (S.open === "mermaid" && S.role === "presenter") {
    d.innerHTML = `<div class="dialog-veil"><div class="dialog" data-src="core importMermaid / isMermaid">
      <h2>◇→ Insert a Mermaid flowchart <span class="spacer"></span><button class="tb" onclick="set('open','')">✕</button></h2>
      <div class="dbody"><div class="cols">
        <div class="code">flowchart LR
  A[Idea] --> B[Spec]
  B --> C{Review?}
  C -->|yes| D[Build]
  C -->|no| B
  D --> E[Ship]</div>
        <div class="preview"><svg width="240" height="120" viewBox="0 0 240 120">
          <g fill="none" stroke="var(--ink)" stroke-width="1.5"><rect x="4" y="46" width="38" height="24" rx="4"/><rect x="56" y="46" width="38" height="24" rx="4"/>
          <path d="M132 36 L156 58 L132 80 L108 58Z"/><rect x="180" y="16" width="44" height="24" rx="4"/><rect x="180" y="84" width="44" height="24" rx="4"/>
          <path d="M42 58 H56 M94 58 H108 M132 36 V28 H180 M132 80 V96 H180"/></g></svg></div>
      </div>
      <div class="row"><span class="lab">Arrows</span><span class="opts">${chip("╱ straight", false)}${chip("┐ elbow", true)}</span></div>
      <div class="hint">Flowcharts only (graph / flowchart, TD TB BT LR RL, subgraphs become frames). Pasting Mermaid text on the board does the same.</div></div>
      <footer><button class="btn" onclick="set('open','')">Cancel</button><button class="btn primary" ${dis()}>Insert as shapes</button></footer></div></div>`;
  } else if (S.open === "export" && S.role === "presenter") {
    d.innerHTML = `<div class="dialog-veil"><div class="dialog" style="width:min(520px,100%)" data-src="core exportScene · SVG/PNG writers new in web/">
      <h2>⤓ Export the board <span class="spacer"></span><button class="tb" onclick="set('open','')">✕</button></h2>
      <div class="dbody">
        <div class="preview" style="min-height:120px"><svg width="300" height="96" viewBox="0 0 1500 480" aria-label="Board only, no notes or presence">
          <g fill="none" stroke="var(--ink)" stroke-width="4"><rect x="40" y="60" width="640" height="420" stroke="var(--frame)" stroke-width="3"/><rect x="720" y="60" width="780" height="420" stroke="var(--frame)" stroke-width="3"/>
          <rect x="70" y="150" width="170" height="100" rx="10" fill="#b2f2bb"/><rect x="260" y="150" width="170" height="100" rx="10" fill="#a5d8ff"/><rect x="450" y="150" width="200" height="100" rx="10" fill="#ffec99"/>
          <rect x="70" y="290" width="330" height="160" fill="#f1f3f5" stroke="none"/><ellipse cx="545" cy="362" rx="102" ry="58" stroke="#e03131" stroke-dasharray="14 10"/>
          <rect x="750" y="220" width="110" height="60" rx="8"/><rect x="905" y="220" width="110" height="60" rx="8"/><path d="M1110 200 L1180 250 L1110 300 L1040 250Z" fill="#eebefa"/>
          <rect x="1260" y="160" width="120" height="60" rx="8"/><rect x="1260" y="300" width="120" height="60" rx="8" fill="#b2f2bb"/><path d="M860 250H903M1015 250H1038M1110 200V190H1258M1110 300V340H960V282M1320 220V298"/></g></svg></div>
        ${row("Format", "", chip("SVG", true, "exportScene (core) → an SVG writer (new in web/; herdr-draw has one in adapters/svg)") + chip("PNG", false, "rasterize that SVG (new in web/)"))}
        ${row("Scale", "", chip("1×", false) + chip("2×", true))}
        ${row("Page", "", chip("board color", true) + chip("white", false))}
        <div class="hint">The board stream only, cropped to what's drawn, 32 units of padding. Notes, selection, cursors and comments never show.</div>
      </div>
      <footer><button class="btn" onclick="set('open','')">Cancel</button><button class="btn primary" ${dis()}>Download</button></footer></div></div>`;
  } else d.innerHTML = "";
}

function timeline() {
  const el = $("#timeline");
  if (S.role !== "presenter") { el.hidden = true; return; }
  el.hidden = false;
  el.setAttribute("data-src", "core playToggle/stopPlay/time/duration");
  el.innerHTML = `<button class="c" title="Play / pause (⇧Space)">▶</button><button class="c" title="Back to editing (Esc)">■</button>
    <div class="track"><div class="fill" style="width:34%"></div>${[0, 6, 12, 19, 25, 50, 56, 62, 68].map(p => `<div class="mark" style="left:${p}%"></div>`).join("")}<div class="head" style="left:34%"></div></div>
    <span class="t">0.8s / 2.4s</span>`;
}

function render() {
  const root = document.documentElement;
  root.dataset.theme = S.theme;
  document.body.classList.toggle("src", S.src === "1");
  for (const sel of document.querySelectorAll("#mockbar [data-k]")) {
    if (sel.type === "checkbox") sel.checked = S[sel.dataset.k] === "1"; else sel.value = S[sel.dataset.k];
  }
  $("#topbar").innerHTML = topbar();
  const panel = $("#panel");
  panel.hidden = S.role === "viewer" || S.panel === "closed";
  panel.innerHTML = panel.hidden ? "" : panelHtml();
  const drawer = $("#drawer");
  drawer.hidden = !S.drawer;
  drawer.innerHTML = S.drawer ? drawerHtml() : "";
  timeline();
  fitView();
  localSelection();
  const live = pill() === "connected" || pill() === "readonly";
  for (const id of ["#remoteSel", "#laser", "#liveStroke"]) $(id).style.display = live ? "" : "none";
  document.body.classList.toggle("stale", !live);
  $("#veil").hidden = pill() !== "offline";
  $("#overlays").innerHTML = overlays();
  hud(); dock(); sheet(); dialogs();
}

for (const sel of document.querySelectorAll("#mockbar [data-k]")) {
  sel.addEventListener("change", () => set(sel.dataset.k, sel.type === "checkbox" ? (sel.checked ? "1" : "") : sel.value));
}
window.addEventListener("resize", render);
render();

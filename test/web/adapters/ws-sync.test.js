// The core over the real WebSocket transport (p7-audit C-10): bindEditor, createSession and the collab sync port over
// web/adapters/transport/ws.js on a fake WebSocket that delivers asynchronously (test/web/adapters/ws-rig.js).
//   1. The rig is not secretly synchronous: the hello waits in ws.js's pre-open queue, bufferedAmount is non-zero in
//      flight, and a held uplink trips the core's presence gate and congested().
//   2. The collab port contract (test/web/contracts/collab-contract.js) on the ws rig.
//   3. Convergence, ported from test/web/sync.test.js (whose scenarios are inline there): the seeded interleave with
//      every tool, the refusal + resync GATE matrix (both catch-up kinds), an edit inside the resync window, and a
//      server-side socket close with ops pending.
import { test, expect, describe } from "bun:test";
import { Editor, TOOLS } from "../../../packages/core/editor.js";
import { bindEditor, seeded } from "../../../web/core/sync.js";
import { PRESENCE_BACKLOG_BYTES, CONGESTED_BYTES } from "../../../web/ports/transport.js";
import { collabContract } from "../contracts/collab-contract.js";
import { wsNetwork, wsSyncRig } from "./ws-rig.js";

const USERS = {
  owner: { user: "u0", role: "owner" }, ed: { user: "u1", role: "editor" }, view: { user: "u2", role: "viewer" },
};

async function setup(tokens = ["owner", "ed"], { seed = 1 } = {}) {
  const w = wsNetwork({ users: USERS, seed });
  const peers = tokens.map((token, i) => {
    const editor = new Editor(), transport = w.join();
    const sync = bindEditor(editor, { transport, token, board: "b1", client: `p${i}`, stream: "board", clock: w.clock });
    return { editor, sync, transport };
  });
  await w.settle();
  return { ...w, peers };
}

function expectConverged(net, peers) {
  const room = net.full("board");
  for (const { sync } of peers) {
    expect(sync.status).toBe("live");
    expect(sync.pending).toBe(0);
    expect(sync.diff()).toEqual([]);
    expect(sync.full()).toEqual(room);
  }
}

function drag(ed, tool, from, to, moves = 6) {
  if (tool) ed.setTool(tool);
  ed.pointerDown(from, {});
  for (let i = 1; i <= moves; i++) ed.pointerMove({ x: from.x + ((to.x - from.x) * i) / moves, y: from.y + ((to.y - from.y) * i) / moves }, {});
  ed.pointerUp(to, {});
}
async function box(peer, w, at = { x: 100, y: 100 }) {
  drag(peer.editor, "rectangle", at, { x: at.x + 160, y: at.y + 100 }); peer.editor.key("escape"); await w.settle();
  return peer.editor.doc.live().filter(e => e.type === "rectangle").at(-1).id;
}
const MAKERS = TOOLS.map(t => t.id).filter(id => ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"].includes(id));
function make(ed, tool, at) {
  if (tool === "text") { ed.setTool("text"); ed.pointerDown(at, {}); ed.setText(`note ${at.x}`); ed.commitText(); return; }
  drag(ed, tool, at, { x: at.x + 70, y: at.y + 50 });
  ed.key("escape");
}

// ── 1. the rig is asynchronous, and ws.js's buffering reaches the core ──
describe("ws rig: delivery is asynchronous", () => {
  test("the hello waits in ws.js's pre-open queue until the open event, and bufferedAmount is non-zero in flight", async () => {
    const w = wsNetwork({ users: USERS, seed: 3 });
    const editor = new Editor(), transport = w.join();
    const sync = bindEditor(editor, { transport, token: "owner", board: "b1", client: "p0", stream: "board", clock: w.clock });
    const ws = transport.socket();
    expect(ws.readyState).toBe(0);
    expect(ws.up.length).toBe(0);                                  // nothing on the wire yet
    expect(transport.backlogBytes()).toBeGreaterThan(0);           // ...but the hello is queued in ws.js
    expect(sync.status).not.toBe("live");
    let sawBuffered = false;
    while (w.step()) if (ws.bufferedAmount > 0) sawBuffered = true;
    await w.settle();
    expect(sawBuffered).toBe(true);
    expect(w.bridge.stats.sendsBeforeOpen).toBe(0);                // ws.js never wrote to a CONNECTING socket
    expect(sync.status).toBe("live");
    expect(transport.backlogBytes()).toBe(0);
  });

  test("a held uplink: bufferedAmount grows, congested() turns on, the presence gate skips; release converges", async () => {
    const { bridge, settle, net, peers } = await setup(["owner", "ed"], { seed: 2 });
    const [a, b] = peers;
    expect(a.sync.sendPresence("cursor", { x: 1, y: 1 })).toBe(true);
    await settle();
    bridge.hold(true);
    a.editor.setTool("text"); a.editor.pointerDown({ x: 10, y: 10 }, {});
    a.editor.setText("x".repeat(Math.max(PRESENCE_BACKLOG_BYTES, CONGESTED_BYTES) + 1024)); a.editor.commitText();
    for (let i = 0; i < 50 && a.transport.socket().bufferedAmount <= PRESENCE_BACKLOG_BYTES; i++) a.editor.nudge?.(1, 0);
    // Deliver what can move (the room side), never the held uplink.
    while (net.step()) {}
    expect(a.transport.socket().bufferedAmount).toBeGreaterThan(PRESENCE_BACKLOG_BYTES);
    expect(a.sync.congested()).toBe(a.transport.socket().bufferedAmount > CONGESTED_BYTES);
    expect(a.sync.sendPresence("cursor", { x: 2, y: 2 })).toBe(false);   // the gate: skipped, never queued
    bridge.hold(false);
    await settle();
    expect(a.transport.socket().bufferedAmount).toBe(0);
    expect(a.sync.sendPresence("cursor", { x: 3, y: 3 })).toBe(true);
    expectConverged(net, [a, b]);
    expect(b.editor.doc.live().some(e => e.type === "text")).toBe(true);
  });
});

// ── 2. the collab port contract over ws ──
collabContract("sync over ws.js", role => wsSyncRig(role));

// ── 3. convergence over ws (ported from test/web/sync.test.js) ──
for (const seed of [1, 2, 3, 4, 5]) test(`ws: two Editors converge after interleaved edits with every tool (seed ${seed})`, async () => {
  const { net, peers, step, settle } = await setup(["owner", "ed"], { seed });
  const rng = seeded(seed * 101);
  for (let round = 0; round < 60; round++) {
    const { editor } = peers[Math.floor(rng() * 2)];
    const roll = rng(), at = { x: Math.floor(rng() * 600), y: Math.floor(rng() * 400) };
    const live = editor.doc.live().filter(e => !e.containerId);
    if (roll < 0.5 || !live.length) make(editor, MAKERS[Math.floor(rng() * MAKERS.length)], at);
    else if (roll < 0.62) { const el = live[Math.floor(rng() * live.length)]; editor.setTool("select"); editor.select([el.id]); editor.nudge(Math.floor(rng() * 40) - 20, 5); }
    else if (roll < 0.72) { const el = live[Math.floor(rng() * live.length)]; editor.setTool("select"); editor.select([el.id]); const c = editor.toScreen({ x: el.x + (el.width || 1) / 2, y: el.y + (el.height || 1) / 2 }); drag(editor, null, c, { x: c.x + 30, y: c.y - 20 }, 1 + Math.floor(rng() * 20)); }
    else if (roll < 0.8) { editor.select([live[Math.floor(rng() * live.length)].id]); editor.key("backspace"); }
    else if (roll < 0.88) rng() < 0.6 ? editor.undo() : editor.redo();
    else if (roll < 0.94) editor.setAppState({ grid: Math.floor(rng() * 40) });
    else drag(editor, "eraser", at, { x: at.x + 80, y: at.y + 80 });
    for (let k = Math.floor(rng() * 6); k > 0; k--) step(rng);       // deliveries interleave with edits
  }
  await settle(rng);
  for (const p of peers) expect(p.sync.resets).toBe(1);
  expect(net.state("board").elements.length).toBeGreaterThan(10);
  expectConverged(net, peers);
});

async function busyBoard(w, a, b) {
  const r = await box(a, w, { x: 10, y: 10 }), e = await box(a, w, { x: 210, y: 10 }), d = await box(b, w, { x: 410, y: 10 });
  for (let i = 0; i < 4; i++) { a.editor.select([r]); a.editor.nudge(1, 0); }
  a.editor.select([e]); a.editor.key("backspace");
  b.editor.select([d]); b.editor.nudge(0, 3);
  a.editor.setAppState({ grid: 20 });
  await w.settle();
  expect(w.net.full().elements[r].version).toBeGreaterThan(4);
  expect(w.net.full().elements[e].isDeleted).toBe(true);
  return { r, e, d };
}

const REFUSALS = {
  "an unknown board setting (appState)": ({ a }) => a.editor.setAppState({ bogus: 1 }),
  "a bad setting value (appState)": ({ a }) => a.editor.setAppState({ grid: -5 }),
  "an element op (a viewer draws)": ({ v }) => drag(v.editor, "rectangle", { x: 300, y: 300 }, { x: 360, y: 340 }),
  "an element op (a viewer moves an existing shape)": ({ v, ids }) => { v.editor.setTool("select"); v.editor.select([ids.r]); v.editor.nudge(50, 0); },
};

for (const compacted of [false, true]) for (const [name, refuse] of Object.entries(REFUSALS)) for (const seed of [1, 2]) {
  test(`ws GATE: refusal of ${name} + resync leaves Editor == Replica == room (catch-up by ${compacted ? "snapshot" : "entries"}, seed ${seed})`, async () => {
    const w = await setup(["owner", "ed", "view"], { seed });
    const [a, b, v] = w.peers;
    const ids = await busyBoard(w, a, b);
    if (compacted) w.net.compact();
    const who = name.includes("viewer") ? v : a;
    drag(a.editor, "diamond", { x: 10, y: 300 }, { x: 80, y: 360 });
    refuse({ a, v, ids });
    await w.settle(seeded(seed));
    expect(who.sync.resets).toBe(2);
    expect(a.editor.doc.appState.herdr.bogus).toBeUndefined();
    expect(a.editor.doc.live().filter(e => e.type === "diamond").length).toBe(1);
    expect(v.editor.doc.get(ids.r).x).toBe(a.editor.doc.get(ids.r).x);
    expectConverged(w.net, w.peers);
  });
}

for (const seed of [1, 2, 3]) test(`ws GATE: an edit to an existing element inside the resync window is acked and alive (seed ${seed})`, async () => {
  const w = await setup(["owner", "ed"], { seed });
  const [a, b] = w.peers;
  const { r } = await busyBoard(w, a, b);
  const roomV = w.net.full().elements[r].version, x0 = w.net.full().elements[r].x;
  a.editor.setAppState({ bogus: 1 });
  for (let n = 0; a.sync.status === "live" && n < 400; n++) w.step(() => 0);
  expect(a.sync.status).not.toBe("live");
  a.editor.select([r]); a.editor.nudge(500, 0);
  await w.settle(seeded(seed));
  const entry = w.net.log.entries.filter(e => e.op.elements?.some(el => el.id === r)).at(-1);
  expect(entry.op.elements.find(el => el.id === r).version).toBeGreaterThan(roomV);
  for (const p of w.peers) expect(p.editor.doc.get(r).x).toBe(x0 + 500);
  expectConverged(w.net, w.peers);
});

for (const seed of [1, 2, 3]) test(`ws: the server closes a socket with ops in flight; the core reconnects over a new socket, resends, converges (seed ${seed})`, async () => {
  const w = await setup(["owner", "ed"], { seed });
  const [a, b] = w.peers;
  await box(a, w, { x: 10, y: 10 });
  const first = a.transport.socket();
  drag(a.editor, "ellipse", { x: 200, y: 200 }, { x: 260, y: 240 }); a.editor.key("escape");
  drag(b.editor, "diamond", { x: 300, y: 50 }, { x: 360, y: 90 }); b.editor.key("escape");
  for (let k = 0; k < 3; k++) w.step(seeded(seed));
  expect(a.sync.pending).toBeGreaterThan(0);
  w.bridge.serverClose(first);
  await w.settle(seeded(seed));
  expect(a.transport.socket()).not.toBe(first);                     // a new socket (ws.js reopened on onDrop)
  expect(first.readyState).toBe(3);
  expect(a.sync.resets).toBeGreaterThanOrEqual(1);
  for (const p of w.peers) expect(p.editor.doc.live().filter(e => e.type === "ellipse").length).toBe(1);
  expectConverged(w.net, w.peers);
});

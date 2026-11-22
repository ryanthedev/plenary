// Downstream heartbeat (E-1, PROTOCOL.md § Pacing & rule 12) and client idle watchdog (C-4):
// the gateway sends `{ t: "hb" }` every ≤ 10 s on an idle welcomed connection; a caught-up Replica
// with no server message for 25 s closes and reconnects with rule-12 backoff.

import { test, expect, afterAll } from "bun:test";
import { Replica } from "../../packages/protocol/replica.js";
import { HB_IDLE_MS, IDLE_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from "../../packages/protocol/envelope.js";
import { openLink } from "../../web/core/sync.js";
import { Editor } from "../../packages/core/editor.js";
import { emptyScene } from "../../packages/core/model.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep } from "./helpers.js";

afterAll(cleanup);
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });

test("Replica: live caught-up client times out after IDLE_TIMEOUT_MS (25 s) of silence; hb/here reset the deadline", () => {
  let t = 1000;
  const r = new Replica({ client: "v", now: () => t, random: () => 0.5 });
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "viewer", user: "u1", horizon: 0, rv: 1, room: { board: "b1", epoch: 1 }, hb: HB_IDLE_MS });
  expect(r.wait()).toBe(IDLE_TIMEOUT_MS);

  // Heartbeat at +10 s resets the 25 s deadline.
  t += HB_IDLE_MS;
  expect(r.wait()).toBe(IDLE_TIMEOUT_MS - HB_IDLE_MS);
  r.receive({ t: "hb" });
  expect(r.wait()).toBe(IDLE_TIMEOUT_MS);

  // `here` also resets the deadline.
  t += 15_000;
  expect(r.wait()).toBe(10_000);
  r.receive({ t: "here", writers: [], writerCount: 0, viewers: 1 });
  expect(r.wait()).toBe(IDLE_TIMEOUT_MS);

  // Silence for 25 s triggers resync; because the connection proved itself (>= 10 s before silence), fails = 1.
  t += IDLE_TIMEOUT_MS - 1;
  expect(r.outgoing()).toEqual([]);
  expect(r.resync).toBe(false);
  t += 1;
  expect(r.outgoing()).toEqual([]);
  expect(r.resync).toBe(true);
  expect(r.fails).toBe(1);
});

test("Replica: welcome followed immediately by 25 s silence does NOT prove the connection (backoff keeps growing)", () => {
  let t = 0;
  const r = new Replica({ client: "v", now: () => t, random: () => 0.5 });
  r.fails = 3;
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "viewer", user: "u1", horizon: 0, rv: 1, room: { board: "b1", epoch: 1 }, hb: HB_IDLE_MS });
  t += IDLE_TIMEOUT_MS;
  r.outgoing();
  expect(r.resync).toBe(true);
  expect(r.fails).toBe(4);   // not reset to 1: the server never sent another message after welcome
});

test("gateway: welcomes carry hb, sends { t: 'hb' } to idle welcomed connections, skips un-welcomed ones", async () => {
  const r = await rig({ limits: { hbIdleMs: 80, sweepMs: 20, hereMs: 60_000, herePublishMs: 60_000 } });
  try {
    const v = await r.sock();
    v.send(hello(r, "viewer", { client: "hb-v" }));
    const vw = await v.next(m => m.t === "welcome", "viewer welcome");
    expect(vw.hb).toBe(80);

    const e = await r.sock();
    e.send(hello(r, "editor", { client: "hb-e" }));
    const ew = await e.next(m => m.t === "welcome", "editor welcome");
    expect(ew.hb).toBe(80);

    // A socket that never says hello gets no heartbeat.
    const silent = await r.sock();

    const vHb = await v.next(m => m.t === "hb", "viewer hb", 2000);
    const eHb = await e.next(m => m.t === "hb", "editor hb", 2000);
    expect(vHb).toEqual({ t: "hb" });
    expect(eHb).toEqual({ t: "hb" });
    expect(silent.msgs.filter(m => m.t === "hb").length).toBe(0);

    await v.close(); await e.close(); await silent.close();
  } finally {
    await r.stop();
  }
}, 15_000);

test("web/core/sync.js (C-4): silent live viewer reconnects after 25 s; periodic hb/here keeps it live", () => {
  let t = 0, nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => t, mono: () => t, random: () => 0.5,
    set: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + Math.max(0, ms) }); return id; },
    clear: id => timers.delete(id),
  };
  const advance = ms => {
    const target = t + ms;
    while (true) {
      let pick = null;
      for (const [id, entry] of timers) if (entry.at <= target && (!pick || entry.at < pick.at)) pick = { id, ...entry };
      if (!pick) break;
      timers.delete(pick.id); t = pick.at; pick.fn();
    }
    t = target;
  };

  let onMsg = null;
  const sent = [];
  let reopens = 0;
  const transport = {
    send: m => sent.push(m),
    onMessage: fn => { onMsg = fn; },
    onDrop: () => {},
    reopen: () => { reopens++; },
    close: () => {},
    backlogBytes: () => 0,
  };

  const statuses = [];
  const link = openLink({ transport, token: "tok", board: "b1", client: "v", clock, onStatus: s => statuses.push(s) });
  const ed = new Editor(emptyScene());
  const h = link.bind(ed, "board");
  link.start();
  expect(h.hellos).toBe(1);

  // Welcome with hb -> live.
  onMsg({ t: "welcome", seq: 0, role: "viewer", user: "u1", horizon: 0, rv: 1, room: { board: "b1", epoch: 1 }, hb: HB_IDLE_MS });
  expect(h.status).toBe("live");

  // Periodic hb and here every 10 s for 60 s keeps it live with 0 reconnects.
  for (let i = 0; i < 6; i++) {
    advance(HB_IDLE_MS);
    onMsg(i % 2 === 0 ? { t: "hb" } : { t: "here", writers: [], writerCount: 0, viewers: 1 });
    expect(h.status).toBe("live");
  }
  expect(h.hellos).toBe(1);
  expect(reopens).toBe(0);

  // Now go silent for 25 s + backoff: viewer drops to connecting and reopens with a fresh hello.
  advance(IDLE_TIMEOUT_MS);
  expect(h.status).toBe("connecting");
  advance(CONNECT_TIMEOUT_MS);   // well past rule-12 first backoff
  expect(reopens).toBe(1);
  expect(h.hellos).toBe(2);
  h.close();
});

test("end-to-end: gateway hb keeps a live openLink connected; silencing the socket triggers reconnect", async () => {
  const r = await rig({ limits: { hbIdleMs: 80, sweepMs: 20, hereMs: 60_000, herePublishMs: 60_000 } });
  let ws = null, silenced = false, reopens = 0, onMsg = () => {};
  const open = () => {
    const cur = new WebSocket(r.server.wsUrl);
    ws = cur;
    const queued = [];
    cur.onopen = () => { for (const m of queued.splice(0)) cur.send(m); };
    cur.onmessage = ev => { if (cur === ws && !silenced) onMsg(JSON.parse(ev.data)); };
    cur._send = m => { const s = JSON.stringify(m); if (cur.readyState === 1) cur.send(s); else queued.push(s); };
  };
  open();
  const clock = { now: Date.now, mono: () => performance.now(), random: () => 0.5, set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };
  const transport = {
    send: m => ws?._send(m),
    onMessage: fn => { onMsg = fn; },
    onDrop: () => {},
    reopen: () => { reopens++; try { ws?.close(); } catch {} silenced = false; open(); },
    close: () => { try { ws?.close(); } catch {} ws = null; },
    backlogBytes: () => 0,
  };
  const link = openLink({ transport, token: tokenOf("viewer"), board: r.ids.board, client: "e2e-hb", clock });
  const h = link.bind(new Editor(emptyScene()), "board");
  link.start();
  try {
    const until = async (fn, ms, what) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(15); } };
    await until(() => h.status === "live", 3000, "live");
    // Stay quiet for 400 ms (2x the 200 ms idle deadline): gateway heartbeats keep it live with 0 reconnects.
    await sleep(400);
    expect([h.status, reopens, h.hellos]).toEqual(["live", 0, 1]);
    // Silence the socket (half-open link): after ~200 ms idle + backoff, client reopens and recovers to live.
    silenced = true;
    await until(() => reopens >= 1 && h.status === "live", 5000, "reconnect after silence");
    expect(h.hellos).toBeGreaterThanOrEqual(2);
  } finally {
    h.close();
    await r.stop();
  }
}, 15_000);

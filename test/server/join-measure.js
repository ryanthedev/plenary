// Measures what a joining client is sent (bytes and frames), on a board built the way real use builds it: many
// ops, some of them edits of shapes already there. Shared by test/server/join-size.test.js; no timing, only counts.
import { rig, tokenOf } from "./rig.js";
import { until, sleep } from "./helpers.js";
import { makeElement } from "../../packages/core/model.js";
import { Replica } from "../../packages/protocol/replica.js";
import { zlibDeflate } from "../../server/compress/zlib.js";
import { inflateSync } from "node:zlib";

/** A deterministic shape with every field a real one carries (about 430 bytes of JSON). */
export const shape = (i, version = 1) => makeElement("rectangle", {
  id: "s" + i, x: (i % 100) * 24, y: Math.floor(i / 100) * 24, width: 20, height: 20, seed: 1000 + i, versionNonce: 7000 + version * 31 + i, version, updated: 1_700_000_000_000,
});

/**
 * A deterministic board of mixed, "real" content: random 2-decimal floats and ids, colours, words, arrows with bend points, and (when
 * `freehand` > 0) that share of freehand strokes with 40 to 160 jittery points and pressures. Compresses far less than `shape`
 * (repeated field names compress well; coordinates, ids, seeds and strokes do not): this is the figure PROTOCOL.md § Joining quotes.
 */
export function variedShapes({ n, freehand = 0.3, seed = 7 }) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = xs => xs[Math.floor(rnd() * xs.length)];
  const f = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100, id = () => Array.from({ length: 21 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rnd() * 36)]).join("");
  const colours = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#6741d9", "#0c8599", "#c2255c", "transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff"];
  const words = "design review roadmap latency shard gateway tenant checkpoint replica quorum budget launch owner risk spike backlog".split(" ");
  const common = () => ({ id: id(), x: f(-4000, 4000), y: f(-4000, 4000), width: f(20, 400), height: f(20, 300), angle: rnd() < 0.8 ? 0 : f(-1, 1), seed: Math.floor(rnd() * 2 ** 31), versionNonce: Math.floor(rnd() * 2 ** 31),
    strokeColor: pick(colours), backgroundColor: pick(colours), updated: 1_700_000_000_000 + Math.floor(rnd() * 1e9), version: 1 + Math.floor(rnd() * 5) });
  return Array.from({ length: n }, () => {
    const r = rnd();
    if (r < freehand) {
      const k = 40 + Math.floor(rnd() * 120); let x = 0, y = 0;
      const points = Array.from({ length: k }, () => [x = Math.round((x + f(-6, 6)) * 100) / 100, y = Math.round((y + f(-6, 6)) * 100) / 100]);
      return makeElement("freedraw", { ...common(), points, pressures: points.map(() => Math.round(rnd() * 100) / 100) });
    }
    const q = (r - freehand) / (1 - freehand);
    if (q < 0.45) return makeElement(pick(["rectangle", "ellipse", "diamond"]), common());
    if (q < 0.75) { const text = Array.from({ length: 2 + Math.floor(rnd() * 8) }, () => pick(words)).join(" "); return makeElement("text", { ...common(), text, originalText: text }); }
    return makeElement("arrow", { ...common(), points: [[0, 0], [f(-300, 300), f(-200, 200)], [f(-300, 300), f(-200, 200)]] });
  });
}

/** The UTF-8 length of a text frame, or the byte length of a binary one. */
export const wireBytes = d => (typeof d === "string" ? Buffer.byteLength(d) : d.byteLength ?? d.size ?? 0);

/**
 * Build a board through one editor socket: `shapes` shapes in ops of `perOp`, then `edits` single-shape moves
 * (version + 1 each, as a drag sends), waiting for every ack. Returns when the room, the Store and the gateway's feed agree
 * and the feed has re-based on the room's newest checkpoint (so a join now sees the steady state).
 */
export async function buildBoard(r, { shapes, perOp = 100, edits = 0, make = null }) {
  const made = make ? make(shapes) : null;
  const w = await r.sock();
  w.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "builder" });
  await w.next(m => m.t === "welcome");
  let n = 0;
  const send = els => w.send({ t: "op", id: `builder:${++n}`, sentAt: 0, stream: "board", op: { elements: els } });
  for (let i = 0; i < shapes; i += perOp) send(made ? made.slice(i, i + perOp) : Array.from({ length: Math.min(perOp, shapes - i) }, (_, k) => shape(i + k)));
  const version = new Map();
  for (let e = 0; e < edits; e++) { const i = (e * 7) % shapes, v = (version.get(i) ?? 1) + 1; version.set(i, v); send([{ ...(made ? { ...made[i], version: made[i].version + v } : shape(i, v)), x: 5 + e }]); }
  await until(() => w.msgs.filter(m => m.t === "ack").length === n, "every op acked", 60_000);
  const errors = w.msgs.filter(m => m.t === "error");
  if (errors.length) throw new Error("builder got errors: " + JSON.stringify(errors.slice(0, 2)));
  await r.idle();
  const room = await r.room();
  await until(() => {
    const f = r.server.gateway.feed(r.ids.tenant, r.ids.board);
    // Folds are taken in steps and chain: wait until none runs or is due (the checkpoint is as new as the policy makes it), then for the feed.
    return room.resolved === n && !room.folder.active && !room.writing && !room.checkpointDue() && f && f.seq === n && f.base === room.savedSeq;
  }, "the folds to settle and the feed to catch up with the room's newest checkpoint", 30_000);
  const feed = r.server.gateway.feed(r.ids.tenant, r.ids.board);
  await w.close();
  return { ops: n, seq: n, checkpoint: room.savedSeq, feed };
}

/**
 * Join as `name` (`since` = what `replica` has applied: 0 for a new one) and collect every frame up to `here` (the last thing a join sends). With `z`, the URL asks for
 * deflate (PROTOCOL.md § Joining) and binary frames are inflated like a client does. Returns { bytes, frames, kinds, msgs,
 * replica, close } where kinds = [{ t, bytes, binary }] in order (`bytes` as sent on the wire) and `replica` has applied it all.
 */
export async function measureJoin(r, { name = "viewer", z = false, replica = new Replica({ client: name + "-join" }) } = {}) {
  const ws = new WebSocket(r.server.wsUrl + (z ? "?z=deflate" : ""));
  ws.binaryType = "arraybuffer";
  const kinds = [], msgs = [];
  let closed = null;
  ws.onclose = e => { closed = { code: e.code, reason: e.reason }; };
  ws.onmessage = e => {
    const binary = typeof e.data !== "string";
    const text = binary ? inflateSync(Buffer.from(e.data)).toString("utf8") : e.data;
    const m = JSON.parse(text);
    kinds.push({ t: m.t, bytes: wireBytes(e.data), binary }); msgs.push(m);
    replica.receive(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("socket failed to open")); });
  ws.send(JSON.stringify(replica.connectMessages(tokenOf("viewer"), r.ids.board)[0]));
  await until(() => msgs.some(m => m.t === "here") || closed, "the join to finish (here)", 60_000);
  if (closed) throw new Error("closed during the join: " + JSON.stringify(closed));
  return { bytes: kinds.reduce((a, k) => a + k.bytes, 0), frames: kinds.length, kinds, msgs, replica, close: () => ws.close() };
}

export const kb = n => (n / 1024).toFixed(1) + " KB";
export { rig, sleep, zlibDeflate };

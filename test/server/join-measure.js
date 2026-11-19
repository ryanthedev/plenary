// Measures what a joining client is sent (bytes and frames), on a board built the way real use builds it: many
// ops, some of them edits of shapes already there. Shared by test/server/join-size.test.js; no timing, only counts.
import { rig, tokenOf } from "./rig.js";
import { until, sleep } from "./helpers.js";
import { makeElement } from "../../packages/core/model.js";
import { Replica } from "../../packages/protocol/replica.js";
import { zlibDeflate } from "../../server/compress/zlib.js";
import { inflateSync } from "node:zlib";

/** A deterministic shape with every field a real one carries (~460 bytes of JSON). */
export const shape = (i, version = 1) => makeElement("rectangle", {
  id: "s" + i, x: (i % 100) * 24, y: Math.floor(i / 100) * 24, width: 20, height: 20, seed: 1000 + i, versionNonce: 7000 + version * 31 + i, version, updated: 1_700_000_000_000,
});

/** The UTF-8 length of a text frame, or the byte length of a binary one. */
export const wireBytes = d => (typeof d === "string" ? Buffer.byteLength(d) : d.byteLength ?? d.size ?? 0);

/**
 * Build a board through one editor socket: `shapes` shapes in ops of `perOp`, then `edits` single-shape moves
 * (version + 1 each, as a drag sends), waiting for every ack. Returns when the room, the Store and the gateway's feed agree
 * and the feed has re-based on the room's newest checkpoint (so a join now sees the steady state).
 */
export async function buildBoard(r, { shapes, perOp = 100, edits = 0 }) {
  const w = await r.sock();
  w.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "builder" });
  await w.next(m => m.t === "welcome");
  let n = 0;
  const send = els => w.send({ t: "op", id: `builder:${++n}`, sentAt: 0, stream: "board", op: { elements: els } });
  for (let i = 0; i < shapes; i += perOp) send(Array.from({ length: Math.min(perOp, shapes - i) }, (_, k) => shape(i + k)));
  const version = new Map();
  for (let e = 0; e < edits; e++) { const i = (e * 7) % shapes, v = (version.get(i) ?? 1) + 1; version.set(i, v); send([{ ...shape(i, v), x: 5 + e }]); }
  await until(() => w.msgs.filter(m => m.t === "ack").length === n, "every op acked", 60_000);
  const errors = w.msgs.filter(m => m.t === "error");
  if (errors.length) throw new Error("builder got errors: " + JSON.stringify(errors.slice(0, 2)));
  await r.idle();
  const room = await r.room();
  await until(() => {
    const f = r.server.gateway.feed(r.ids.tenant, r.ids.board);
    return room.resolved === n && f && f.seq === n && f.base === room.savedSeq;
  }, "the feed to catch up with the room's newest checkpoint", 30_000);
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

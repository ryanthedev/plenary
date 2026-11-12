// The sync-side collab port over two real sessions (me and the peer Bo) on the in-page reference room (local.js, virtual
// clock): the driver of test/web/contracts/collab-contract.js, also used by test/web/collab/wire.test.js.
import { syncCollabPort } from "../../../web/adapters/collab/sync.js";
import { localRoom } from "../../../web/adapters/transport/local.js";
import { createSession } from "../../../web/core/session.js";

/** A room with me (as `role`) and the peer Bo (editor), both live. Frames are run by settle(). */
export async function syncRig(role, { users: extra = {} } = {}) {
  const USERS = { "t-me": { user: "me", name: "Me", role }, "t-bo": { user: "bo", name: "Bo", role: "editor" }, ...extra };
  const net = localRoom({ users: USERS, clock: true });
  const frames = [];
  const frame = fn => frames.push(fn);
  const sent = [];
  const join = () => { const t = net.join(); return { ...t, send: m => { if (m.t === "presence") sent.push(m); t.send(m); } }; };
  const me = createSession({ join, token: "t-me", board: "b1", client: "me", user: "me", clock: net.clock });
  const bo = createSession({ join: () => net.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: net.clock });
  const port = syncCollabPort(me, { name: "Me", frame });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      net.settle();
      if (!frames.length) return;
      for (const fn of frames.splice(0)) fn();
    }
    throw new Error("frames never settled");
  };
  await settle();
  return {
    net, me, bo, port, frames, USERS, settle,
    peer: { user: "bo" },
    async peerPresence(m) { const { k, ...f } = m; if (!bo.binds.board.sendPresence(k, f)) throw new Error("peer presence not sent"); await settle(); },
    async peerRecord(op) { bo.binds.board.record(op); await settle(); },
    async peerNote() {
      bo.placeNote({ x: 100, y: 100 }, "peer note");
      await settle();
      return bo.eds.notes.doc.live().find(e => e.type === "rectangle").id;
    },
    async peerDeleteNote(id) { bo.act("notes", n => n.deleteIds([id])); await settle(); },
    async peerPreview(stream, el) { if (!bo.binds.board.sendPresence("preview", { stream, elements: [el] })) throw new Error("preview not sent"); await settle(); },
    async here(msg) { net.broadcast(msg); await settle(); },
    async emotes(msg) { net.broadcast(msg); await settle(); },
    async setRole(r) { USERS["t-me"].role = r; me.dropConnection(); await settle(); },
    async drop(during = () => {}) { me.dropConnection(); during(); await settle(); },
    sent: () => sent.map(({ t, ...m }) => m),
  };
}

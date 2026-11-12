// The collab port contract (test/web/contracts/collab-contract.js) against both adapters: the fake, and the sync-side
// one over a real session (two connections per tab) on the in-page reference room (local.js, virtual clock).
import { collabContract } from "../contracts/collab-contract.js";
import { createFakePort } from "../../../web/adapters/collab/fake.js";
import { syncRig } from "./collab-rig.js";

// ── the fake ──
collabContract("fake", async role => {
  const port = createFakePort({ role, me: { user: "me", name: "Me", client: "me-1" } });
  const peer = { user: "bo", client: "bo-1", name: "Bo" };
  return {
    port, peer,
    async settle() { port.ackAll(); },
    async peerPresence(m) { port.presence([{ user: peer.user, client: peer.client, ...m }]); },
    async peerRecord(op) { port.remote(op, peer.user, peer.name, "editor"); },
    async peerNote() { port.setElement("notes", "pn1", { id: "pn1", type: "rectangle", x: 0, y: 0, width: 190, height: 96 }); port.setNoteAuthor("pn1", peer.user); return "pn1"; },
    async peerDeleteNote(id) { port.setElement("notes", id, { id, type: "rectangle", x: 0, y: 0, width: 190, height: 96, isDeleted: true }); },
    async peerPreview(stream, el) { port.setPreviews(stream, [{ el, user: peer.user, client: peer.client }]); },
    async here(msg) { port.here(msg); },
    async emotes(msg) { port.emotes(msg); },
    async setRole(r) { port.setStatus("connecting"); port.setStatus("catching-up"); port.setStatus("live", r); },
    async drop(during = () => {}) { port.setStatus("connecting"); during(); port.setStatus("live"); },
    sent: () => port.sent,
  };
});

// ── the sync-side adapter over a real session ──
collabContract("sync", role => syncRig(role));

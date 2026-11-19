// Issue #42: uploaded images vanished after a server restart. The whole path, with the REAL web client (wsNet) against
// a REAL server (test/server/rig.js): upload → stop the server → a new server on the same data → a fresh client loads
// the board and gets the picture's bytes back. A server-only test would not show the "picture (bytes not here yet)"
// placeholder going away; this one ends where the app's `net.onFile` hands bytes to the Editors.
import { test, expect, afterAll } from "bun:test";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1, until } from "./helpers.js";

afterAll(cleanup);

const dataUrl = (bytes, type = "image/png") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

/** A web-client net on `server`, joined and welcomed as `name`; `got` collects what onFile delivers. */
async function join(server, ids, name) {
  const net = wsNet({ url: server.wsUrl, WebSocket });
  const got = [];
  net.onFile(f => got.push(f));
  const tr = net.join(), msgs = [];
  tr.onMessage(m => msgs.push(m));
  tr.send({ t: "hello", v: 1, token: tokenOf(name), board: ids.board, since: 0, client: name });
  await until(() => msgs.find(m => m.t === "welcome"), `${name}'s welcome`);
  return { net, got, msgs, close: () => tr.close() };
}

test("DW-42.1 DW-42.3: a picture uploaded by a client is still there for a fresh client after a server restart", async () => {
  const bytes = fakePng(3000, 9), id = sha1(bytes);
  const file = { id, mimeType: "image/png", dataURL: dataUrl(bytes) };

  const a = await rig();
  const up = await join(a.server, a.ids, "editor");
  up.net.put(file);
  await until(async () => (await a.server.blobs.get(a.ids.tenant, id)) !== null, "the bytes in the Blobs adapter");
  up.close();
  await a.stop();

  const b = await rig({ dir: a.dir, registry: a.registry, ids: a.ids });           // the same data, a new process-worth of server
  const down = await join(b.server, b.ids, "viewer");
  down.net.want?.(id);                                                             // what the app does for an image element with no bytes
  const f = await until(() => down.got.find(x => x.id === id), "the picture's bytes after the restart");
  expect(f.dataURL).toBe(file.dataURL);
  expect(f.mimeType).toBe("image/png");
  down.close();
});

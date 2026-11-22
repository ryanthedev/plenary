// Issue #42: uploaded images vanished after a server restart. The whole path, with the REAL canvas app (app.js on a stub
// page, test/web/app-client.js) over the real web client (wsNet) against a REAL server (test/server/rig.js): upload,
// stop the server, start a new one on the same data, and a fresh page loads the board and DRAWS the picture's bytes
// into its Editor. Nobody calls `want` here: the app asks for the bytes of the pictures it shows without them.
// (Decoding a File needs a browser, so the upload half runs the two lines app.js runs after decoding: S.addPicture, net.put.)
import { test, expect, afterAll } from "bun:test";
import { appClient, restoreAppGlobals } from "../web/app-client.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1 } from "./helpers.js";

afterAll(() => { restoreAppGlobals(); cleanup(); });

const page = (r, name) => appClient({ url: r.server.wsUrl, board: r.ids.board, token: tokenOf(name), user: "dev:" + name });

test("DW-42.1 DW-42.3: a picture uploaded by one page is drawn by a fresh page after a server restart", async () => {
  const bytes = fakePng(3000, 9), id = sha1(bytes), dataURL = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  let up, down;
  try {
    const a = await rig();
    up = page(a, "owner");
    await up.until(() => up.S.role === "presenter", "the uploader welcomed as a presenter");
    expect(up.upload({ id, mimeType: "image/png", dataURL, width: 100, height: 80 })).toBeTruthy();
    await up.until(async () => (await a.server.blobs.get(a.ids.tenant, id)) !== null && (await a.rawStore.lastSeq(a.ids.tenant, a.ids.board)) >= 1, "the bytes in the Blobs adapter and the element in the log");
    up.close();
    await a.stop();

    const b = await rig({ dir: a.dir, registry: a.registry, ids: a.ids });            // the same data, a new server
    down = page(b, "viewer");
    await down.until(() => down.S.eds.board.doc.files[id]?.dataURL === dataURL, "the picture's bytes in the fresh page's Editor");
    expect(down.wanted).toContain(id);                                                 // asked for by the app's own draw
    expect(down.S.missingFiles()).toEqual([]);
  } finally { up?.close(); down?.close(); }
}, 40_000);

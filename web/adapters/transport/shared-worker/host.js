// The rooms behind the SharedWorker (worker.js): one in-process room per board (the root passes `makeNet`: the
// local transport adapter's localRoom), so several tabs or windows of one browser edit together until the phase-3 server is wired in.
// Also a stand-in Blobs port: picture bytes never travel in ops (the room refuses `files`), so tabs hand them
// here and every tab gets them (the real server uses signed blob URLs: wsNet). Dev only: the rooms live as long as one tab stays open.
// Kept apart from the worker entry so the tests can drive it over a fake port.
//
// Port messages, tab → host: { t: "join", link, board } { t: "send", link, m } { t: "close", link }
//   { t: "drop", link } (dev/test: the link's connection drops unasked) { t: "file", board, file }
// host → tab: { t: "msg", link, m } { t: "dropped", link } { t: "file", file }
//
// Transport contract (web/ports/transport.js): each connection is its own link id. The tab's reopen() closes the
// old link and joins a new one, so a message the host posted for the old link before it saw the close finds
// no handler in the tab and is dropped there (the generation lives in the link id).


const ok = v => typeof v === "string" && v.length > 0 && v.length <= 128;

/**
 * @param {{ makeNet: (board: string) => { join(): import("../../../ports/transport.js").Transport } }} o
 *   makeNet: one room network per board (worker.js: localRoom with auto delivery; tests: a virtual clock).
 */
export function roomHost({ makeNet }) {
  if (typeof makeNet !== "function") throw new TypeError("roomHost: makeNet is required");
  const rooms = new Map();     // board → { net, files: Map, ports: Set }
  const room = board => {
    if (!rooms.has(board)) rooms.set(board, { net: makeNet(board), files: new Map(), ports: new Set() });
    return rooms.get(board);
  };

  function connect(port) {
    const links = new Map();
    port.onmessage = ({ data: d }) => {
      if (!d || typeof d !== "object") return;
      if (d.t === "join" && ok(d.board) && ok(d.link) && !links.has(d.link)) {
        const r = room(d.board);
        if (!r.ports.has(port)) { r.ports.add(port); for (const file of r.files.values()) port.postMessage({ t: "file", file }); }
        const tr = r.net.join();
        tr.onMessage(m => port.postMessage({ t: "msg", link: d.link, m }));
        tr.onDrop(() => port.postMessage({ t: "dropped", link: d.link }));
        links.set(d.link, tr);
      } else if (d.t === "send") links.get(d.link)?.send(d.m);
      else if (d.t === "close") { links.get(d.link)?.close(); links.delete(d.link); }
      else if (d.t === "drop") links.get(d.link)?.fail();
      else if (d.t === "file" && ok(d.board) && d.file && ok(d.file.id) && typeof d.file.dataURL === "string" && d.file.dataURL.length < 14_000_000) {
        const r = room(d.board);
        if (r.files.has(d.file.id)) return;
        const file = { id: d.file.id, mimeType: String(d.file.mimeType ?? ""), dataURL: d.file.dataURL, created: Date.now() };
        r.files.set(file.id, file);
        for (const p of r.ports) p.postMessage({ t: "file", file });
      }
    };
    port.start?.();
  }
  return { connect, room };
}

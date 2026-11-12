// A SharedWorker hosting one in-process reference Room per board (sync.js's localRoom), so several tabs or
// windows of one browser edit together until the phase-3 server is wired in. Also a stand-in Blobs port:
// picture bytes never travel in ops (the room refuses `files`), so tabs hand them here and every tab gets
// them (v1: signed blob URLs). Dev only: the room lives as long as one tab stays open.
//
// Port messages, tab → worker: { t: "join", link, board } { t: "send", link, m } { t: "reopen", link }
//   { t: "close", link } { t: "file", board, file }
// worker → tab: { t: "msg", link, m } { t: "file", file }

import { localRoom } from "../sync.js";

import { DEV_USERS } from "./dev-users.js";

const rooms = new Map();     // board → { net, files: Map, ports: Set }
const room = board => {
  if (!rooms.has(board)) rooms.set(board, { net: localRoom({ board, users: DEV_USERS, auto: true }), files: new Map(), ports: new Set() });
  return rooms.get(board);
};
const ok = v => typeof v === "string" && v.length > 0 && v.length <= 128;

self.onconnect = e => {
  const port = e.ports[0], links = new Map();
  port.onmessage = ({ data: d }) => {
    if (!d || typeof d !== "object") return;
    if (d.t === "join" && ok(d.board) && ok(d.link)) {
      const r = room(d.board);
      if (!r.ports.has(port)) { r.ports.add(port); for (const file of r.files.values()) port.postMessage({ t: "file", file }); }
      const tr = r.net.join();
      tr.onMessage(m => port.postMessage({ t: "msg", link: d.link, m }));
      links.set(d.link, tr);
    } else if (d.t === "send") links.get(d.link)?.send(d.m);
    else if (d.t === "reopen") links.get(d.link)?.reopen();
    else if (d.t === "close") { links.get(d.link)?.close(); links.delete(d.link); }
    else if (d.t === "file" && ok(d.board) && d.file && ok(d.file.id) && typeof d.file.dataURL === "string" && d.file.dataURL.length < 14_000_000) {
      const r = room(d.board);
      if (r.files.has(d.file.id)) return;
      const file = { id: d.file.id, mimeType: String(d.file.mimeType ?? ""), dataURL: d.file.dataURL, created: Date.now() };
      r.files.set(file.id, file);
      for (const p of r.ports) p.postMessage({ t: "file", file });
    }
  };
  port.start();
};

// Where a page's transports come from (sync.js's transport port: { send, onMessage, reopen }).
//   shared: the SharedWorker room (room-worker.js): every tab of this browser on one board edits together.
//   local:  an in-page reference Room (sync.js localRoom) when SharedWorker is missing. One tab only.
// SEAM(phase 3): a WebSocket transport to the server goes here (wanted in sync.js: the codec lives there).
// Also the Blobs stand-in: put(file) shares picture bytes; onFile(fn) receives them.

import { localRoom } from "../sync.js";
import { DEV_USERS } from "./dev-users.js";

export function sharedNet({ board, url = new URL("./room-worker.js", import.meta.url) }) {
  let worker;
  try { worker = new SharedWorker(url, { type: "module", name: "plenary-room" }); } catch { return localNet({ board }); }
  const port = worker.port, handlers = new Map(), fileFns = [];
  let n = 0;
  port.onmessage = ({ data: d }) => {
    if (d?.t === "msg") handlers.get(d.link)?.(d.m);
    else if (d?.t === "file") for (const fn of fileFns) fn(d.file);
  };
  port.start();
  return {
    kind: "shared",
    join() {
      const link = `${Date.now().toString(36)}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
      port.postMessage({ t: "join", link, board });
      return {
        send: m => port.postMessage({ t: "send", link, m }),
        onMessage: fn => handlers.set(link, fn),
        reopen: () => port.postMessage({ t: "reopen", link }),
        close: () => { port.postMessage({ t: "close", link }); handlers.delete(link); },
      };
    },
    put: file => port.postMessage({ t: "file", board, file: { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL } }),
    onFile: fn => fileFns.push(fn),
  };
}

export function localNet({ board }) {
  const net = localRoom({ board, users: DEV_USERS, auto: true });
  return { kind: "local", join: () => net.join(), put: () => {}, onFile: () => {} };
}

export { DEV_USERS };

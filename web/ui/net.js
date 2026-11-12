// Where a page's transports come from (sync.js's transport port; its contract is in web/sync.js's header).
//   shared: the SharedWorker room (room-worker.js → room-host.js): every tab of this browser on one board
//           edits together.
//   local:  an in-page reference Room (sync.js localRoom) when SharedWorker is missing. One tab only.
// SEAM(phase 3): a WebSocket transport to the server goes here (wanted in sync.js: the codec lives there).
// Also the Blobs stand-in: put(file) shares picture bytes; onFile(fn) receives them.

import { localRoom } from "../sync.js";
import { DEV_USERS } from "./dev-users.js";

/**
 * @param {{ board: string, url?: URL, worker?: { port: MessagePort } }} o
 *   worker: an object with a `port` (tests pass a fake); default a SharedWorker on room-worker.js.
 */
export function sharedNet({ board, url = new URL("./room-worker.js", import.meta.url), worker }) {
  if (!worker) {
    try { worker = new SharedWorker(url, { type: "module", name: "plenary-room" }); } catch { return localNet({ board }); }
  }
  const port = worker.port, handlers = new Map(), drops = new Map(), fileFns = [];
  let n = 0;
  port.onmessage = ({ data: d }) => {
    if (d?.t === "msg") handlers.get(d.link)?.(d.m);
    else if (d?.t === "dropped") drops.get(d.link)?.();
    else if (d?.t === "file") for (const fn of fileFns) fn(d.file);
  };
  port.start?.();
  return {
    kind: "shared",
    join() {
      // One link id per connection: reopen() closes the old link and joins a new one, and only the current
      // link has handlers here, so nothing of an older connection is delivered (the contract's generation).
      let link = null, done = false, onMsg = () => {}, onDrop = () => {};
      const open = () => {
        if (link) { port.postMessage({ t: "close", link }); handlers.delete(link); drops.delete(link); link = null; }
        if (done) return;
        const id = link = `${Date.now().toString(36)}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
        handlers.set(id, m => onMsg(m));
        drops.set(id, () => { drops.delete(id); onDrop(); });
        port.postMessage({ t: "join", link: id, board });
      };
      open();
      return {
        send: m => { if (link) port.postMessage({ t: "send", link, m }); },
        onMessage: fn => { onMsg = fn; },
        onDrop: fn => { onDrop = fn; },
        reopen: open,
        close: () => { done = true; open(); },
        /** Dev/test hook: this connection drops without the client asking. */
        fail: () => { if (link) port.postMessage({ t: "drop", link }); },
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

// @ts-check
// Transport adapter, page side of the SharedWorker dev room: implements web/ports/net.js (join → a transport of
// web/ports/transport.js, plus the blobs stand-in put/onFile). The worker side is host.js (driven over a MessagePort)
// with worker.js as its entry. Every tab of this browser on one board edits together.
//
// Generation: one link id per connection. reopen() closes the old link and joins a new one, and only the current
// link has handlers here, so nothing of an older connection is delivered.
// Backpressure: bufferless. postMessage to a worker of the same browser has no network uplink to fill (the
// MessagePort queue drains as fast as the worker's event loop; a stuck worker shows as silence, which the
// Replica's watchdog turns into a resync), so congested() is false and backlogBytes() 0 (manager decision M2:
// "decide its buffer" — decided: report none, rather than invent a worker-side cap that measures nothing real).
// Without SharedWorker (an old Safari, Herdr) sharedNet returns null; the composition root falls back to localNet.

/**
 * @param {{ board: string, url?: URL, worker?: { port: MessagePort } }} o
 *   worker: an object with a `port` (tests pass a fake); default a SharedWorker on worker.js.
 * @returns {import("../../../ports/net.js").Net | null}  null when SharedWorker is missing or refuses to start.
 */
export function sharedNet({ board, url = new URL("./worker.js", import.meta.url), worker }) {
  if (!worker) {
    try { worker = new SharedWorker(url, { type: "module", name: "plenary-room" }); } catch { return null; }
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
      let link = null, done = false;
      /** @type {(msg: any) => void} */
      let onMsg = () => {};
      /** @type {() => void} */
      let onDrop = () => {};
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
        congested: () => false,
        backlogBytes: () => 0,
        close: () => { done = true; open(); },
        /** Dev/test hook: this connection drops without the client asking. */
        fail: () => { if (link) port.postMessage({ t: "drop", link }); },
      };
    },
    put: file => port.postMessage({
      t: "file",
      board,
      file: {
        id: file.id,
        mimeType: file.mimeType,
        ...(file.dataURL !== undefined ? { dataURL: file.dataURL } : {}),
        ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
      },
    }),
    onFile: fn => fileFns.push(fn),
  };
}

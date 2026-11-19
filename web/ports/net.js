// Net port: where a page's transports come from, plus the blobs stand-in (p6-portsv L7). Driven port; types only.
// Imports nothing. Each transport it hands out is contract-tested (test/web/contracts/transport-contract.js).
//
// Contract:
//   kind           "shared" | "local" | (phase 3) "ws": for the status line only.
//   join()         A FRESH transport (web/ports/transport.js) to the page's board, its first connection open. The
//                  session calls it once per stream. Never throws for a network reason (a dead far side is onDrop).
//   put(file)      Share picture bytes { id, mimeType, dataURL } with every other client of the board (wsNet: a signed
//                  blob upload, retried; the dev nets relay between tabs). A net with no blob path ignores it. Never throws.
//   want(id)       OPTIONAL. This client shows a picture whose bytes it lacks: fetch them (wsNet: a signed download);
//                  they arrive through onFile. Called every frame the placeholder is drawn, so it dedupes. Never throws.
//   onFile(fn)     fn(file) for every picture fetched for want(), or (dev nets) shared by another tab.
//   onFail(fn)     OPTIONAL. fn({ id, verb, code, retrying? }) when an upload failed for good (quota, forbidden, …), or, with retrying: true,
//                  is waiting to be tried again (limit: too many uploads; gave-up: the server can't be reached).

/**
 * @typedef {{ id: string, mimeType: string, dataURL: string }} BlobFile
 * @typedef {object} Net
 * @property {string} kind
 * @property {() => import("./transport.js").Transport} join
 * @property {(file: BlobFile) => void} put
 * @property {(id: string) => void} [want]
 * @property {(fn: (file: BlobFile) => void) => void} onFile
 * @property {(fn: (e: { id: string, verb: string, code: string, retrying?: boolean }) => void) => void} [onFail]
 */

export {};

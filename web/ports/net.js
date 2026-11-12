// Net port: where a page's transports come from, plus the blobs stand-in (p6-portsv L7). Driven port; types only.
// Imports nothing. Each transport it hands out is contract-tested (test/web/contracts/transport-contract.js).
//
// Contract:
//   kind           "shared" | "local" | (phase 3) "ws": for the status line only.
//   join()         A FRESH transport (web/ports/transport.js) to the page's board, its first connection open. The
//                  session calls it once per stream. Never throws for a network reason (a dead far side is onDrop).
//   put(file)      Share picture bytes { id, mimeType, dataURL } with every other client of the board (v1: a signed
//                  blob upload). A net with no blob path ignores it. Never throws.
//   onFile(fn)     fn(file) for every picture another client shared (and, on joining, the ones already shared).

/**
 * @typedef {{ id: string, mimeType: string, dataURL: string }} BlobFile
 * @typedef {object} Net
 * @property {string} kind
 * @property {() => import("./transport.js").Transport} join
 * @property {(file: BlobFile) => void} put
 * @property {(fn: (file: BlobFile) => void) => void} onFile
 */

export {};

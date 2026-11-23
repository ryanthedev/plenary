// @ts-check
// Versions port: board version history & named snapshots (#19). Imports nothing.
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error }` with one of VERSIONS_ERRORS:
//   "auth" 401 · "forbidden" 403 · "notfound" 404 · "invalid" 400/422 · "too-large" 413
//   · "limit" 429 (max versions per board reached) · "unavailable" 5xx / bad JSON / wrong shape / timeout · "network" fetch error
//
//   list(board)                       → { versions: BoardVersionMeta[] }   GET    /boards/:board/versions
//   create(board, { label, snapshot }) → { version: BoardVersionMeta }     POST   /boards/:board/versions
//   get(board, versionId)             → { version: BoardVersion }          GET    /boards/:board/versions/:versionId
//   remove(board, versionId)          → { ok: true }                       DELETE /boards/:board/versions/:versionId

export const VERSIONS_ERRORS = Object.freeze([
  "auth",
  "forbidden",
  "notfound",
  "invalid",
  "too-large",
  "limit",
  "unavailable",
  "network",
]);

/**
 * @typedef {{ id: string, label: string, createdBy: string, createdByName: string|null, createdAt: number, elementCount: number }} BoardVersionMeta
 * @typedef {BoardVersionMeta & { snapshot: Record<string, any> }} BoardVersion
 * @typedef {object} VersionsPort
 * @property {(board: string) => Promise<{ versions: BoardVersionMeta[] } | { error: string }>} list
 * @property {(board: string, o: { label: string, snapshot: Record<string, any> }) => Promise<{ version: BoardVersionMeta } | { error: string }>} create
 * @property {(board: string, versionId: string) => Promise<{ version: BoardVersion } | { error: string }>} get
 * @property {(board: string, versionId: string) => Promise<{ ok: true } | { error: string }>} remove
 */
export {};

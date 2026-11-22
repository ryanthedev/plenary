// @ts-check
// The Auth port (PROTOCOL.md § Auth), and `authPort`, its one implementation: a composition over injected Verifier
// adapters (session.js, dev.js) and tenancy.js, importing no adapter. The only thing the gateway imports from
// server/auth. The Identity and Verifier types it uses live in idp-port.js.
//   verify(token) → Promise<{ user, name, email, domain, exp? } | null>   (a Session, idp-port.js; returned as the
//     verifier gave it, so `exp` reaches the gateway, which closes the connection then; dev tokens have none)
//   role(identity, board) → Promise<role | null>
//   access?(identity, board) → Promise<{ role: role | null, share: boolean, move: boolean }>   a hello's whole answer from one read: `share` = the identity holds members.manage here (the welcome's `can.share`), `move` = it holds `move` as a Unit member (`can.move`)
// The gateway awaits both (plus the board lookup) before it forwards a hello; the room sees only {user, role, client}.
// If § Auth changes shape, this file is the one to change.
//
// `verify` accepts a server session token (session.js) or, only when configured, a dev token (dev.js). It never
// accepts a Google ID token and never touches the network.
//
// Refusal vs outage (p5-fix): `null` means REFUSED (the gateway answers `auth`): a malformed, forged, expired or
// unknown token, a bad signature, an unknown board, no role. Infrastructure failures (a Registry that throws, a
// verifier that fails) are NOT refusals: they propagate, and the gateway answers `unavailable`. So verifiers and
// tenancy.role return null for "not mine / invalid" and let genuine failures escape; nothing here catches.

/**
 * The Auth port, as the gateway sees it.
 * @typedef {import("./idp-port.js").Identity} Identity
 * @typedef {import("./idp-port.js").Session} Session
 * @typedef {import("./idp-port.js").Verifier} Verifier
 * @typedef {{
 *   verify(token: unknown): Promise<Session|null>,
 *   role(id: Identity, board: string): Promise<string|null>,
 *   access?(id: Identity, board: string): Promise<{ role: string|null, share: boolean, move: boolean }>,
 *   rolesFor?(board: string, ids: Identity[]): Promise<Map<string, string|null>>,
 *   invalidate?(board: string, user?: string): void,
 * }} Auth
 */

/**
 * @param {{ sessions?: Verifier, dev?: Verifier,
 *   tenancy: {
 *     role(id: Identity, board: string): Promise<string|null>,
 *     access?(id: Identity, board: string): Promise<{ role: string|null, share: boolean, move: boolean }>,
 *     rolesFor?(board: string, ids: Identity[]): Promise<Map<string, string|null>>,
 *     invalidate?(board: string, user?: string): void,
 *   } }} deps
 * @returns {Auth}
 */
export function authPort({ sessions, dev, tenancy }) {
  const verifiers = [sessions, dev].filter(Boolean);
  return {
    async verify(token) {
      if (typeof token !== "string" || !token) return null;
      for (const v of verifiers) {
        const id = await v.verify(token);
        if (id) return id;
      }
      return null;
    },
    // null on refusal (bad identity, unknown board, no role); a Registry error rejects (→ `unavailable`).
    async role(identity, board) {
      return tenancy.role(identity, board);
    },
    // The role plus `share`, from the same read (no second Registry read for the flag).
    async access(identity, board) {
      return typeof tenancy.access === "function" ? tenancy.access(identity, board) : { role: await tenancy.role(identity, board), share: false, move: false };
    },
    // p5-load: the batch (Map user → role|null, fresh) and the cache's invalidation, when the tenancy has them.
    ...(typeof tenancy.rolesFor === "function" ? { rolesFor: (board, identities) => tenancy.rolesFor(board, identities) } : {}),
    ...(typeof tenancy.invalidate === "function" ? { invalidate: (board, user) => tenancy.invalidate(board, user) } : {}),
  };
}

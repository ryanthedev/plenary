// The Auth port adapter (PROTOCOL.md § Auth): the only thing the gateway imports from server/auth.
//   verify(token) → Promise<{ user, name, email, domain } | null>
//   role(identity, board) → Promise<role | null>
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

/** @typedef {import("./oidc.js").Identity} Identity */

/**
 * @param {{ sessions?: { verify(t: string): Promise<Identity|null> }, dev?: { verify(t: string): Promise<Identity|null> },
 *   tenancy: { role(id: Identity, board: string): Promise<string|null> } }} deps
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
  };
}

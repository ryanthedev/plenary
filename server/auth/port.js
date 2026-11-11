// The Auth port adapter (PROTOCOL.md § Auth): the only thing the gateway imports from server/auth.
//   verify(token) → Promise<{ user, name, email, domain } | null>
//   role(identity, board) → Promise<role | null>
// The gateway awaits both (plus the board lookup) before it forwards a hello; the room sees only {user, role, client}.
// If § Auth changes shape, this file is the one to change.
//
// `verify` accepts a server session token (session.js) or, only when configured, a dev token (dev.js). It never
// accepts a Google ID token, never touches the network, and returns null (never throws) on bad input.

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
        try { const id = await v.verify(token); if (id) return id; } catch { /* refuse */ }
      }
      return null;
    },
    // PROTOCOL.md § Auth: resolve null on refusal, never throw. A registry outage therefore also answers `auth`;
    // see the p5-auth report (open point) on whether it should be `unavailable` instead.
    async role(identity, board) {
      try { return await tenancy.role(identity, board); } catch { return null; }
    },
  };
}

// Role resolution: who may do what on a board. Read live from the Registry on every call, so an expired or
// revoked invite or link stops working on the next role() (i.e. the next hello).
//
// A user's role on a board is the HIGHEST of:
//   - an explicit per-board grant (the creator gets `owner`);
//   - a live invite to the user's verified email for that board;
//   - a live share link for that board that this user has redeemed (redeemLink);
//   - the board's `memberRole` (default `viewer`), if the user's Workspace domain (`hd`) is the board tenant's.
// A grant lower than memberRole does not demote a Workspace member (highest wins).
// Nothing else counts: a user from another domain, or another tenant, gets a role only by grant, invite or link
// on that very board. An unknown board and a board with no role both give null (no existence leak).

import { higher, capTo, ROLES, LINK_ROLES, INVITE_ROLES } from "./util.js";

/** @typedef {import("./registry-port.js").Registry} Registry */
/** @typedef {import("./registry-port.js").Role} Role */
/** @typedef {import("./idp-port.js").Identity} Identity */

const live = (x, t) => x && !x.revoked && (x.expiresAt == null || t < x.expiresAt);

/** @param {{ registry: Registry, now?: () => number }} deps */
export function tenancy({ registry, now = Date.now }) {
  return {
    /** @returns {Promise<Role|null>} */
    async role(identity, boardId) {
      if (!identity || typeof identity.user !== "string" || typeof boardId !== "string") return null;
      const board = await registry.board(boardId);
      if (!board) return null;
      const t = now();
      // Every stored role is capped: unknown roles count for nothing; invites and memberRole stay below owner;
      // links stay within LINK_ROLES.
      let r = capTo(await registry.grant(board.id, identity.user), ROLES);
      if (identity.email) for (const i of await registry.invitesFor(board.id, identity.email)) if (live(i, t)) r = higher(r, capTo(i.role, INVITE_ROLES));
      for (const id of await registry.linkUses(board.id, identity.user)) {
        const l = await registry.link(id);
        if (l && l.board === board.id && live(l, t)) r = higher(r, capTo(l.role, LINK_ROLES));
      }
      if (identity.domain && board.memberRole) {
        const tenant = await registry.tenant(board.tenant);
        if (tenant?.domain && tenant.domain === identity.domain) r = higher(r, capTo(board.memberRole, INVITE_ROLES));
      }
      return r ?? null;
    },

    /**
     * A signed-in user opened a share link. Records the use and returns `{ board }`, or null for an unknown,
     * expired or revoked link (all the same answer). The role itself is re-read from the link on every role().
     */
    async redeemLink(identity, linkId) {
      if (!identity || typeof identity.user !== "string" || typeof linkId !== "string") return null;
      const l = await registry.link(linkId);
      if (!live(l, now())) return null;
      await registry.addLinkUse(l.id, identity.user);
      return { board: l.board };
    },

    /** The tenant an identity belongs to by Workspace domain, or null (no `hd` = guest only). */
    async tenantOf(identity) {
      return identity?.domain ? registry.tenantByDomain(identity.domain) : null;
    },
  };
}

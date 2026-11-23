// @ts-check
// Deterministic in-memory adapter for the EntraDirectory port (#87), for unit and integration tests.

import { ENTRA_DIRECTORY_METHODS } from "../../../ports/entra-directory.js";

/**
 * Create a deterministic in-memory `EntraDirectoryPort` adapter.
 *
 * @param {{
 *   groups?: import("../../../ports/entra-directory.js").EntraGroup[],
 *   membersByGroup?: Record<string, import("../../../ports/entra-directory.js").EntraMember[]> | Map<string, import("../../../ports/entra-directory.js").EntraMember[]>,
 * }} [seed]
 * @returns {import("../../../ports/entra-directory.js").EntraDirectoryPort}
 */
export function memoryEntraDirectory({ groups = [], membersByGroup = {} } = {}) {
  const groupList = groups.map(g => ({
    id: String(g.id),
    displayName: typeof g.displayName === "string" ? g.displayName : String(g.id),
    description: g.description ?? null,
    mail: g.mail ?? null,
  }));

  /** @type {Map<string, import("../../../ports/entra-directory.js").EntraMember[]>} */
  const membersMap = new Map();
  if (membersByGroup instanceof Map) {
    for (const [gid, list] of membersByGroup.entries()) {
      membersMap.set(
        String(gid),
        (list ?? []).map(m => ({
          id: String(m.id),
          displayName: m.displayName ?? null,
          mail: m.mail ?? null,
          userPrincipalName: m.userPrincipalName ?? null,
        })),
      );
    }
  } else {
    for (const [gid, list] of Object.entries(membersByGroup ?? {})) {
      membersMap.set(
        String(gid),
        (list ?? []).map(m => ({
          id: String(m.id),
          displayName: m.displayName ?? null,
          mail: m.mail ?? null,
          userPrincipalName: m.userPrincipalName ?? null,
        })),
      );
    }
  }

  void ENTRA_DIRECTORY_METHODS;

  return {
    async listGroups() {
      return groupList.map(g => ({ ...g }));
    },
    async listGroupMembers(groupId) {
      const list = membersMap.get(String(groupId)) ?? [];
      return list.map(m => ({ ...m }));
    },
  };
}

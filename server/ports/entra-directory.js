// @ts-check
// The EntraDirectory port (#87): read-only Microsoft Entra ID directory access for Unit-admin Team sync.
//   listGroups(opts?)               list Entra ID security / M365 groups
//   listGroupMembers(groupId, opts?) list members of an Entra ID group
//
// Documented port interface and shared constants only; no adapter code and no bare packages.
// Adapters (entra-graph.js, entra-memory.js) import this module and never import each other.

/** The method names every EntraDirectory adapter implements. */
export const ENTRA_DIRECTORY_METHODS = Object.freeze([
  "listGroups",
  "listGroupMembers",
]);

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   description?: string | null,
 *   mail?: string | null,
 * }} EntraGroup
 */

/**
 * @typedef {{
 *   id: string,
 *   displayName?: string | null,
 *   mail?: string | null,
 *   userPrincipalName?: string | null,
 * }} EntraMember
 */

/**
 * @typedef {{
 *   maxPages?: number,
 * }} EntraListOptions
 */

/**
 * @typedef {{
 *   listGroups(opts?: EntraListOptions): Promise<EntraGroup[]>,
 *   listGroupMembers(groupId: string, opts?: EntraListOptions): Promise<EntraMember[]>,
 * }} EntraDirectoryPort
 */

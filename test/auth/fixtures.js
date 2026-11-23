// Test fixtures for the auth tests. `createBoard` is NOT the product rule (that is server/auth/spaces.js: board.create at a Space or
// the personal space): it makes a board with an owner grant directly, as a test setup step, with no permission check. Every board lives
// in a Space (Registry.createBoard requires one), so these helpers file a board in a per-Unit "Fixtures" Space with no general access.
import { ROLES } from "../../server/core/auth/util.js";

const fixtureSpaces = new WeakMap();
/** The id of a Space (no general access, no owner) in `tenant`, made once per Registry object; for tests that only need a place for a board. */
export async function spaceOf(registry, tenant) {
  if (!fixtureSpaces.has(registry)) fixtureSpaces.set(registry, new Map());
  const m = fixtureSpaces.get(registry);
  if (!m.has(tenant)) m.set(tenant, registry.createSpace({ tenant, name: "Fixtures", generalRole: null }).then(s => s.id));
  return m.get(tenant);
}
/** `registry.createBoard(o)` in the Unit's fixture Space unless `o.space` is given; with no `space`, `memberRole` defaults to "viewer" (what an unfiled board used to get); with one it inherits (null), as the Registry does. */
export async function mkBoard(registry, o) { return o.space ? registry.createBoard(o) : registry.createBoard({ memberRole: "viewer", ...o, space: await spaceOf(registry, o.tenant) }); }

/** A board (memberRole default viewer) in the Unit's fixture Space, owned by `caller`. */
export async function createBoard({ caller, tenant, title = "", memberRole = "viewer" }, { registry }) {
  if (memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw new Error("bad memberRole");
  const board = await mkBoard(registry, { tenant, title, memberRole });
  await registry.setGrant(board.id, caller.user, "owner");
  return board;
}

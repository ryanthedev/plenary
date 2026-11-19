// Test fixtures for the auth tests. `createBoard` is NOT the product rule (that is server/auth/spaces.js: board.create at a Space or
// the personal space): it makes an unfiled board with an owner grant directly, as a test setup step, with no permission check.
import { ROLES } from "../../server/auth/util.js";

/** An unfiled board (memberRole default viewer) owned by `caller`. */
export async function createBoard({ caller, tenant, title = "", memberRole = "viewer" }, { registry }) {
  if (memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw new Error("bad memberRole");
  const board = await registry.createBoard({ tenant, title, memberRole });
  await registry.setGrant(board.id, caller.user, "owner");
  return board;
}

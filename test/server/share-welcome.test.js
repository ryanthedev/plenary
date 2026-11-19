// The welcome's `can.share` (PROTOCOL.md § Share dialog, "Who may open it"): members.manage on the board, from the same Access the hello resolves (no second Registry
// read), present only when true, on both welcome paths (a viewer's is built by the gateway, a writer's by the room and passed through), through the role cache too.
import { test, expect } from "bun:test";
import { rig, tokenOf } from "./rig.js";

const hello = (r, name) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name });
const welcomeOf = async (r, name) => { const s = await r.sock(); s.send(hello(r, name)); const w = await s.next(m => m.t === "welcome"); return w; };
/** `stranger` is a Unit member (domain acme.test) holding a custom role at the Unit: `boardRole` plus members.manage (or not). */
async function managerRig(boardRole, permissions, extra = {}) {
  const withDomain = a => ({ ...a, async verify(t) { const id = await a.verify(t); return id && id.user === "dev:stranger" ? { ...id, domain: "acme.test" } : id; } });
  const r = await rig({ wrapAuth: withDomain, ...extra });
  const role = await r.registry.createRole({ tenant: r.ids.tenant, name: "Manager", boardRole, permissions });
  await r.registry.setScopedGrant({ scope: { type: "unit", id: r.ids.tenant }, subject: { type: "user", id: "dev:stranger" }, role: role.id });
  return r;
}

test("DW-52.3c the welcome says can.share only to a members.manage holder: the owner yes, an editor and a viewer no (writer path through the room, viewer path in the gateway)", async () => {
  const r = await rig();
  expect((await welcomeOf(r, "owner")).can).toEqual({ share: true });
  expect(await welcomeOf(r, "editor")).not.toHaveProperty("can");
  const v = await welcomeOf(r, "viewer");
  expect(v).toMatchObject({ role: "viewer" }); expect(v).not.toHaveProperty("can");
  await r.stop();
});

test("DW-52.3d a custom role with members.manage and an ANNOTATOR board step (a writer) and one with a VIEWER step (gateway-built welcome) both get can.share; without members.manage neither does", async () => {
  for (const [boardRole, permissions, want] of [["annotator", ["members.manage"], true], ["viewer", ["members.manage"], true], ["annotator", [], false], ["viewer", [], false]]) {
    const r = await managerRig(boardRole, permissions);
    const w = await welcomeOf(r, "stranger");
    expect(w.role).toBe(boardRole);
    if (want) expect(w.can).toEqual({ share: true }); else expect(w).not.toHaveProperty("can");
    await r.stop();
  }
});

test("through the role cache: the cached answer carries the flag, so a second hello says the same", async () => {
  const r = await managerRig("annotator", ["members.manage"], { cache: {} });
  expect((await welcomeOf(r, "stranger")).can).toEqual({ share: true });
  expect((await welcomeOf(r, "stranger")).can).toEqual({ share: true });
  expect(r.cacheCalls.rolesFor + r.calls.role).toBeGreaterThan(0);
  await r.stop();
});

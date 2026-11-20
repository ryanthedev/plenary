// A personal space and its boards belong to their owner (TECH-DEBT row 67; PROTOCOL.md § Organization, § Move board): a manage-only Unit admin sees and controls nothing of a live member's personal board, with no
// grant AND with a viewer grant the owner gave them. Route level: move (options, preview, move), trash, both grant routes, links, invites, rename. The owner and a content-access admin still can, and a viewer-granted admin only views.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { mayMove } from "../../server/auth/resolver.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";

const ORIGIN = "https://plenary.test";
let r, acme, diary, adaSp, rootSp, plain, content, ten;
const ada = { user: "dev:ada", name: "ada", email: "ada@acme.com", domain: "acme.com" }, root = { user: "dev:root", name: "root", email: "root@acme.com", domain: "acme.com" };

async function mkRoutes() {
  const t = makeTenancy({ registry: r });
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, root: { name: "root", domain: "acme.com", email: "root@acme.com" }, bo: { name: "bo", domain: "acme.com", email: "bo@acme.com" }, chief: { name: "chief", domain: "acme.com", email: "chief@acme.com" } } });
  const routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: t,
    config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
  let n = 0;
  return async (tok, path, method = "GET", body) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, "idempotency-key": `pk-${++n}-${crypto.randomUUID()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return res.status;
  };
}
beforeEach(async () => {
  r = memoryRegistry();
  acme = await r.createTenant({ domain: "acme.com", admins: ["dev:root", "dev:chief"] });
  await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: "dev:chief" }, role: "content-admin-personal" });   // chief: a Unit admin WITH the content tier; root: manage-only
  for (const p of [ada, root, { user: "dev:chief", name: "chief", email: "chief@acme.com" }, { user: "dev:bo", name: "bo", email: "bo@acme.com" }]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  adaSp = await r.ensurePersonalSpace(acme.id, ada.user);
  diary = await r.createBoard({ tenant: acme.id, title: "Diary", space: adaSp.id, owner: ada.user, memberRole: null });
  rootSp = await r.createSpace({ tenant: acme.id, name: "Root's", generalRole: null, owner: root.user });
  plain = await mkRoutes(); content = plain; ten = makeTenancy({ registry: r });
});
const attacks = api => [
  ["move options", () => api("root", `/boards/${diary.id}/move`)],
  ["move preview", () => api("root", `/boards/${diary.id}/move/preview?to=${rootSp.id}`)],
  ["move", () => api("root", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: rootSp.id })],
  ["trash", () => api("root", `/boards/${diary.id}/trash`, "POST", { from: adaSp.id })],
  ["grant (admin route)", () => api("root", `/boards/${diary.id}/grants/dev:root`, "PUT", { role: "owner" })],
  ["grant (access route)", () => api("root", `/access/board/${diary.id}/grants/user/dev:root`, "PUT", { role: "owner" })],
  ["link", () => api("root", `/boards/${diary.id}/links`, "POST", { role: "editor", expiresAt: null })],
  ["invite", () => api("root", `/boards/${diary.id}/invites`, "POST", { email: "x@acme.com", role: "editor", expiresAt: null })],
  ["rename", () => api("root", `/boards/${diary.id}`, "PATCH", { title: "pwned" })],
];
for (const [label, setup] of [["no grant", async () => {}], ["an owner-given viewer grant", async () => r.setGrant(diary.id, root.user, "viewer")]]) {
  describe(`manage-only admin with ${label}`, () => {
    test("every route refuses and nothing changes; can.move is false", async () => {
      await setup();
      for (const [name, call] of attacks(plain)) { const st = await call(); if (![403, 404].includes(st)) throw new Error(`${name}: ${st}`); }   // the refusal, not a 400 for a malformed body
      const b = await r.board(diary.id);
      expect([b.space, b.title, b.trashedAt ?? null]).toEqual([adaSp.id, "Diary", null]);
      expect(await r.grant(diary.id, root.user)).toBe(label === "no grant" ? null : "viewer");
      expect((await r.links?.(diary.id) ?? []).length).toBe(0);
      const a = await ten.effective(root, diary.id);
      expect([a.permissions.has("move"), mayMove(a), (await ten.access(root, diary.id)).move]).toEqual([false, false, false]);
      for (const p of ["delete", "members.manage", "board.edit", "transfer"]) expect(a.permissions.has(p)).toBe(false);
    });
  });
}
test("a viewer-granted manage-only admin can only view", async () => {
  await r.setGrant(diary.id, root.user, "viewer");
  const a = await ten.effective(root, diary.id);
  expect(a.ladder).toBe("viewer");
  expect([...a.permissions].sort()).toEqual(["board.view"]);
});
test("the owner still moves, renames, shares and trashes their own personal board", async () => {
  expect(await plain("ada", `/boards/${diary.id}`, "PATCH", { title: "Mine" })).toBe(200);
  expect(await plain("ada", `/boards/${diary.id}/links`, "POST", { role: "viewer", expiresAt: null })).toBe(201);
  expect(await plain("ada", `/boards/${diary.id}/move`)).toBe(200);
  expect(await plain("ada", `/boards/${diary.id}/trash`, "POST", { from: adaSp.id })).toBe(200);
});
test("a content.personal holder opens, renames, trashes, restores and moves out a personal board, but never shares it (grant, link, invite) or makes its own grant (#88 M2); a manage-only admin still manages a SHARED-space board", async () => {
  expect(await content("chief", `/boards/${diary.id}`, "PATCH", { title: "ok" })).toBe(200);
  expect(await content("chief", `/boards/${diary.id}/grants/dev:bo`, "PUT", { role: "viewer" })).toBe(403);
  expect(await content("chief", `/access/board/${diary.id}/grants/user/dev:bo`, "PUT", { role: "viewer" })).toBe(403);
  expect(await content("chief", `/boards/${diary.id}/links`, "POST", { role: "viewer", expiresAt: null })).toBe(403);
  expect(await content("chief", `/boards/${diary.id}/invites`, "POST", { email: "x@acme.com", role: "viewer", expiresAt: null })).toBe(403);
  expect(await content("chief", `/boards/${diary.id}/move`)).toBe(200);
  const shared = await r.createBoard({ tenant: acme.id, title: "Shared", space: rootSp.id, owner: ada.user, memberRole: null });
  const other = await r.createSpace({ tenant: acme.id, name: "Other", generalRole: null, owner: ada.user });
  await r.setScopedGrant({ scope: { type: "space", id: other.id }, subject: { type: "user", id: root.user }, role: "owner" });
  expect(await plain("root", `/boards/${shared.id}/grants/dev:bo`, "PUT", { role: "viewer" })).toBe(204);
  expect(await plain("root", `/boards/${shared.id}/links`, "POST", { role: "viewer", expiresAt: null })).toBe(201);
  expect(await plain("root", `/boards/${shared.id}`, "PATCH", { title: "ren" })).toBe(200);
  expect(await plain("root", `/boards/${shared.id}/move`, "POST", { from: rootSp.id, to: other.id })).toBe(200);
  expect((await r.board(shared.id)).space).toBe(other.id);
});

describe("Teams (the personal-space rule reaches the Team path)", () => {
  let team;
  beforeEach(async () => {
    team = await r.createTeam({ tenant: acme.id, name: "T" });
    await r.setScopedGrant({ scope: { type: "board", id: diary.id }, subject: { type: "team", id: team.id }, role: "editor" });
  });
  const members = async () => (await r.teamMembers?.(team.id, {}))?.users ?? null;
  test("a manage-only admin may not add anyone (himself included) to a Team that holds a grant on a personal board: 403, nothing changes", async () => {
    expect(await plain("root", `/teams/${team.id}/members/dev:root`, "PUT")).toBe(403);
    expect(await plain("root", `/teams/${team.id}/members/dev:bo`, "PUT")).toBe(403);
    const a = await ten.effective(root, diary.id);
    expect(a.ladder).toBe(null);
    expect((await r.teamsAmong(acme.id, [team.id]))[0].size).toBe(0);
  });
  test("a Team with only shared-Space grants: the admin adds; the admin removes from T; the owner adds to T", async () => {
    const t2 = await r.createTeam({ tenant: acme.id, name: "T2" });
    await r.setScopedGrant({ scope: { type: "space", id: rootSp.id }, subject: { type: "team", id: t2.id }, role: "editor" });
    expect(await plain("root", `/teams/${t2.id}/members/dev:bo`, "PUT")).toBe(204);
    const tm = await r.createRole({ tenant: acme.id, name: "Team keeper", boardRole: null, permissions: ["team.manage"] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: ada.user }, role: tm.id });
    expect(await plain("ada", `/teams/${team.id}/members/dev:bo`, "PUT")).toBe(204);     // team.manage, and members.manage on her own board
    expect((await r.teamsAmong(acme.id, [team.id]))[0].size).toBe(1);
    expect(await plain("root", `/teams/${team.id}/members/dev:bo`, "DELETE")).toBe(204);   // removing never widens: open to admins
    expect((await r.teamsAmong(acme.id, [team.id]))[0].size).toBe(0);
  });
});

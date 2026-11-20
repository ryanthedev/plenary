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

async function mkRoutes(adminBoardContent) {
  const t = makeTenancy({ registry: r, adminBoardContent });
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, root: { name: "root", domain: "acme.com", email: "root@acme.com" }, bo: { name: "bo", domain: "acme.com", email: "bo@acme.com" } } });
  const routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: t, adminBoardContent,
    config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
  let n = 0;
  return async (tok, path, method = "GET", body) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, "idempotency-key": `pk-${++n}-${crypto.randomUUID()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return res.status;
  };
}
beforeEach(async () => {
  r = memoryRegistry();
  acme = await r.createTenant({ domain: "acme.com", admins: ["dev:root"] });
  for (const p of [ada, root, { user: "dev:bo", name: "bo", email: "bo@acme.com" }]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  adaSp = await r.ensurePersonalSpace(acme.id, ada.user);
  diary = await r.createBoard({ tenant: acme.id, title: "Diary", space: adaSp.id, owner: ada.user, memberRole: null });
  rootSp = await r.createSpace({ tenant: acme.id, name: "Root's", generalRole: null, owner: root.user });
  plain = await mkRoutes(false); content = await mkRoutes(true); ten = makeTenancy({ registry: r });
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
test("a content-access admin (board content on) still moves, grants, shares and renames; and a manage-only admin still manages a SHARED-space board", async () => {
  expect(await content("root", `/boards/${diary.id}/move`)).toBe(200);
  expect(await content("root", `/boards/${diary.id}/grants/dev:bo`, "PUT", { role: "viewer" })).toBe(204);
  expect(await content("root", `/boards/${diary.id}/links`, "POST", { role: "viewer", expiresAt: null })).toBe(201);
  expect(await content("root", `/boards/${diary.id}`, "PATCH", { title: "ok" })).toBe(200);
  const shared = await r.createBoard({ tenant: acme.id, title: "Shared", space: rootSp.id, owner: root.user, memberRole: null });
  const other = await r.createSpace({ tenant: acme.id, name: "Other", generalRole: null, owner: ada.user });
  await r.setGrant(shared.id, ada.user, "viewer");
  expect(await plain("root", `/boards/${shared.id}/grants/dev:bo`, "PUT", { role: "viewer" })).toBe(204);
  expect(await plain("root", `/boards/${shared.id}/move`, "POST", { from: rootSp.id, to: other.id })).toBeLessThan(500);
});

// web/adapters/share/http.js over a fake fetch: the requests (PROTOCOL.md § Share dialog), the shapes it accepts, the error codes, and that no call ever rejects.
import { test, expect } from "bun:test";
import { httpShare, normalizeShareView } from "../../../web/adapters/share/http.js";
import { SHARE_ERRORS } from "../../../web/ports/share.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const VIEW = { board: { id: "b-1", title: "Roadmap" }, unit: { domains: ["acme.com"] }, limits: { inviteRoles: ["viewer", "editor"], linkRoles: ["viewer"], inviteTtlMs: 2592000000 },
  invites: [{ id: "i-1", email: "kim@partner.io", role: "viewer", expiresAt: 5, createdAt: 1, guest: true }], links: [{ id: "lnk1", role: "viewer", expiresAt: null, createdAt: 1, url: "https://p/links/lnk1" }], more: false };

test("routes, methods, bodies and the Idempotency-Key; an omitted expiresAt is not sent, null is", async () => {
  const calls = [];
  const a = httpShare({ token: "tok", fetch: async (url, init) => { calls.push([init.method, url, init.body ? JSON.parse(init.body) : undefined, init.headers["idempotency-key"], init.headers.authorization]);
    return answer(init.method === "DELETE" ? 204 : url.endsWith("/share") ? 200 : 201, init.method === "DELETE" ? "" : url.endsWith("/share") ? VIEW : url.endsWith("/invites") ? { invite: VIEW.invites[0] } : { link: VIEW.links[0] })(); } });
  await a.view("b-1"); await a.invite("b-1", { email: "k@p.io", role: "viewer" }, "key-0001-abcd"); await a.invite("b-1", { email: "k@p.io", role: "viewer", expiresAt: null });
  await a.link("b-1", { role: "viewer", expiresAt: 9 }, "key-0002-abcd"); await a.revokeInvite("b-1", "i-1"); await a.revokeLink("b-1", "lnk1");
  expect(calls).toEqual([
    ["GET", "/boards/b-1/share", undefined, undefined, "Bearer tok"],
    ["POST", "/boards/b-1/invites", { email: "k@p.io", role: "viewer" }, "key-0001-abcd", "Bearer tok"],
    ["POST", "/boards/b-1/invites", { email: "k@p.io", role: "viewer", expiresAt: null }, undefined, "Bearer tok"],
    ["POST", "/boards/b-1/links", { role: "viewer", expiresAt: 9 }, "key-0002-abcd", "Bearer tok"],
    ["DELETE", "/boards/b-1/invites/i-1", undefined, undefined, "Bearer tok"], ["DELETE", "/boards/b-1/links/lnk1", undefined, undefined, "Bearer tok"]]);
});

test("statuses map to the port's error names; a bad body or a timeout is unavailable; nothing rejects; bad ids never reach the network", async () => {
  const codes = { 400: "invalid", 401: "auth", 403: "forbidden", 404: "notfound", 409: "conflict", 422: "invalid", 429: "limited", 503: "unavailable" };
  for (const [st, name] of Object.entries(codes)) { expect(SHARE_ERRORS).toContain(name); expect(await httpShare({ token: "t", fetch: answer(Number(st), {}) }).view("b-1")).toEqual({ error: name }); }
  expect(await httpShare({ token: "t", fetch: answer(200, "not json") }).view("b-1")).toEqual({ error: "unavailable" });
  expect(await httpShare({ token: "t", fetch: answer(200, { board: { id: "b-1" } }) }).view("b-1")).toEqual({ error: "unavailable" });
  expect(await httpShare({ token: "t", fetch: async () => { throw new Error("x"); } }).view("b-1")).toEqual({ error: "network" });
  const never = httpShare({ token: "t", fetch: () => new Promise(() => {}), timers: { set: f => { f(); return 0; }, clear() {} } });
  expect(await never.view("b-1")).toEqual({ error: "unavailable" });
  let hit = 0; const a = httpShare({ token: "t", fetch: async () => { hit++; return answer(204, "")(); } });
  expect(await a.revokeLink("b-1", "../x")).toEqual({ error: "forbidden" }); expect(await a.view("a b")).toEqual({ error: "notfound" }); expect(hit).toBe(0);
});

test("normalizeShareView: capped and cleaned; the link url of a create comes from the answer's own `url`", async () => {
  expect(normalizeShareView(VIEW)).toEqual(VIEW);
  const junk = normalizeShareView({ ...VIEW, invites: [...VIEW.invites, { id: "bad id", email: "x", role: "v" }, null, { id: "i-2", email: "a@b.c", role: "viewer", expiresAt: "soon" }], extra: 1 });
  expect(junk.invites).toHaveLength(1);
  expect("extra" in junk).toBe(false);
  expect(normalizeShareView({ ...VIEW, unit: null }).unit).toBeNull();           // a caller outside the Unit is sent no domain list
  const made = await httpShare({ token: "t", fetch: answer(201, { link: { id: "lnk2", role: "viewer", expiresAt: null, createdAt: 2 }, url: "https://p/links/lnk2" }) }).link("b-1", { role: "viewer" });
  expect(made.link.url).toBe("https://p/links/lnk2");
});

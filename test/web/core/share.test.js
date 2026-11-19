// web/core/share.js: guest tagging, one Idempotency-Key per submit, the 30-day default (left to the server), revoke, and the read-only rows (one source: the access page).
import { test, expect } from "bun:test";
import { createShareModel, emailOf, guestOf, expiryText } from "../../../web/core/share.js";

const DAY = 86_400_000, NOW = 1_000_000;
const VIEW = () => ({ board: { id: "b-1", title: "Roadmap" }, unit: { domains: ["acme.com", "acme.org"] }, limits: { inviteRoles: ["viewer", "commenter", "annotator", "editor"], linkRoles: ["viewer", "annotator", "editor"], inviteTtlMs: 30 * DAY },
  invites: [{ id: "i-1", email: "kim@partner.io", role: "viewer", expiresAt: NOW + 3 * DAY, createdAt: 1, guest: true }], links: [{ id: "lnk1", role: "viewer", expiresAt: null, createdAt: 1 }], more: false });
const PAGE = { scope: { type: "board", id: "b-1" }, can: { manage: true }, general: [{ scope: { type: "space", id: "s-1", name: "Design" }, role: "viewer" }],
  rows: [{ subject: { type: "user", id: "u1", name: "Ada" }, role: "owner", roleName: "Owner", via: "direct" }, { subject: { type: "team", id: "tm-1", name: "Infra" }, role: "editor", roleName: "Editor", via: "team" }],
  next: null, inherited: [{ scope: { type: "group", id: "g-1", name: "Product" }, subject: { type: "team", id: "tm-2", name: "Product owners" }, role: "owner", roleName: "Owner", via: "inherited" }], roles: [],
  organization: { admins: [{ user: "x", name: "Priya" }], more: false, memberRole: null } };
function setup(over = {}) {
  const calls = [];
  const share = { async view() { calls.push(["view"]); return over.view ?? { view: VIEW() }; }, async invite(b, body, key) { calls.push(["invite", body, key]); return over.invite?.(body) ?? { invite: { id: "i-2", email: body.email, role: body.role, expiresAt: NOW + 30 * DAY, createdAt: 2, guest: !body.email.endsWith("@acme.com") } }; },
    async link(b, body, key) { calls.push(["link", body, key]); return { link: { id: "lnk2", role: body.role, expiresAt: body.expiresAt, createdAt: 2 } }; },
    async revokeInvite(b, id) { calls.push(["revokeInvite", id]); return over.revoke ?? {}; }, async revokeLink(b, id) { calls.push(["revokeLink", id]); return {}; } };
  const access = { async access() { calls.push(["access"]); return over.access ?? { page: PAGE }; } };
  let n = 0;
  const m = createShareModel({ share, access, board: "b-1", now: () => NOW, newKey: () => `key-${++n}-aaaaaaaa`, urls: { board: "https://p/?board=b-1", link: id => `https://p/links/${id}` } });
  return { m, calls };
}

test("emailOf / guestOf / expiryText", () => {
  expect(emailOf("  Kim@Partner.IO ")).toBe("kim@partner.io"); expect(emailOf("kim@partner")).toBe(null); expect(emailOf("a b@c.io")).toBe(null);
  expect(guestOf("kim@partner.io", ["acme.com"])).toBe(true); expect(guestOf("Ann@ACME.com", ["acme.com"])).toBe(false); expect(guestOf("ann@", ["acme.com"])).toBe(null);
  expect(guestOf("x@evilacme.com", ["acme.com"])).toBe(true);                                  // a suffix of the name is not the domain
  expect(expiryText(null, NOW)).toBe("never expires"); expect(expiryText(NOW + DAY, NOW)).toBe("expires in 1 day"); expect(expiryText(NOW + 12 * DAY - 5, NOW)).toBe("expires in 12 days"); expect(expiryText(NOW - 1, NOW)).toBe("expires today");
});

test("DW-52.1 invite: the guest tag follows the address; the default 30 days sends no expiresAt (the server's clock sets it); another choice sends one; the list gains the row", async () => {
  const { m, calls } = setup(); await m.load();
  expect(m.state.status).toBe("ready");
  m.set("email", "Kim@Partner.io"); expect(m.guestOf()).toBe(true); m.set("email", "ann@acme.org"); expect(m.guestOf()).toBe(false);
  m.set("email", "kim@partner.io"); m.set("role", "annotator");
  expect(await m.invite()).toBe(true);
  expect(calls.at(-1)).toEqual(["invite", { email: "kim@partner.io", role: "annotator" }, "key-1-aaaaaaaa"]);
  expect(m.state.view.invites[0]).toMatchObject({ id: "i-2", email: "kim@partner.io", guest: true });
  expect(m.state.sent).toMatchObject({ email: "kim@partner.io", guest: true });
  expect(m.state.said).toContain("a guest"); expect(m.state.form.email).toBe("");
  m.set("email", "bo@acme.com"); m.set("inviteDays", 7); await m.invite();
  expect(calls.at(-1)[1]).toEqual({ email: "bo@acme.com", role: "annotator", expiresAt: NOW + 7 * DAY });
  m.set("email", "z@acme.com"); m.set("inviteDays", null); await m.invite();
  expect(calls.at(-1)[1].expiresAt).toBe(null);                                                // never: sent on purpose
});

test("a bad address is refused before any request", async () => {
  const { m, calls } = setup(); await m.load();
  m.set("email", "nobody"); expect(await m.invite()).toBe(false);
  expect(calls.filter(c => c[0] === "invite")).toEqual([]); expect(m.state.notice).toContain("full email address");
});

test("one Idempotency-Key per submit: a retry after a failure reuses it, a changed body or a success starts a new one", async () => {
  let fail = true;
  const { m, calls } = setup({ invite: () => (fail ? { error: "unavailable" } : undefined) }); await m.load();
  m.set("email", "kim@partner.io");
  expect(await m.invite()).toBe(false); expect(m.state.notice).toContain("may have been created");
  expect(await m.invite()).toBe(false);
  fail = false;
  expect(await m.invite()).toBe(true);
  expect(calls.filter(c => c[0] === "invite").map(c => c[2])).toEqual(["key-1-aaaaaaaa", "key-1-aaaaaaaa", "key-1-aaaaaaaa"]);
  m.set("email", "kim@partner.io"); await m.invite();
  expect(calls.at(-1)[2]).toBe("key-2-aaaaaaaa");                                              // after a success the next one is new
  m.set("role", "editor"); m.set("email", "x@partner.io"); fail = true; await m.invite(); m.set("email", "y@partner.io"); await m.invite();
  expect(calls.at(-1)[2]).not.toBe(calls.at(-2)[2]);
});

test("DW-52.2 link: role and expiry; the address is built from the page's own origin", async () => {
  const { m, calls } = setup(); await m.load();
  m.set("linkRole", "annotator"); m.set("linkDays", 30);
  expect(await m.makeLink()).toBe(true);
  expect(calls.at(-1)).toEqual(["link", { role: "annotator", expiresAt: NOW + 30 * DAY }, "key-1-aaaaaaaa"]);
  expect(m.state.view.links[0].id).toBe("lnk2");
  expect(m.linkUrl(m.state.view.links[0])).toBe("https://p/links/lnk2"); expect(m.linkUrl({ id: "x", url: "https://srv/links/x" })).toBe("https://p/links/x");       // the page's origin, not the server's default name
  expect(m.boardUrl()).toBe("https://p/?board=b-1");
});

test("DW-52.5 revoke: the row goes, the sentence says access ends within about a minute; a failure keeps the row; busy refuses a second", async () => {
  const { m, calls } = setup(); await m.load();
  expect(await m.revokeInvite("i-1")).toBe(true);
  expect(m.state.view.invites).toEqual([]); expect(m.state.said).toContain("within about a minute");
  expect(await m.revokeLink("lnk1")).toBe(true); expect(m.state.view.links).toEqual([]); expect(calls.map(c => c[0]).filter(x => x.startsWith("revoke"))).toEqual(["revokeInvite", "revokeLink"]);
  const f = setup({ revoke: { error: "network" } }); await f.m.load();
  expect(await f.m.revokeInvite("i-1")).toBe(false); expect(f.m.state.view.invites).toHaveLength(1); expect(f.m.state.notice).toContain("No answer");
});

test("DW-52.3 the access rows are the access page's, read-only: this board's people, what is inherited and where from, general access, admins", async () => {
  const { m } = setup(); await m.load();
  expect(m.accessRows()).toEqual([
    { group: "board", name: "Ada", role: "Owner", from: "Added directly" }, { group: "board", name: "Infra", role: "Editor", from: "Team" },
    { group: "inherited", name: "Product owners", role: "Owner", from: "via Group Product" },
    { group: "inherited", name: "Everyone in the organization", role: "Viewer", from: "via Space Design" },
    { group: "inherited", name: "Priya", role: "Admin", from: "organization admins manage access, not content" }]);
});

test("statuses: forbidden is the whole answer (no lists, no names); an unavailable access page keeps invites and links working", async () => {
  const f = setup({ view: { error: "forbidden" } }); await f.m.load();
  expect(f.m.state).toMatchObject({ status: "forbidden", view: null });
  const g = setup({ access: { error: "notfound" } }); await g.m.load();
  expect(g.m.state).toMatchObject({ status: "ready", pageStatus: "unavailable" }); expect(g.m.accessRows()).toEqual([]);
  const a = setup({ view: { error: "auth" } }); await a.m.load(); expect(a.m.state.status).toBe("signed-out");
});

test("DW-52.1b a retry after a lost answer resends the SAME body (expiresAt computed once per key), invite and link, on an advancing clock; a changed form or a success starts over", async () => {
  let t = NOW, fail = true;
  const calls = [];
  const share = { async view() { return { view: VIEW() }; },
    async invite(b, body, key) { calls.push(["invite", body, key]); return fail ? { error: "unavailable" } : { invite: { id: "i-2", email: body.email, role: body.role, expiresAt: body.expiresAt ?? 0, createdAt: 2, guest: true } }; },
    async link(b, body, key) { calls.push(["link", body, key]); return fail ? { error: "network" } : { link: { id: "lnk2", role: body.role, expiresAt: body.expiresAt, createdAt: 2 } }; } };
  let n = 0;
  const m = createShareModel({ share, access: null, board: "b-1", now: () => t, newKey: () => `key-${++n}-aaaaaaaa`, urls: { board: "b", link: id => id } });
  await m.load();
  m.set("email", "kim@partner.io"); m.set("inviteDays", 7); m.set("linkDays", 30);
  await m.invite(); t += 5 * 60_000; await m.invite();                      // the clock moved 5 minutes between the tries
  await m.makeLink(); t += 5 * 60_000; await m.makeLink();
  const [i1, i2, l1, l2] = calls;
  expect(i2[1]).toEqual(i1[1]); expect(i2[2]).toBe(i1[2]); expect(i1[1].expiresAt).toBe(NOW + 7 * DAY);
  expect(l2[1]).toEqual(l1[1]); expect(l2[2]).toBe(l1[2]); expect(l1[1].expiresAt).toBe(NOW + 5 * 60_000 + 30 * DAY);   // the first link try ran after the first 5 minutes
  m.set("inviteDays", 90); await m.invite();                                // a changed form: a new key and a body from the current clock
  expect(calls.at(-1)[2]).not.toBe(i1[2]); expect(calls.at(-1)[1].expiresAt).toBe(t + 90 * DAY);
  fail = false; await m.invite(); await m.makeLink();                       // success clears the frozen body
  t += 60_000; fail = true; await m.makeLink();
  expect(calls.at(-1)[1].expiresAt).toBe(t + 30 * DAY);
});

test("a role the caller may not give is refused before any request; the Unit-less caller gets no guest tag before sending; the server's default life is the form's default", async () => {
  const v = VIEW(); v.limits.inviteRoles = ["viewer"]; v.limits.linkRoles = []; v.unit = null; v.limits.inviteTtlMs = 7 * DAY;
  const calls = [];
  const share = { async view() { return { view: v }; }, async invite(...a) { calls.push(a); return { error: "unavailable" }; }, async link(...a) { calls.push(a); return {}; } };
  const m = createShareModel({ share, access: null, board: "b-1", now: () => NOW, urls: { board: "b", link: id => id } });
  await m.load();
  expect(m.state.form.inviteDays).toBe(7);                                  // limits.inviteTtlMs is used
  m.set("email", "kim@partner.io"); expect(m.guestOf()).toBe(null);
  m.set("role", "editor"); expect(await m.invite()).toBe(false); expect(m.state.notice).toContain("can't give that role");
  expect(await m.makeLink()).toBe(false);
  expect(calls).toEqual([]);
});

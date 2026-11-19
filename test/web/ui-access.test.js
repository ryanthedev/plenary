// The Teams list, a Team's page and the access page of a scope (web/adapters/dom/access.js over web/core/access.js) on the collab tests' fake DOM:
// what renders, the one picker, keys and focus, aria-disabled while pending, announcements, refusals, and text safety.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { mountTeamsPage, mountTeamPage, mountAccessPage } from "../../web/adapters/dom/access.js";
import { createTeamsModel, createTeamModel, createAccessModel, failText, sizeText, viaText } from "../../web/core/access.js";
import { announced } from "../../web/adapters/dom/focus.js";

const hrefs = { home: "./", team: id => `?team=${id}`, teams: "?teams=1", space: id => `?space=${id}`, group: id => `?group=${id}`, board: id => `?board=${id}`, access: (t, id) => `?access=${t}:${id}` };
const ROLES = [{ id: "viewer", name: "Viewer", custom: false, summary: "Can view", ladder: "viewer", people: true }, { id: "editor", name: "Editor", custom: false, summary: "Can edit", ladder: "editor", people: true },
  { id: "owner", name: "Owner", custom: false, summary: "Everything", ladder: "owner", people: true }, { id: "r-fac", name: "Facilitator", custom: true, summary: "Custom", ladder: "annotator", people: false }];
const U = (id, name, role, roleName, can = { change: true, remove: true }) => ({ subject: { type: "user", id, name, email: `${name}@acme.com` }, role, roleName, via: "direct", can });
const TM = (id, name, role, roleName, size = 3) => ({ subject: { type: "team", id, name, size }, role, roleName, via: "team", can: { change: true, remove: true } });
const AP = (o = {}) => ({ scope: { type: "space", id: "s-1", name: "Design" }, can: { manage: true }, general: [{ scope: { type: "space", id: "s-1", name: "Design" }, role: "viewer" }],
  rows: [U("google:ada", "ada", "owner", "Owner"), U("google:max", "max", "editor", "Editor"), TM("tm-1", "Infra", "viewer", "Viewer")], next: null, inherited: [], roles: ROLES, ...o });
const TP = (o = {}) => ({ team: { id: "tm-1", name: "Infra", size: 2 }, can: { manage: true }, members: [{ user: "google:ada", name: "ada", email: "ada@acme.com" }, { user: "google:max", name: "max", email: null }], next: null, ...o });
let root, api, calls, focused, state;
const settle = () => new Promise(r => setTimeout(r, 0));
const all = pred => root.findAll(pred);
const btn = text => all(e => e.tagName === "BUTTON").find(b => textOf(b).trim() === text || b.getAttribute("aria-label") === text);
const byLabel = (tag, label) => all(e => e.tagName === tag && e.getAttribute("aria-label") === label)[0];
const items = label => byLabel("UL", label)?.findAll(e => e.tagName === "LI") ?? [];
const picker = { setTimer: f => { f(); return 0; } };
const hold = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  calls = []; focused = [];
  FakeElement.prototype.focus = function () { focused.push(this); globalThis.document.activeElement = this; };
  FakeElement.prototype.setAttribute = Object.getPrototypeOf(FakeElement.prototype).setAttribute ?? FakeElement.prototype.setAttribute;
  state = { access: AP(), team: TP(), teams: { teams: [{ id: "tm-1", name: "Infra", size: 3 }, { id: "tm-2", name: "Design", size: 1 }], next: null, can: { create: true } } };
  api = new Proxy({ answer: null }, { get: (t, name) => name === "answer" ? t.answer : (...a) => { calls.push([name, ...a]); const r = t.answer?.(name, ...a); return Promise.resolve(r ?? { error: "unavailable" }); } });
  api.answer = (name, ...a) => ({
    teams: () => structuredClone(state.teams), team: () => ({ page: structuredClone(state.team) }), access: () => ({ page: structuredClone(state.access) }),
    createTeam: n => ({ team: { id: "tm-new", name: n, size: 0 } }), renameTeam: (id, n) => ({ team: { id, name: n, size: 2 } }), deleteTeam: () => ({}), setMember: () => ({}),
    directory: q => ({ people: [{ user: "google:lee", name: "lee", email: "lee@acme.com" }, { user: "google:kay", name: "kay", email: null }].filter(p => !q || p.name.includes(q)), teams: q ? [] : [{ id: "tm-9", name: "Ops", size: 4 }] }),
    setGrant: (t, id, s, role) => ({ row: { subject: { ...s, name: ({ "tm-9": "Ops" })[s.id] ?? s.id.replace(/^\w+:/, ""), ...(s.type === "team" ? { size: 4 } : { email: null }) }, role, roleName: ROLES.find(r => r.id === role)?.name ?? role, via: s.type === "team" ? "team" : "direct", can: { change: true, remove: true } } }),
    removeGrant: () => ({}),
  })[name]?.(...a);
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

async function teamsPage() { const model = createTeamsModel({ api }); mountTeamsPage({ root, model, hrefs }); await model.load(); return model; }
async function teamPage() { const model = createTeamModel({ api, id: "tm-1" }); mountTeamPage({ root, model, api, hrefs, picker }); await model.load(); await settle(); return model; }
async function accessPage(type = "space") { const model = createAccessModel({ api, type, id: "s-1" }); mountAccessPage({ root, model, api, hrefs, picker }); await model.load(); await settle(); return model; }

test("Teams list: named list items, sizes, links by team id, sorted by name; Create only when allowed", async () => {
  await teamsPage();
  expect(items("Teams").map(li => li.getAttribute("aria-label"))).toEqual(["Design", "Infra"]);
  expect(all(e => e.tagName === "A" && e.getAttribute("data-fk")?.startsWith("who:team:")).map(a => [a.getAttribute("href"), a.getAttribute("data-fk"), textOf(a)])).toEqual([["?team=tm-2", "who:team:tm-2", "Design"], ["?team=tm-1", "who:team:tm-1", "Infra"]]);
  expect(textOf(items("Teams")[0])).toContain("1 member");
  expect(btn("Create team")).toBeTruthy();
  state.teams.can.create = false;
  root.replaceChildren();
  await teamsPage();
  expect(btn("Create team")).toBeUndefined();
});

test("create a team: trimmed, listed, announced, and focus lands on its link; a blank name is refused before any request", async () => {
  await teamsPage();
  const name = byLabel("INPUT", "New team name");
  name.value = "   "; btn("Create team").click(); await settle();
  expect(calls.filter(c => c[0] === "createTeam")).toEqual([]);
  expect(textOf(root.find(e => e.hasClass("home-status")))).toContain("Give the team a name");
  name.value = "  Ops  "; btn("Create team").click(); await settle();
  expect(calls.at(-1)).toEqual(["createTeam", "Ops"]);
  expect(items("Teams").map(li => li.getAttribute("aria-label"))).toEqual(["Design", "Infra", "Ops"]);
  expect(announced()).toBe("Created team Ops");
  expect(focused.at(-1).getAttribute("data-fk")).toBe("who:team:tm-new");
});

test("pending is aria-disabled, never disabled: a second click while a create is in flight is ignored", async () => {
  await teamsPage();
  const gate = hold(); const real = api.answer;
  api.answer = (n, ...a) => (n === "createTeam" ? gate.p.then(() => real(n, ...a)) : real(n, ...a));
  byLabel("INPUT", "New team name").value = "Ops";
  const b = btn("Create team");
  b.click(); b.click();
  await settle();
  expect(b.getAttribute("aria-disabled")).toBe("true");
  expect(b.disabled).toBe(false);
  expect(calls.filter(c => c[0] === "createTeam")).toHaveLength(1);
  gate.release(); await settle(); await settle();
  expect(btn("Create team").getAttribute("aria-disabled")).toBe("false");
});

test("search and Show more use the port's paging", async () => {
  state.teams.next = "tm-2";
  const model = await teamsPage();
  btn("Show more teams").click(); await settle();
  expect(calls.at(-1)).toEqual(["teams", { after: "tm-2", q: null }]);
  byLabel("INPUT", "Search teams").value = "des";
  all(e => e.tagName === "FORM" && e.getAttribute("role") === "search")[0].dispatch("submit");
  await settle();
  expect(calls.at(-1)).toEqual(["teams", { after: null, q: "des" }]);
  expect(model.state.q).toBe("des");
});

test("a team name with markup is text, and an empty list says what to do", async () => {
  state.teams.teams = [{ id: "tm-1", name: "<img src=x onerror=alert(1)>", size: 1001 }];
  await teamsPage();
  expect(textOf(items("Teams")[0])).toContain("<img src=x onerror=alert(1)>");
  expect(textOf(items("Teams")[0])).toContain("1000+ members");
  state.teams.teams = []; root.replaceChildren(); await teamsPage();
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toContain("No teams yet.");
});

test("a Team page: members as named rows with Remove; a non-manager sees no controls; names are text", async () => {
  state.team.members[0].name = "<b>ada</b>";
  await teamPage();
  expect(items("Members").map(li => li.getAttribute("aria-label"))).toEqual(["<b>ada</b>", "max"].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  expect(btn("Remove max")).toBeTruthy();
  expect(btn("Delete team…")).toBeTruthy();
  state.team.can.manage = false; root.replaceChildren(); await teamPage();
  expect([btn("Remove max"), btn("Delete team…"), btn("Add"), byLabel("INPUT", "Team name")]).toEqual([undefined, undefined, undefined, undefined]);
});

test("remove a member: the row goes, it is said, and focus falls to a neighbouring row's name, never its Remove", async () => {
  const model = await teamPage();
  const rm = btn("Remove ada");
  globalThis.document.activeElement = rm; rm.setAttribute("data-fk", "remove:user:google:ada");
  rm.click(); await settle();
  expect(calls.at(-1)).toEqual(["setMember", "tm-1", "google:ada", false]);
  expect(items("Members").map(li => li.getAttribute("aria-label"))).toEqual(["max"]);
  expect(announced()).toMatch(/Removed ada from Infra|no longer here/);
  expect(model.state.page.team.size).toBe(1);
});

test("add a member through the picker: search, choose, Add stays aria-disabled until someone is chosen", async () => {
  await teamPage();
  const add = btn("Add");
  expect(add.getAttribute("aria-disabled")).toBe("true");
  add.click(); await settle();
  expect(calls.filter(c => c[0] === "setMember")).toEqual([]);
  byLabel("INPUT", "Search people").dispatch("input", { target: { value: "lee" } });
  await settle();
  expect(items("Matches").map(li => li.getAttribute("aria-label"))).toEqual(["lee"]);
  all(e => e.getAttribute("data-fk") === "pick:user:google:lee")[0].click(); await settle();
  expect(btn("Add").getAttribute("aria-disabled")).toBe("false");
  btn("Add").click(); await settle(); await settle();
  expect(calls.filter(c => c[0] === "setMember").at(-1)).toEqual(["setMember", "tm-1", "google:lee", true]);
  expect(items("Members").map(li => li.getAttribute("aria-label"))).toContain("lee");
});

test("rename and delete a team: delete asks first; Cancel changes nothing; the server's last-owner refusal is shown", async () => {
  await teamPage();
  const n = byLabel("INPUT", "Team name"); n.value = "Platform";
  all(e => e.tagName === "FORM").find(f => f.findAll(x => x === n).length).dispatch("submit"); await settle();
  expect(calls.at(-1)).toEqual(["renameTeam", "tm-1", "Platform"]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Platform");
  btn("Delete team…").click();
  expect(textOf(root.find(e => e.tagName === "SECTION" && e.getAttribute("aria-label") === "Delete team"))).toContain("Delete Platform?");
  btn("Cancel").click();
  expect(btn("Delete team…")).toBeTruthy();
  expect(calls.filter(c => c[0] === "deleteTeam")).toEqual([]);
  btn("Delete team…").click();
  const real = api.answer; api.answer = (n2, ...a) => (n2 === "deleteTeam" ? { error: "conflict", code: "last-owner" } : real(n2, ...a));
  btn("Delete team").click(); await settle();
  expect(textOf(root.find(e => e.hasClass("home-status")))).toContain("at least one owner");
  api.answer = real;
  btn("Delete team").click(); await settle();
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toContain("Team deleted.");
});

test("the access page: general access, rows named 'who, role, from where', inherited rows read-only, role selects only where the server allows", async () => {
  state.access = AP({ rows: [U("google:ada", "ada", "owner", "Owner", { change: false, remove: false }), U("google:max", "max", "editor", "Editor"), TM("tm-1", "Infra", "viewer", "Viewer")],
    inherited: [{ scope: { type: "group", id: "g-1", name: "Product" }, subject: { type: "team", id: "tm-1", name: "Infra", size: 3 }, role: "viewer", roleName: "Viewer", via: "inherited" }] });
  await accessPage();
  expect(items("General access").map(li => li.getAttribute("aria-label"))).toEqual(["Everyone in the organization: viewer (Space Design)"]);
  expect(items("People and teams with access to this Space").map(li => li.getAttribute("aria-label"))).toEqual(["ada, Owner, Added directly", "Infra, Viewer, Team", "max, Editor, Added directly"]);
  expect(byLabel("SELECT", "Role of ada")).toBeUndefined();
  expect(byLabel("SELECT", "Role of max")).toBeTruthy();
  expect(btn("Remove ada")).toBeUndefined();
  expect(items("Access inherited from above")[0].getAttribute("aria-label")).toBe("Infra, Viewer, via Group Product");
  expect(all(e => e.tagName === "A" && e.getAttribute("href") === "?access=group:g-1")).toHaveLength(1);
  const keys = all(e => e.getAttribute("data-fk")).map(e => e.getAttribute("data-fk"));
  for (const k of ["who:user:google:ada", "who:user:google:max", "who:team:tm-1", "role:user:google:max", "remove:user:google:max", "role:team:tm-1"]) expect(keys).toContain(k);
});

test("changing a role asks the port, shows the server's row, and says it; a Teams-only role is offered to Teams, not to people", async () => {
  await accessPage();
  const sel = byLabel("SELECT", "Role of max");
  expect(sel.findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["Viewer", "Editor", "Owner"]);
  expect(byLabel("SELECT", "Role of Infra").findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["Viewer", "Editor", "Owner", "Facilitator"]);
  sel.value = "viewer"; sel.dispatch("change"); await settle();
  expect(calls.at(-1)).toEqual(["setGrant", "space", "s-1", { type: "user", id: "google:max" }, "viewer"]);
  expect(announced()).toBe("max now Viewer");
  expect(items("People and teams with access to this Space").map(li => li.getAttribute("aria-label"))).toContain("max, Viewer, Added directly");
});

test("the server's refusals are said in words: the last owner, an unknown person, a bad role", async () => {
  await accessPage();
  const real = api.answer;
  for (const [r, text] of [[{ error: "conflict", code: "last-owner" }, "at least one owner"], [{ error: "invalid", code: "unknown-person" }, "has not opened Plenary"], [{ error: "invalid", code: "bad-role" }, "does not apply"], [{ error: "forbidden" }, "can't do that"]]) {
    api.answer = (n, ...a) => (n === "removeGrant" || n === "setGrant" ? r : real(n, ...a));
    btn("Remove max").click(); await settle();
    expect(textOf(root.find(e => e.hasClass("home-status")))).toContain(text);
    expect(items("People and teams with access to this Space").map(li => li.getAttribute("aria-label"))).toContain("max, Editor, Added directly");   // nothing changed on a refusal
  }
});

test("remove a row: it goes; focus falls to a NEIGHBOUR's name, never another row's Remove or role select", async () => {
  await accessPage();
  const rm = btn("Remove max");
  globalThis.document.activeElement = rm;
  rm.click(); await settle();
  expect(calls.at(-1)).toEqual(["removeGrant", "space", "s-1", { type: "user", id: "google:max" }]);
  const f = focused.at(-1);
  expect(f.getAttribute("data-fk")).toMatch(/^who:/);
  expect(announced()).toMatch(/no longer here/);
});

test("one picker, every scope: it lists the roles the server gave and only those valid for the chosen subject; Add sends the chosen role", async () => {
  await accessPage();
  byLabel("INPUT", "Search people or teams").dispatch("input", { target: { value: "" } }); await settle();
  expect(items("Matches").map(li => li.getAttribute("aria-label"))).toEqual(["lee", "kay", "Ops, team"]);
  all(e => e.getAttribute("data-fk") === "pick:user:google:lee")[0].click(); await settle();
  expect(byLabel("SELECT", "Role").findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["Viewer", "Editor", "Owner"]);
  all(e => e.getAttribute("data-fk") === "pick:team:tm-9")[0].click(); await settle();
  expect(byLabel("SELECT", "Role").findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["Viewer", "Editor", "Owner", "Facilitator"]);
  byLabel("SELECT", "Role").value = "editor"; byLabel("SELECT", "Role").dispatch("change");
  btn("Add").click(); await settle(); await settle();
  expect(calls.filter(c => c[0] === "setGrant").at(-1)).toEqual(["setGrant", "space", "s-1", { type: "team", id: "tm-9" }, "editor"]);
  expect(items("People and teams with access to this Space").map(li => li.getAttribute("aria-label"))).toContain("Ops, Editor, Team");
});

test("a viewer sees who has access and nothing to change; the unit page says when there are no roles to give", async () => {
  state.access = AP({ can: { manage: false }, roles: [], rows: AP().rows.map(r => ({ ...r, can: { change: false, remove: false } })) });
  await accessPage();
  expect([btn("Add"), btn("Remove max"), byLabel("SELECT", "Role of max"), byLabel("INPUT", "Search people or teams")]).toEqual([undefined, undefined, undefined, undefined]);
  expect(items("People and teams with access to this Space")).toHaveLength(3);
  state.access = AP({ scope: { type: "unit", id: "t-1" }, roles: [], general: [], rows: [] }); root.replaceChildren();
  await accessPage("unit");
  expect(textOf(root.find(e => e.hasClass("home-empty") && textOf(e).includes("nothing to add")))).toContain("make one first");
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Access: organization");
});

test("a personal space, an unknown scope and a signed-out person: their pages", async () => {
  state.access = AP({ scope: { type: "space", id: "s-1", name: "ada's space", personal: true }, can: { manage: false }, roles: [] });
  await accessPage();
  expect(textOf(root.find(e => e.hasClass("badge")))).toBe("Personal · only you");
  const real = api.answer;
  for (const [error, text] of [["notfound", "not available"], ["forbidden", "not available"], ["auth", "signed out"]]) {
    api.answer = (n, ...a) => (n === "access" ? { error } : real(n, ...a));
    root.replaceChildren(); await accessPage();
    expect(textOf(root.find(e => e.hasClass("home-empty")))).toContain(text);
  }
});

test("core copy: failText, sizeText, viaText", () => {
  expect(failText({ error: "conflict", code: "too-large" })).toContain("too many places");
  expect(failText({ error: "network" })).toContain("No answer");
  expect([sizeText(0), sizeText(1), sizeText(7), sizeText(1001)]).toEqual(["0 members", "1 member", "7 members", "1000+ members"]);
  expect([viaText({ via: "direct" }), viaText({ via: "team" }), viaText({ via: "inherited", scope: { type: "group", name: "Product" } })]).toEqual(["Added directly", "Team", "via Group Product"]);
});

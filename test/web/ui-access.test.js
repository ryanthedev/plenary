// The Teams list, a Team's page and the access page of a scope (web/adapters/dom/access.js over web/core/access.js) on the collab tests' fake DOM:
// what renders, the one picker, keys and focus, aria-disabled while pending, announcements, refusals, and text safety.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { mountTeamsPage, mountTeamPage, mountAccessPage } from "../../web/adapters/dom/access.js";
import { createTeamsModel, createTeamModel, createAccessModel, failText, sizeText, viaText } from "../../web/core/access.js";
import { askView } from "../../web/adapters/dom/explain.js";
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
/** Every person and Team row of the access page: the lists are grouped by source (directly, through teams), so this joins them, in the page's name order. */
const rowsAll = () => [...items("People added directly to this Space"), ...items("Teams with access to this Space")].map(li => li.getAttribute("aria-label")).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
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
    ask: (ty, id, role) => ({ request: { role, roleName: "Editor", at: 5, state: "pending" } }), dismissRequest: () => ({}),
  })[name]?.(...a);
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

async function teamsPage() { const model = createTeamsModel({ api }); mountTeamsPage({ root, model, hrefs }); await model.load(); return model; }
async function teamPage() { const model = createTeamModel({ api, id: "tm-1" }); mountTeamPage({ root, model, api, hrefs, picker }); await model.load(); await settle(); return model; }
async function accessPage(type = "space") { const model = createAccessModel({ api, type, id: "s-1" }); mountAccessPage({ root, model, api, hrefs, picker, newKey: () => "key-fixed-0001" }); await model.load(); await settle(); return model; }

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
  expect(rowsAll()).toEqual(["ada, Owner, Added directly", "Infra, Viewer, Team", "max, Editor, Added directly"]);
  expect(byLabel("SELECT", "Role of ada")).toBeUndefined();
  expect(byLabel("SELECT", "Role of max")).toBeTruthy();
  expect(btn("Remove ada")).toBeUndefined();
  expect(items("Access inherited from Group Product")[0].getAttribute("aria-label")).toBe("Infra, Viewer, via Group Product");
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
  expect(rowsAll()).toContain("max, Viewer, Added directly");
});

test("the server's refusals are said in words: the last owner, an unknown person, a bad role", async () => {
  await accessPage();
  const real = api.answer;
  for (const [r, text] of [[{ error: "conflict", code: "last-owner" }, "at least one owner"], [{ error: "invalid", code: "unknown-person" }, "has not signed in"], [{ error: "invalid", code: "bad-role" }, "does not apply"], [{ error: "forbidden" }, "can't do that"]]) {
    api.answer = (n, ...a) => (n === "removeGrant" || n === "setGrant" ? r : real(n, ...a));
    btn("Remove max").click(); await settle();
    expect(textOf(root.find(e => e.hasClass("home-status")))).toContain(text);
    expect(rowsAll()).toContain("max, Editor, Added directly");   // nothing changed on a refusal
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
  expect(rowsAll()).toContain("Ops, Editor, Team");
});

test("a viewer sees who has access and nothing to change; the unit page says when there are no roles to give", async () => {
  state.access = AP({ can: { manage: false }, roles: [], rows: AP().rows.map(r => ({ ...r, can: { change: false, remove: false } })) });
  await accessPage();
  expect([btn("Add"), btn("Remove max"), byLabel("SELECT", "Role of max"), byLabel("INPUT", "Search people or teams")]).toEqual([undefined, undefined, undefined, undefined]);
  expect(rowsAll()).toHaveLength(3);
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

test("pressing a match in the picker keeps focus on it (the list is rebuilt around it), on the Access page and the Team page", async () => {
  for (const mount of [accessPage, teamPage]) {
    root.replaceChildren(); focused.length = 0;
    await mount();
    const input = all(e => e.tagName === "INPUT" && /^Search/.test(e.getAttribute("aria-label") ?? ""))[0];
    input.dispatch("input", { target: { value: "" } }); await settle();
    const pick = all(e => e.getAttribute("data-fk") === "pick:user:google:lee")[0];
    pick.focus();
    pick.dispatch("click"); await settle();
    const now = globalThis.document.activeElement;
    expect(now.getAttribute("data-fk")).toBe("pick:user:google:lee");
    expect(now).not.toBe(pick);                                          // the list was rebuilt, and focus came back to the rebuilt button
    expect(now.getAttribute("aria-pressed")).toBe("true");
  }
});

test("after a Team is deleted, focus goes to the way out, not to nothing", async () => {
  await teamPage();
  btn("Delete team…").click();
  btn("Delete team").click(); await settle();
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toContain("Team deleted.");
  const f = focused.at(-1);
  expect([f.tagName, f.getAttribute("href")]).toEqual(["A", "?teams=1"]);
});

test("while a change is in flight every row control is aria-disabled (and works again after)", async () => {
  await accessPage();
  const gate = hold(); const real = api.answer;
  api.answer = (n, ...a) => (n === "removeGrant" ? gate.p.then(() => real(n, ...a)) : real(n, ...a));
  btn("Remove max").click(); await settle();
  expect([btn("Remove max"), btn("Remove Infra"), byLabel("SELECT", "Role of max"), byLabel("SELECT", "Role of Infra")].map(e => e.getAttribute("aria-disabled"))).toEqual(["true", "true", "true", "true"]);
  expect(btn("Remove Infra").disabled).toBe(false);
  btn("Remove Infra").click(); await settle();
  expect(calls.filter(c => c[0] === "removeGrant")).toHaveLength(1);       // a second click while pending does nothing
  gate.release(); await settle(); await settle();
  expect(btn("Remove Infra").getAttribute("aria-disabled")).not.toBe("true");
  // the same on a Team page
  root.replaceChildren(); await teamPage();
  const g2 = hold(); const r2 = api.answer;
  api.answer = (n, ...a) => (n === "setMember" ? g2.p.then(() => r2(n, ...a)) : r2(n, ...a));
  btn("Remove ada").click(); await settle();
  expect(btn("Remove max").getAttribute("aria-disabled")).toBe("true");
  g2.release(); await settle(); await settle();
});

test("the confirmation and the focus fallback are said together, not one over the other", async () => {
  await accessPage();
  const rm = btn("Remove max");
  globalThis.document.activeElement = rm; rm.setAttribute("data-fk", "remove:user:google:max");
  rm.click(); await settle(); await settle();
  expect(announced()).toMatch(/^Removed max\. That person or team is no longer here; moved to the (next|previous) one\.$/);
  // no fallback (focus was elsewhere): just the confirmation
  globalThis.document.activeElement = null;
  btn("Remove Infra").click(); await settle(); await settle();
  expect(announced()).toBe("Removed Infra");
});

// ---- #51: your access, who has access grouped by source, requests ----
const SRC = (o = {}) => ({ kind: "team", scope: { type: "space", id: "s-1", name: "Design" }, role: "viewer", roleName: "Viewer", ladder: "viewer", strongest: false, team: { id: "tm-1", name: "Infra" }, ...o });
const WHY = (o = {}) => ({ mine: { role: { id: "commenter", name: "Commenter" }, sources: [SRC(), SRC({ kind: "general", scope: { type: "group", id: "g-1", name: "Product" }, role: "commenter", roleName: "Commenter", ladder: "commenter", strongest: true, team: undefined })] },
  needs: { "board.create": { role: "editor", roleName: "Editor" } }, owners: [{ type: "user", id: "google:ada", name: "ada" }], ask: { can: true, roles: [{ id: "annotator", name: "Annotator" }, { id: "editor", name: "Editor" }], pending: null, retryAfterMs: null }, ...o });
const VIEWER = (o = {}) => AP({ can: { manage: false }, roles: [], rows: [U("google:ada", "ada", "owner", "Owner", { change: false, remove: false }), TM("tm-1", "Infra", "viewer", "Viewer")], why: WHY(), ...o });

test("Your access lists every source and marks the strongest; Who has access is grouped by where it comes from", async () => {
  state.access = VIEWER({ inherited: [{ scope: { type: "group", id: "g-1", name: "Product" }, subject: { type: "team", id: "tm-2", name: "Design", size: 4 }, role: "viewer", roleName: "Viewer", via: "inherited" },
      { scope: { type: "unit", id: "t-1" }, subject: { type: "user", id: "google:eve", name: "eve", email: null }, role: "r-read", roleName: "Reader", via: "inherited" }],
    general: [{ scope: { type: "unit", id: "t-1" }, role: "viewer" }], organization: { admins: [{ user: "google:root", name: "root" }], more: false, memberRole: "viewer" } });
  await accessPage();
  const mine = items("Where your access comes from");
  expect(mine.map(li => li.getAttribute("aria-label"))).toEqual(["Viewer · via the Infra team", "Commenter · via everyone in the organization on Group Product, grants the most"]);
  expect(textOf(mine[1])).toContain("Grants the most");
  expect(textOf(mine[0])).not.toContain("Grants the most");
  expect(items("People added directly to this Space").map(li => li.getAttribute("aria-label"))).toEqual(["ada, Owner, Added directly"]);
  expect(items("Teams with access to this Space").map(li => li.getAttribute("aria-label"))).toEqual(["Infra, Viewer, Team"]);
  expect(items("Access inherited from Group Product").map(li => li.getAttribute("aria-label"))).toEqual(["Design, Viewer, via Group Product"]);
  expect(items("Access inherited from your organization").map(li => li.getAttribute("aria-label"))).toEqual(["eve, Reader, via organization"]);
  expect(items("General access").map(li => li.getAttribute("aria-label"))).toEqual(["Everyone in the organization: viewer (organization)"]);
  expect(items("Organization admins").map(li => li.getAttribute("aria-label"))).toEqual(["root"]);
  expect(btn("Remove ada")).toBeUndefined();
});

test("Ask for access on the Access page: a real button, the role the server offers, one key, focus to the confirmation, said aloud", async () => {
  state.access = VIEWER();
  await accessPage();
  const ask = btn("Ask for access");
  expect(ask.disabled).toBe(false);
  expect(textOf(root.find(e => e.tagName === "SELECT" && e.getAttribute("aria-label") === "Role to ask for"))).toContain("Editor");
  ask.click(); await settle();
  expect(calls.filter(c => c[0] === "ask")).toEqual([["ask", "space", "s-1", "editor", "key-fixed-0001"]]);
  const status = root.find(e => e.getAttribute("data-fk") === "ask-status");
  expect(textOf(status)).toContain("You asked for Editor");
  expect(globalThis.document.activeElement).toBe(status);
  expect(announced()).toContain("Request sent");
  expect(ask.hidden).toBe(true);
});

test("a refused ask (rate limited) is said in words and the button stays, off", async () => {
  state.access = VIEWER();
  await accessPage();
  const real = api.answer; api.answer = (n, ...a) => (n === "ask" ? { error: "limited", retryAfter: 3600 } : real(n, ...a));
  btn("Ask for access").click(); await settle();
  expect(textOf(root.find(e => e.getAttribute("data-fk") === "ask-status"))).toBe("You've asked too many times. Try again in about an hour.");
  expect(announced()).toContain("too many times");
  expect(btn("Ask for access").getAttribute("aria-disabled")).toBe("true");   // off (still in the tab order) until the wait is over
});

test("a pending request shows as sent, with no button to press again; an owner sees no Ask for themselves", async () => {
  state.access = VIEWER({ why: WHY({ ask: { can: true, roles: [{ id: "editor", name: "Editor" }], pending: { role: "editor", roleName: "Editor", at: 1 }, retryAfterMs: null } }) });
  await accessPage();
  expect(btn("Ask for access").hidden).toBe(true);
  expect(textOf(root.find(e => e.getAttribute("data-fk") === "ask-status"))).toContain("You asked for Editor");
  root.replaceChildren();
  state.access = AP({ why: WHY({ ask: { can: false, roles: [], pending: null, retryAfterMs: null } }) });
  await accessPage();
  expect(btn("Ask for access")).toBeUndefined();
});

test("owners see the requests: named, with Dismiss (focus falls back to a neighbour), and granting the person removes theirs", async () => {
  state.access = AP({ why: WHY(), requests: [{ user: { id: "google:dev", name: "dev", email: "dev@acme.com" }, role: "editor", roleName: "Editor", at: 1 }, { user: { id: "google:kim", name: "kim", email: null }, role: "annotator", roleName: "Annotator", at: 2 }] });
  await accessPage();
  expect(items("Access requests").map(li => li.getAttribute("aria-label"))).toEqual(["dev asked for Editor", "kim asked for Annotator"]);
  btn("Dismiss the request of dev").click(); await settle();
  expect(calls.filter(c => c[0] === "dismissRequest")).toEqual([["dismissRequest", "space", "s-1", "google:dev"]]);
  expect(items("Access requests").map(li => li.getAttribute("aria-label"))).toEqual(["kim asked for Annotator"]);
  expect(announced()).toContain("Dismissed the request of dev");
  // granting through the picker closes the person's request (the server does it too)
  const model = createAccessModel({ api, type: "space", id: "s-1" });
  await model.load();
  await model.set({ type: "user", id: "google:kim", name: "kim" }, "annotator");
  expect(model.state.page.requests.map(r => r.user.id)).toEqual(["google:dev"]);
});

test("a closed request in its cooldown starts with the button off and says when the owner may be asked again", async () => {
  state.access = VIEWER({ why: WHY({ ask: { can: true, roles: [{ id: "editor", name: "Editor" }], pending: null, retryAfterMs: 3 * 3600_000 } }) });
  await accessPage();
  expect(btn("Ask for access").getAttribute("aria-disabled")).toBe("true");
  expect(textOf(root.find(e => e.getAttribute("data-fk") === "ask-status"))).toBe("You asked recently and the request was closed. You can ask again in 3 hours.");
});

test("after a 429 the Ask button comes back by itself when the wait the server named has elapsed (no reload)", async () => {
  const timers = [];
  const api = { ask: async () => ({ error: "limited", retryAfter: 90 }) };
  const why = { mine: { role: { id: "viewer", name: "Viewer" }, sources: [] }, guest: false, needs: {}, owners: [], ask: { can: true, roles: [{ id: "editor", name: "Editor" }], pending: null, retryAfterMs: null } };
  const v = askView({ api, type: "space", id: "s-1", why, setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimer: n => { timers[n - 1].cleared = true; } });
  const button = v.el.findAll(e => e.tagName === "BUTTON")[0];
  button.click(); await settle();
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(timers.filter(x => !x.cleared).map(x => x.ms)).toEqual([90_000]);
  timers.at(-1).f();                                              // the wait elapses
  expect(button.getAttribute("aria-disabled")).toBe("false");
  expect(textOf(v.el.findAll(e => e.getAttribute("data-fk") === "ask-status")[0])).toBe("");
});

test("the 409 superseded path says so in the status line too (not only the live region), keeps focus on it, and shows the current request", async () => {
  const why = { mine: { role: { id: "viewer", name: "Viewer" }, sources: [] }, guest: false, needs: {}, owners: [], ask: { can: true, roles: [{ id: "editor", name: "Editor" }], pending: null, retryAfterMs: null } };
  const cur = { ...why, ask: { ...why.ask, pending: { role: "editor", roleName: "Editor", at: 5 } } };
  const v = askView({ api: { ask: async () => ({ error: "conflict", code: "superseded" }) }, type: "space", id: "s-1", why, reload: async () => cur });
  const button = v.el.findAll(e => e.tagName === "BUTTON")[0];
  button.focus(); button.click(); await settle();
  const status = v.el.findAll(e => e.getAttribute("data-fk") === "ask-status")[0];
  expect(textOf(status)).toMatch(/^Your earlier request was replaced by a newer one\. This is the one the owners see\. You asked for Editor\./);
  expect(globalThis.document.activeElement).toBe(status);
  expect(announced()).toContain("replaced by a newer one");
});

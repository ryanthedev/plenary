// The Share dialog (web/adapters/dom/share.js over web/core/share.js) on the collab tests' fake DOM: a real modal (roles, focus in, Tab trap, Escape, focus back), labelled
// controls, the guest tag as text tied to the email field, outcomes in the status line and the live region, revoke, copy, refusals and text safety.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { openShare } from "../../web/adapters/dom/share.js";
import { createShareModel } from "../../web/core/share.js";
import { announced } from "../../web/adapters/dom/focus.js";

const DAY = 86_400_000, NOW = 5_000_000;
const VIEW = () => ({ board: { id: "b-1", title: "Roadmap <b>x</b>" }, unit: { domains: ["acme.com"] }, limits: { inviteRoles: ["viewer", "commenter", "annotator", "editor"], linkRoles: ["viewer", "annotator", "editor"], inviteTtlMs: 30 * DAY },
  invites: [{ id: "i-1", email: "kim@partner.io", role: "viewer", expiresAt: NOW + 30 * DAY, createdAt: 1, guest: true }], links: [{ id: "lnk1", role: "annotator", expiresAt: NOW + 7 * DAY, createdAt: 1 }], more: false });
const PAGE = { scope: { type: "board", id: "b-1" }, can: { manage: true }, general: [{ scope: { type: "space", id: "s-1", name: "Design" }, role: "viewer" }], rows: [{ subject: { type: "user", id: "u1", name: "Ada" }, role: "owner", roleName: "Owner", via: "direct" }],
  next: null, inherited: [{ scope: { type: "group", id: "g-1", name: "Product" }, subject: { type: "team", id: "tm-2", name: "Design team" }, role: "editor", roleName: "Editor", via: "inherited" }], roles: [] };
let root, calls, focused, state, opener, copied;
const settle = () => new Promise(r => setTimeout(r, 0));
const all = pred => root.findAll(pred);
const btn = text => all(e => e.tagName === "BUTTON").find(b => textOf(b).trim() === text || b.getAttribute("aria-label") === text);
const byLabel = (tag, label) => all(e => e.tagName === tag && e.getAttribute("aria-label") === label)[0];
const items = label => byLabel("UL", label)?.findAll(e => e.tagName === "LI") ?? [];
const type = (el, v) => { el.value = v; el.dispatch("input", { target: el }); };

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  calls = []; focused = []; copied = [];
  FakeElement.prototype.focus = function () { focused.push(this); globalThis.document.activeElement = this; };
  opener = { focus: () => focused.push("opener") };
  state = { view: { view: VIEW() }, access: { page: PAGE }, invite: null };
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

async function open(over = {}) {
  const share = { view: async () => state.view, invite: async (b, body, key) => { calls.push(["invite", body, key]); return state.invite ?? { invite: { id: "i-9", email: body.email, role: body.role, expiresAt: NOW + 30 * DAY, createdAt: 2, guest: !body.email.endsWith("@acme.com") } }; },
    link: async (b, body) => { calls.push(["link", body]); return { link: { id: "lnk9", role: body.role, expiresAt: body.expiresAt, createdAt: 2 } }; },
    revokeInvite: async (b, id) => { calls.push(["revokeInvite", id]); return {}; }, revokeLink: async (b, id) => { calls.push(["revokeLink", id]); return {}; } };
  const access = { access: async () => state.access };
  const model = createShareModel({ share, access, board: "b-1", now: () => NOW, newKey: () => "key-fixed-0001", urls: { board: "https://p/?board=b-1", link: id => `https://p/links/${id}` } });
  const d = openShare({ host: root, model, opener, accessHref: "?access=board:b-1", copy: async t => { copied.push(t); return over.copyOk ?? true; }, now: () => NOW });
  await settle(); await settle();
  return { d, model };
}

test("a real modal: role, aria-modal, labelled by its heading; focus moves in; Escape closes and focus returns to the opener", async () => {
  const { d } = await open();
  const dlg = all(e => e.getAttribute("role") === "dialog")[0];
  expect(dlg.getAttribute("aria-modal")).toBe("true");
  expect(textOf(all(e => e.getAttribute("id") === dlg.getAttribute("aria-labelledby"))[0])).toBe("Share this board");
  expect(focused.length).toBeGreaterThan(0);
  d.el.dispatch("keydown", { key: "Escape" });
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]);
  expect(focused.at(-1)).toBe("opener");
});

test("Tab and Shift+Tab stay inside the dialog", async () => {
  const { d } = await open();
  const inside = all(e => /^(BUTTON|INPUT|SELECT|A)$/.test(e.tagName) && !e.disabled && !e.hidden);
  const last = inside.at(-1), first = inside[0];
  globalThis.document.activeElement = last; focused.length = 0;
  d.el.dispatch("keydown", { key: "Tab", shiftKey: false }); expect(focused.at(-1)).toBe(first);
  globalThis.document.activeElement = first;
  d.el.dispatch("keydown", { key: "Tab", shiftKey: true }); expect(focused.at(-1)).toBe(last);
});

test("every control is labelled; board title, emails and names go in as text only", async () => {
  await open();
  for (const lab of ["Email address", "Role for the invite", "Invite expires", "Role for the link", "Link expires"]) expect(all(e => e.getAttribute("aria-label") === lab).length).toBe(1);
  expect(textOf(root)).toContain("Roadmap <b>x</b>");
  expect(all(e => e.tagName === "B")).toEqual([]);
  expect(all(e => /^(INPUT|SELECT|BUTTON)$/.test(e.tagName)).filter(e => !e.getAttribute("aria-label") && !textOf(e).trim())).toEqual([]);
});

test("DW-52.1 typing an outside address shows the Guest tag as text tied to the field; an inside one says so; Invite sends role and the server's default expiry, announces, and shows the board address to copy", async () => {
  await open();
  const email = byLabel("INPUT", "Email address"), tag = all(e => e.getAttribute("id") === email.getAttribute("aria-describedby"))[0];
  type(email, "kim2@partner.io"); expect(textOf(tag)).toContain("Guest · outside your organization"); expect(textOf(tag)).toContain("up to Editor");
  type(email, "ann@acme.com"); expect(textOf(tag)).toBe("In your organization.");
  type(email, "kim2@partner.io");
  const sel = byLabel("SELECT", "Role for the invite"); sel.value = "annotator"; sel.dispatch("change", { target: sel });
  btn("Invite").dispatch("click"); // submit button inside the form
  all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "invite")).toEqual([["invite", { email: "kim2@partner.io", role: "annotator" }, "key-fixed-0001"]]);
  expect(announced()).toContain("Invite created for kim2@partner.io, a guest");
  expect(textOf(byLabel("UL", "Invites"))).toContain("kim2@partner.io");
  expect(textOf(all(e => e.getAttribute("data-fk") === "share-status")[0])).toContain("Invite created");
  expect(focused.at(-1).getAttribute("data-fk")).toBe("share-status");               // focus goes to the outcome, not to a control that may be gone
  expect(byLabel("INPUT", "Board address").value).toBe("https://p/?board=b-1");
  expect(textOf(root)).toContain("Nothing is emailed");
  btn("Copy board").dispatch("click"); await settle();
  expect(copied).toEqual(["https://p/?board=b-1"]); expect(announced()).toBe("Board address copied.");
});

test("a failed copy selects the address and says so", async () => {
  await open({ copyOk: false });
  await (async () => { type(byLabel("INPUT", "Email address"), "k@p.io"); all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle(); })();
  let selected = false; byLabel("INPUT", "Board address").select = () => { selected = true; };
  btn("Copy board").dispatch("click"); await settle();
  expect(selected).toBe(true); expect(announced()).toContain("Could not copy");
});

test("an invalid address is refused with a sentence and focus stays on the field", async () => {
  await open();
  type(byLabel("INPUT", "Email address"), "nobody"); all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(calls).toEqual([]); expect(announced()).toContain("full email address"); expect(focused.at(-1)).toBe(byLabel("INPUT", "Email address"));
});

test("DW-52.2 link access: role and expiry, then the link is listed with its address and a Copy; the list names role and expiry", async () => {
  await open();
  const r = byLabel("SELECT", "Role for the link"); r.value = "editor"; r.dispatch("change", { target: r });
  const x = byLabel("SELECT", "Link expires"); x.value = "30"; x.dispatch("change", { target: x });
  btn("Create link").dispatch("click"); await settle();
  expect(calls.at(-1)).toEqual(["link", { role: "editor", expiresAt: NOW + 30 * DAY }]);
  expect(announced()).toContain("Link created");
  const lis = items("Share links");
  expect(lis.map(li => li.getAttribute("aria-label"))).toEqual(["Editor link", "Annotator link"]);
  expect(textOf(lis[1])).toContain("expires in 7 days");
  expect(all(e => e.getAttribute("aria-label") === "Link address").map(i => i.value)).toEqual(["https://p/links/lnk9", "https://p/links/lnk1"]);
});

test("DW-52.3 inherited rows are read-only text with where they come from, and point to the Access page; no control edits them", async () => {
  await open();
  const rows = items("Who else has access").map(li => li.getAttribute("aria-label"));
  expect(rows).toEqual(["Design team, Editor, via Area Product", "Everyone in the organization, Viewer, via Space Design"]);
  expect(items("People added to this board").map(li => li.getAttribute("aria-label"))).toEqual(["Ada, Owner, Added directly"]);
  for (const li of [...items("Who else has access"), ...items("People added to this board")]) expect(li.findAll(e => /^(BUTTON|INPUT|SELECT)$/.test(e.tagName))).toEqual([]);
  expect(all(e => e.tagName === "A").map(a => a.getAttribute("href"))).toEqual(["?access=board:b-1"]);
});

test("a guest manager (no Access page) still gets invites and links, and the dialog says why the rest is missing", async () => {
  state.access = { error: "notfound" };
  await open();
  expect(items("Who else has access")).toEqual([]); expect(textOf(root)).toContain("not available to you, because you are outside this organization");
  expect(items("Invites")).toHaveLength(1);
});

test("DW-52.5 Revoke: each button names its target; revoking removes the row, says access ends within about a minute, and moves focus to the status line", async () => {
  await open();
  btn("Revoke invite for kim@partner.io").dispatch("click"); await settle();
  expect(calls.at(-1)).toEqual(["revokeInvite", "i-1"]);
  expect(announced()).toBe("Invite for kim@partner.io revoked. Their access ends within about a minute.");
  expect(textOf(byLabel("UL", "Invites"))).toContain("No pending invites");
  expect(focused.at(-1).getAttribute("data-fk")).toBe("share-status");
  expect(btn("Revoke Annotator link, expires in 7 days")).toBeTruthy();
  btn("Revoke Annotator link, expires in 7 days").dispatch("click"); await settle();
  expect(calls.at(-1)).toEqual(["revokeLink", "lnk1"]); expect(textOf(byLabel("UL", "Share links"))).toContain("No share links");
});

test("a person without permission sees the refusal and no lists, names or controls", async () => {
  state.view = { error: "forbidden" };
  await open();
  expect(textOf(root)).toContain("Only people who manage who has access to this board can share it");
  expect(all(e => e.tagName === "UL").filter(ul => ul.childNodes.length)).toEqual([]);   // nothing was ever listed
  expect(all(e => /^(INPUT|SELECT)$/.test(e.tagName))).toEqual([]);                    // the form never joined the dialog
  expect(announced()).toContain("Only people who manage");
});

test("Done closes and returns focus", async () => {
  await open();
  btn("Done").dispatch("click");
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]); expect(focused.at(-1)).toBe("opener");
});

test("focus is inside the dialog from the first moment (Done while loading) and lands on the Email field once it is ready", async () => {
  let release; const gate = new Promise(r => { release = r; });
  const share = { view: async () => { await gate; return state.view; }, invite: async () => ({}), link: async () => ({}), revokeInvite: async () => ({}), revokeLink: async () => ({}) };
  const model = createShareModel({ share, access: { access: async () => state.access }, board: "b-1", now: () => NOW, urls: { board: "x", link: id => id } });
  openShare({ host: root, model, opener, now: () => NOW });
  expect(focused.at(-1).tagName).toBe("BUTTON"); expect(textOf(focused.at(-1))).toBe("Done");
  expect(all(e => e.tagName === "INPUT")).toEqual([]);                          // nothing unreachable to Tab into while loading
  release(); await settle(); await settle();
  expect(focused.at(-1).getAttribute("aria-label")).toBe("Email address");
});

test("one announcement: the status line is not itself a live region (the page's one live region says it once)", async () => {
  await open();
  const line = all(e => e.getAttribute("data-fk") === "share-status")[0];
  expect(line.getAttribute("role")).toBeNull(); expect(line.getAttribute("aria-live")).toBeNull(); expect(line.getAttribute("tabindex")).toBe("-1");
  expect(all(e => e.getAttribute("role") === "status" || e.getAttribute("aria-live")).filter(e => root.contains(e))).toEqual([]);
});

test("a manager whose role gives no board content (nothing to give) sees why and cannot send", async () => {
  state.view = { view: { ...VIEW(), limits: { inviteRoles: [], linkRoles: [], inviteTtlMs: 30 * DAY } } };
  await open();
  expect(textOf(root)).toContain("gives no board access of its own");
  type(byLabel("INPUT", "Email address"), "k@p.io"); all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(calls).toEqual([]); expect(announced()).toContain("can't give that role");
});

test("DW-52.10 the dialog says once that some access comes from places the person can't open, when the server says so, and not otherwise", async () => {
  state.access = { page: { ...PAGE, hiddenAbove: true } };
  await open();
  expect(textOf(root).split("Some access comes from places you can't open.").length - 1).toBe(1);
});

test("no hiddenAbove, no line", async () => {
  await open();
  expect(textOf(root)).not.toContain("places you can't open");
});

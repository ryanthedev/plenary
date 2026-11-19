// web/core/explain.js: the checker for what the server explains, the sentences, and the Ask for access model (#51).
import { test, expect } from "bun:test";
import { normalizeExplain, normalizeRequest, sourceText, pillLine, whyLines, ownersText, waitText, createAskModel, withArticle } from "../../../web/core/explain.js";

const SRC = (o = {}) => ({ kind: "team", scope: { type: "space", id: "s-1", name: "Platform" }, role: "viewer", roleName: "Viewer", ladder: "viewer", strongest: true, team: { id: "tm-1", name: "Infra" }, ...o });
const WHY = (o = {}) => ({ mine: { role: { id: "viewer", name: "Viewer" }, sources: [SRC(), SRC({ kind: "general", scope: { type: "group", id: "g-1", name: "Engineering" }, strongest: false, team: undefined })] },
  guest: false, needs: { "board.create": { role: "editor", roleName: "Editor", held: false } }, owners: [{ type: "user", id: "google:pri", name: "Priya" }, { type: "user", id: "google:tom", name: "Tom" }],
  ask: { can: true, roles: [{ id: "annotator", name: "Annotator" }, { id: "editor", name: "Editor" }], pending: null, retryAfterMs: null }, ...o });
const here = { type: "space", id: "s-1" };

test("normalizeExplain keeps a good answer, drops bad sources and owners, caps lists, and refuses a wrong shape", () => {
  expect(normalizeExplain(WHY())).toEqual(WHY());
  const bad = normalizeExplain({ ...WHY(), mine: { role: null, sources: [SRC(), { kind: "robot", scope: { type: "space", id: "s-1" }, role: "x" }, null, SRC({ scope: { type: "space", id: "bad id" } })] }, owners: [{ type: "user", id: "u", name: "n".repeat(500) }, { type: "bot", id: "x" }] });
  expect(bad.mine.sources).toHaveLength(1);
  expect(bad.mine.role).toBeNull();
  expect(bad.owners).toEqual([{ type: "user", id: "u", name: "n".repeat(200) }]);
  expect(normalizeExplain(null)).toBeNull();
  expect(normalizeExplain({ mine: {} })).toBeNull();
  expect(normalizeExplain({ mine: { sources: [] } }).ask).toEqual({ can: false, roles: [], pending: null, retryAfterMs: null });
  expect(normalizeRequest({ user: { id: "google:a", name: "a" }, role: "editor", roleName: "Editor", at: 5 })).toEqual({ user: { id: "google:a", name: "a", email: null }, role: "editor", roleName: "Editor", at: 5 });
  expect(normalizeRequest({ user: {}, role: "editor", at: 5 })).toBeNull();
});

test("the sentences: a source set on the page's own scope needs no 'on ...', one above it names where", () => {
  expect(sourceText(SRC(), here)).toBe("via the Infra team");
  expect(sourceText(SRC({ scope: { type: "group", id: "g-1", name: "Eng" } }), here)).toBe("via the Infra team on Group Eng");
  expect(sourceText(SRC({ kind: "general", scope: { type: "group", id: "g-1", name: "Eng" } }), here)).toBe("via everyone in the organization on Group Eng");
  expect(sourceText(SRC({ kind: "general", scope: { type: "unit", id: "t-1" } }), here)).toBe("via everyone in the organization");
  expect(sourceText(SRC({ kind: "direct" }), here)).toBe("added directly");
  expect(sourceText(SRC({ kind: "direct", scope: { type: "unit", id: "t-1" } }), here)).toBe("added directly on your organization");
  expect(sourceText(SRC({ kind: "unit", role: "admin" }), here)).toBe("as an organization admin");
  expect(sourceText(SRC({ kind: "invite" }), here)).toBe("through an invite");
  expect(sourceText(SRC({ kind: "link" }), here)).toBe("through a share link");
});

test("JOURNEY J10 copy: the why lines and the pill line", () => {
  expect(whyLines(WHY(), here, "Creating boards", "board.create", "Platform")).toEqual([
    "You're a Viewer in Platform, via the Infra team.", "Creating boards needs Editor.", "Owners: Priya, Tom."]);
  expect(whyLines(WHY({ mine: { role: { id: "editor", name: "Editor" }, sources: [] }, needs: {}, owners: [] }), here, "Creating boards", "board.create")).toEqual(["You're an Editor here.", "Ask an organization admin."]);
  expect(whyLines(WHY({ mine: { role: null, sources: [] } }), here, "Creating boards", "board.create")[0]).toBe("You have no board access of your own here.");
  expect(pillLine(WHY().mine)).toBe("Viewer via Space Platform · Infra team");
  expect(pillLine({ role: null, sources: [] })).toBe("No board access of your own");
  expect(pillLine({ role: { id: "viewer", name: "Viewer" }, sources: [SRC({ kind: "link", strongest: true })] })).toBe("Viewer via share link");
  expect(ownersText([])).toBe("Ask an organization admin.");
  expect(ownersText([], true)).toBe("Ask whoever shared this with you.");   // only a real guest has no organization to ask
  const noAsk = { can: false, roles: [], pending: null, retryAfterMs: null };
  expect(whyLines(WHY({ owners: [], ask: noAsk }), here, "Editing", "board.create").at(-1)).toBe("Ask an organization admin.");   // a member whose Space has no named owners
  expect(whyLines(WHY({ owners: [], guest: true, ask: noAsk }), here, "Editing", "board.create").at(-1)).toBe("Ask whoever shared this with you.");
  expect(normalizeExplain({ ...WHY(), guest: "yes" }).guest).toBe(false);   // only a literal true is a guest
  expect(withArticle("Editor")).toBe("an Editor");
  expect(withArticle("Viewer")).toBe("a Viewer");
  // held: their role already ranks as high as the control asks, so "needs Editor" would be false; say why it is not enough
  const held = WHY({ mine: { role: { id: "editor", name: "Editor" }, sources: [] }, needs: { "board.create": { role: "editor", roleName: "Editor", held: true } } });
  const CE = SRC({ kind: "direct", scope: { type: "space", id: "s-1", name: "Platform" }, role: "r-ce", roleName: "Content editor", ladder: "editor", team: undefined });
  const heldBy = (src) => WHY({ mine: { role: { id: "editor", name: "Editor" }, sources: [src] }, needs: { "board.create": { role: "editor", roleName: "Editor", held: true } } });
  expect(whyLines(heldBy(CE), here, "Creating boards", "board.create")[1]).toBe("Creating boards needs the built-in Editor role. Your Editor access comes from the Content editor role, which does not allow creating boards.");
  expect(whyLines(heldBy({ ...CE, kind: "unit", scope: { type: "unit", id: "t-1" }, role: "member", roleName: "Member" }), here, "Creating boards", "board.create")[1]).toContain("comes from the organization's Member role, which does not allow");
  expect(whyLines(held, here, "Creating boards", "board.create")[1]).toBe("Creating boards needs the built-in Editor role. Your Editor access comes from a role that does not allow creating boards.");   // no source named
  expect(waitText(30 * 60_000)).toBe("in 30 minutes");
  expect(waitText(24 * 3600_000)).toBe("in 24 hours");
  expect(waitText(0)).toBe("");
});

const fakeApi = (answers) => { const calls = []; return { calls, ask: async (...a) => { calls.push(a); const r = answers.shift(); return typeof r === "function" ? r(...a) : r; } }; };
test("Ask model: one key per submit, reused by a retry after a lost answer; a new role is a new submit; success is final", async () => {
  const api = fakeApi([{ error: "network" }, { request: { role: "editor", roleName: "Editor", at: 9, state: "pending" } }]);
  let n = 0;
  const m = createAskModel({ api, type: "space", id: "s-1", why: WHY(), newKey: () => `key-${++n}` });
  expect(m.state).toMatchObject({ status: "idle", role: "editor" });
  expect(await m.submit()).toBe(false);
  expect(m.state).toMatchObject({ status: "error", message: "No answer from the server. Try again." });
  expect(await m.submit()).toBe(true);
  expect(api.calls).toEqual([["space", "s-1", "editor", "key-1"], ["space", "s-1", "editor", "key-1"]]);
  expect(m.state).toMatchObject({ status: "sent", pending: { role: "editor", roleName: "Editor", at: 9 } });
  expect(m.state.said).toContain("this Space's Access page");
  expect(await m.submit()).toBe(false);          // already sent: nothing more goes out
  expect(api.calls).toHaveLength(2);
  const a2 = fakeApi([{ error: "network" }, { error: "network" }]);
  const m2 = createAskModel({ api: a2, type: "board", id: "b-1", why: WHY(), newKey: () => `key-${++n}` });
  await m2.submit(); m2.choose("annotator"); await m2.submit();
  expect(a2.calls.map(c => [c[2], c[3]])).toEqual([["editor", "key-2"], ["annotator", "key-3"]]);
});

test("Ask model: limited says when to try again; a pending request starts as sent; refusals have words; no key maker sends none", async () => {
  const m = createAskModel({ api: fakeApi([{ error: "limited", retryAfter: 7200 }]), type: "space", id: "s-1", why: WHY() });
  await m.submit();
  expect(m.state).toMatchObject({ status: "limited", retryAfterMs: 7_200_000 });
  expect(m.state.message).toBe("You've asked too many times. Try again in 2 hours.");
  const sent = createAskModel({ api: fakeApi([]), type: "space", id: "s-1", why: WHY({ ask: { can: true, roles: [], pending: { role: "editor", roleName: "Editor", at: 1 }, retryAfterMs: null } }) });
  expect(sent.state.status).toBe("sent");
  expect(await sent.submit()).toBe(false);
  const api = fakeApi([{ error: "forbidden" }]);
  const nokey = createAskModel({ api, type: "group", id: "g-1", why: WHY() });
  await nokey.submit();
  expect(api.calls[0][3]).toBeNull();
  expect(nokey.state.message).toBe("You can't ask for access here.");
});

test("Ask model: clearLimit re-opens a limited button (and never a sent or busy one)", async () => {
  const api = fakeApi([{ error: "limited", retryAfter: 60 }]);
  const m = createAskModel({ api, type: "space", id: "s-1", why: WHY() });
  await m.submit();
  expect(m.state).toMatchObject({ status: "limited", retryAfterMs: 60_000 });
  m.clearLimit();
  expect(m.state).toMatchObject({ status: "idle", retryAfterMs: null, message: null });
  const sent = createAskModel({ api, type: "space", id: "s-1", why: WHY({ ask: { ...WHY().ask, pending: { role: "editor", roleName: "Editor", at: 1 } } }) });
  sent.clearLimit();
  expect(sent.state.status).toBe("sent");
});

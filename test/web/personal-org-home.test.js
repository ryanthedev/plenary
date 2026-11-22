// End-to-end tests for self-serve personal orgs on Home (Create Workspace, Org Members, Audit Log)
// and regression test for canvas Share dialog wiring (web/adapters/dom/app.js).
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { sessions as createSessions } from "../../server/auth/session.js";
import { httpRoutes } from "../../server/auth/http.js";
import { httpHome } from "../../web/adapters/home/http.js";
import { httpAdmin } from "../../web/adapters/admin/http.js";
import { createHomeModel } from "../../web/core/home.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";

const KEY = "personal-org-home-test-key-32-bytes-minimum!!!!!";
const CONFIG = {
  postLoginUrl: "https://p5y.omni.ooo/",
  boardUrl: "https://p5y.omni.ooo/?board={board}",
  publicUrl: "https://p5y.omni.ooo",
  cookieKey: KEY,
};

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

afterEach(() => {
  delete globalThis.document;
  delete globalThis.Node;
});

describe("Personal org Home E2E (papaender@gmail.com -> create workspace -> add friend@gmail.com -> audit log)", () => {
  test("guest creates personal workspace, creates shared board, adds & removes collaborator, views audit log; collaborator sees shared board on Home", async () => {
    let t = Date.UTC(2026, 10, 22, 18, 0, 0);
    const now = () => t;
    const tick = (ms = 1000) => { t += ms; };

    const registry = memoryRegistry({ now });
    const ten = tenancy({ registry, now });
    const home = homeService({ registry, tenancy: ten, now });
    const sessions = await createSessions({ key: KEY, now });
    const handle = httpRoutes({ registry, sessions, tenancy: ten, home, now, config: CONFIG });

    const fetchApi = (url, init) => handle(new Request(new URL(url, "https://p5y.omni.ooo"), init));

    const papaender = { user: "google:papaender", name: "Papa Ender", email: "papaender@gmail.com", domain: null };
    const friend = { user: "google:friend", name: "Friend", email: "friend@gmail.com", domain: null };
    const papaTok = await sessions.issue(papaender);
    const friendTok = await sessions.issue(friend);

    const mountFor = async token => {
      const dom = installDom();
      globalThis.document.addEventListener = () => {};
      globalThis.document.removeEventListener = () => {};
      globalThis.Node = Object.getPrototypeOf(FakeElement);
      const clock = virtualClock({ t0: now() });
      const model = createHomeModel({ api: httpHome({ fetch: fetchApi, token, timers: clock }), clock });
      const org = httpAdmin({ fetch: fetchApi, token });
      const dialogs = { newBoard() {}, newSpace() {}, newGroup() {} };
      const view = mountHome({
        root: dom.root, model, clock, dialogs, org,
        boardHref: id => `?board=${id}`, spaceHref: id => `?space=${id}`, groupHref: id => `?group=${id}`,
      });
      await model.load();
      await settle();
      return { root: dom.root, model, view, org };
    };

    // 1. Fresh @gmail.com user lands on Home: guest=true, sees empty copy + "Create your own Workspace" card
    const p1 = await mountFor(papaTok);
    expect(p1.model.state.data.guest).toBe(true);
    expect(textOf(p1.root)).toContain("Nothing is shared with you yet.");
    expect(textOf(p1.root)).toContain("Create your own Workspace");

    // 2. Submits org name "My Studio" -> POST /tenants -> reloads Home -> non-guest workspace with General space + Members + Audit log
    const nameInput = p1.root.find(e => e.getAttribute("aria-label") === "Workspace name");
    expect(nameInput).toBeTruthy();
    nameInput.value = "My Studio";
    const createForm = p1.root.find(e => e.tagName === "FORM");
    createForm.dispatch("submit", { preventDefault() {} });
    await settle(8);

    expect(p1.model.state.data.guest).toBe(false);
    expect(p1.model.state.data.unit).toMatchObject({ name: "My Studio", personal: true, isAdmin: true });
    expect(p1.model.state.data.tree.spaces.map(s => s.name)).toContain("General");
    expect(textOf(p1.root)).not.toContain("Create your own Workspace");
    const sideBtns = p1.root.find(e => e.hasClass("home-side")).findAll(e => e.tagName === "BUTTON").map(textOf);
    expect(sideBtns).toContain("＋ New board");
    expect(sideBtns).toContain("＋ New space");
    expect(sideBtns).toContain("Members");
    expect(sideBtns).toContain("Audit log");

    // 3. Create a shared board in General AND a private board in papaender's personal space
    tick(1000);
    const generalSpace = p1.model.state.data.tree.spaces.find(s => !s.personal);
    const personalSpace = p1.model.state.data.tree.spaces.find(s => s.personal);
    expect(generalSpace).toBeTruthy();
    expect(personalSpace).toBeTruthy();

    const sharedBoardRes = await fetchApi("/boards", {
      method: "POST",
      headers: { authorization: `Bearer ${papaTok}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Studio Roadmap", space: generalSpace.id, memberRole: "editor" }),
    });
    expect(sharedBoardRes.status).toBe(201);
    const { board: sharedBoard } = await sharedBoardRes.json();

    const privateBoardRes = await fetchApi("/boards", {
      method: "POST",
      headers: { authorization: `Bearer ${papaTok}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Private Scratch", space: personalSpace.id }),
    });
    expect(privateBoardRes.status).toBe(201);

    // 4. Open Members panel in mountHome and add friend@gmail.com
    tick(1000);
    const membersBtn = p1.root.findAll(e => e.tagName === "BUTTON").find(b => textOf(b) === "Members");
    membersBtn.click();
    await settle(6);
    expect(textOf(p1.root)).toContain("Workspace members");
    expect(textOf(p1.root)).toContain("papaender@gmail.com");

    const emailInput = p1.root.find(e => e.getAttribute("aria-label") === "Collaborator email");
    expect(emailInput).toBeTruthy();
    emailInput.value = "friend@gmail.com";
    const addForm = p1.root.find(e => e.tagName === "FORM");
    addForm.dispatch("submit", { preventDefault() {} });
    await settle(8);
    expect(textOf(p1.root)).toContain("friend@gmail.com");
    expect(p1.root.find(e => e.getAttribute("aria-label") === "Remove friend@gmail.com")).toBeTruthy();

    // 5. Open Audit log panel in mountHome -> shows tenant.create, board.create, tenant.member.add
    const auditBtn = p1.root.findAll(e => e.tagName === "BUTTON").find(b => textOf(b) === "Audit log");
    auditBtn.click();
    await settle(6);
    const auditText = textOf(p1.root);
    expect(auditText).toContain("Audit log");
    expect(auditText).toContain("tenant.create");
    expect(auditText).toContain("board.create");
    expect(auditText).toContain("tenant.member.add");
    p1.view.destroy();

    // 6. friend@gmail.com hits GET /home via mountHome -> sees My Studio's General Space AND Studio Roadmap (never Private Scratch), and no admin buttons
    const f1 = await mountFor(friendTok);
    expect(f1.model.state.data.guest).toBe(false);
    expect(f1.model.state.data.unit).toMatchObject({ name: "My Studio", personal: true });
    expect(f1.model.state.data.unit.isAdmin).toBeUndefined();
    expect(f1.model.state.data.tree.spaces.map(s => s.name)).toContain("General");
    expect(f1.model.state.data.shared.map(c => c.id)).toEqual([sharedBoard.id]);
    expect(textOf(f1.root)).toContain("Studio Roadmap");
    expect(textOf(f1.root)).not.toContain("Private Scratch");
    const friendSideBtns = f1.root.find(e => e.hasClass("home-side")).findAll(e => e.tagName === "BUTTON").map(textOf);
    expect(friendSideBtns).not.toContain("Members");
    expect(friendSideBtns).not.toContain("Audit log");
    f1.view.destroy();

    // 7. papaender removes friend@gmail.com via Members panel -> friend immediately returns to guest Home
    const p2 = await mountFor(papaTok);
    p2.root.findAll(e => e.tagName === "BUTTON").find(b => textOf(b) === "Members").click();
    await settle(6);
    const rmBtn = p2.root.find(e => e.getAttribute("aria-label") === "Remove friend@gmail.com");
    rmBtn.click();
    await settle(8);
    expect(textOf(p2.root)).toContain("No collaborators added yet.");
    p2.view.destroy();

    const f2 = await mountFor(friendTok);
    expect(f2.model.state.data.guest).toBe(true);
    expect(f2.model.state.data.shared).toEqual([]);
    expect(textOf(f2.root)).not.toContain("Studio Roadmap");
    f2.view.destroy();
  });
});

describe("Canvas Share dialog wiring regression (web/adapters/dom/app.js)", () => {
  test("app.js does not shadow imported openShare with a local function openShare()", () => {
    const src = readFileSync(join(import.meta.dir, "../../web/adapters/dom/app.js"), "utf8");
    expect(src).toContain('import { openShare } from "./share.js";');
    expect(src).not.toMatch(/\bfunction\s+openShare\s*\(/);
    expect(src).toMatch(/\bfunction\s+openAdminShare\s*\(/);
    expect(src).toContain("openShare: openShareDialog");
  });
});

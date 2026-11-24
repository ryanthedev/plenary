// @ts-check
// PRODUCTION composition root of the canvas page (index.html's entry; served by server/static.js, whose allowlist is
// index.html + this file's import graph). The only page file that picks adapters and wires them: the browser clock,
// session storage for the sign-in session, local storage for preferences, the HTTP auth adapter, the WebSocket net to
// the same origin's /ws, and the DOM chrome. No dev rooms and no dev user table here (manager decision, p6-hex fix
// round): those live in web/dev-main.js. `?as=` exists here only through the server's own answer (GET /auth/dev, below). test/web/architecture.test.js checks this file's whole import graph.
//
// URL: ?board=<id> | ?space=<id> | ?group=<id> (a Space or Group page, PROTOCOL.md § Spaces and Groups) &theme=light|dark &as=<dev user>
//      &as= works ONLY when the server says dev sign-in is on (GET /auth/dev, web/ports/devconfig.js: the server has
//      a local server with PLENARY_DEV_TOKENS, no Google sign-in and a loopback bind); otherwise it is ignored and nothing in the page offers it. With dev on, the sign-in screen lists
//      the dev users, and a link with no board lands on Home.
//      #code=<single-use code> after Google sign-in: dropped from the address
//      bar at once (or, if that fails, never exchanged), then exchanged by POST /auth/exchange for the session token.
// The token travels only in the first message on the socket (`hello`), never in the URL or a header (ws.js).

import { browserClock } from "./adapters/clock/browser.js";
import { sessionStore } from "./adapters/storage/session.js";
import { localStore } from "./adapters/storage/local.js";
import { httpAuth, fetchAuthProviders } from "./adapters/auth/http.js";
import { httpDevConfig } from "./adapters/auth/devconfig.js";
import { wsNet, sameOriginWsUrl, browserInflate } from "./adapters/transport/ws.js";
import { mountApp } from "./adapters/dom/app.js";
import { initTheme } from "./adapters/dom/theme.js";
import { syncCollabPort } from "./adapters/collab/sync.js";
import { showGate, hideGate } from "./adapters/dom/gate.js";
import { httpHome } from "./adapters/home/http.js";
import { mountHome } from "./adapters/dom/home.js";
import { createHomeModel } from "./core/home.js";
import { httpSpaces } from "./adapters/spaces/http.js";
import { mountSpacePage, mountGroupPage } from "./adapters/dom/spaces.js";
import { createDialogs, randomKey } from "./adapters/dom/dialogs.js";
import { httpAccess } from "./adapters/access/http.js";
import { httpShare } from "./adapters/share/http.js";
import { httpVersions } from "./adapters/versions/http.js";
import { httpAdmin } from "./adapters/admin/http.js";
import { httpMove } from "./adapters/move/http.js";
import { httpTrash } from "./adapters/trash/http.js";
import { mountTrashPage, mountTrashNotice } from "./adapters/dom/trash.js";
import { createTrashModel, createNoticeModel } from "./core/trash.js";
import { httpRoles } from "./adapters/roles/http.js";
import { httpOffboard } from "./adapters/offboard/http.js";
import { createOffboardModel } from "./core/offboard.js";
import { mountOffboardPage } from "./adapters/dom/offboard.js";
import { mountRolesPage } from "./adapters/dom/roles.js";
import { createRolesModel } from "./core/role-admin.js";
import { mountTeamsPage, mountTeamPage, mountAccessPage } from "./adapters/dom/access.js";
import { adminShell, normalizeAdminSection, mountAdminPeople, mountAdminSpaces, mountAdminAudit } from "./adapters/dom/admin-shell.js";
import { createTeamsModel, createTeamModel, createAccessModel } from "./core/access.js";
import { createPageModel } from "./core/spaces.js";
import { takeSignIn, signInNotice, asParam, menuSignIn, devLinks, signOut } from "./core/signin.js";
import { createSession } from "./core/session.js";
import { rememberBoard, takeReturnBoard } from "./core/roles.js";

const clock = browserClock();
const prefs = localStore();
const q0 = new URLSearchParams(location.search);
const theme0 = q0.get("theme");
const themeCtrl = initTheme({ prefs, urlTheme: theme0 });
const fetchNow = /** @type {typeof globalThis.fetch} */ ((input, init) => globalThis.fetch(input, init));

// Never a blank page: the gate shows before the exchange starts (p6-hexv MEDIUM; worst case ~22 s of retries).
if (location.hash) showGate({ title: "Signing in…" });

// First thing: the sign-in fragment off the address bar (takeSignIn drops it before anything else).
const tabStore = sessionStore();
const fromCode = await takeSignIn({
  fragment: location.hash,
  replaceFragment: () => { if (location.hash) history.replaceState(history.state, "", location.pathname + location.search); },
  storage: sessionStore(),
  auth: httpAuth({ fetch: fetchNow, timers: clock }),
  clock,
});

// Dev sign-in: only when the SERVER offers it (the menu is null on a production server). Asked for when this tab has
// no session yet or the URL has `?as=` (a production server answers 404, which is null).
const devConfig = httpDevConfig({ fetch: fetchNow, timers: clock });
let menuAsked = null;
const devMenu = () => (menuAsked ??= devConfig.get());
const menu = !fromCode.token || asParam(location.search) !== null ? await devMenu() : null;
const picked = menuSignIn({ query: location.search, menu, storage: tabStore, clock });
const signIn = picked ?? fromCode;

const q = new URLSearchParams(location.search);
const asked = /^[\w-]{1,64}$/.test(q.get("board") ?? "") ? q.get("board") : null;
// Back from "Sign in again" (C-9): the server's login lands on its fixed page, so the board this tab left comes from
// session storage (the board id only, once, after a fresh sign-in), and goes back into the address bar.
const back = takeReturnBoard(tabStore, { outcome: signIn.outcome, board: asked });
if (back) { q.set("board", back); history.replaceState(history.state, "", `${location.pathname}?${q}`); }
// A link with no board lands on Home (everyone, a dev user included): Recent, Starred, Shared with me, the Space tree, search.
const board = asked ?? back;
const idParam = name => (/^[\w-]{1,64}$/.test(q.get(name) ?? "") ? q.get(name) : null);
const spaceId = idParam("space"), groupId = idParam("group"), teamId = idParam("team"), teamsPage = q.has("teams"), rolesPage = q.has("roles"), trashPage = q.has("trash"), offboardPage = q.has("offboard"), adminPage = q.has("admin");
const accessArg = /^(unit|group|space|board):([\w-]{1,64})$/.exec(q.get("access") ?? "");
/** A link to another page of this app, keeping the theme. */
const hrefTo = params => `?${new URLSearchParams({ ...params, ...(theme0 ? { theme: theme0 } : {}) })}`;
const signInLink = { href: "/auth/login", text: "Sign in with Google" };

if (!signIn.token) {
  // Signed out on a board's link (an expired sign-in, after a reload): the gate's sign-in comes back to that board.
  if (board) rememberBoard(tabStore, board);
  const wanted = asParam(location.search);
  const hint = menu ? (wanted ? `There is no dev user "${wanted}" on this server. ` : "") + "Dev sign-in is on: pick a user." : null;
  const authProviders = menu ? null : await fetchAuthProviders({ fetch: fetchNow, timers: clock });
  const providerLinks = authProviders && authProviders.length ? authProviders : [signInLink];
  const defaultDetail = providerLinks.length > 1 || providerLinks[0]?.id === "microsoft"
    ? "Sign in with your work account to open this board."
    : "Sign in with your work Google account to open this board.";
  showGate({
    title: "Sign in to Plenary",
    detail: signInNotice(/** @type {any} */ ({ ...signIn, dev: null })) ?? hint ?? defaultDetail,
    link: menu ? null : providerLinks[0],
    links: menu ? devLinks(menu, board ?? menu.board) : providerLinks.slice(1),
  });
} else {
  const spacesApi = httpSpaces({ fetch: fetchNow, token: signIn.token, timers: clock });
  const orgApi = httpAdmin({ fetch: fetchNow, token: signIn.token });
  const onLogout = () => {
    signOut(tabStore);
    location.assign("/auth/logout");
  };
  if (!board) {
  // Signed in with no board in the link: Home (PROTOCOL.md § Home). Its sign-in expiry shows as "signed out" with a link back in.
  document.querySelector(".app")?.remove();
  const root = document.createElement("div");
  document.body.append(root);
  const hrefs = {
    home: location.pathname,
    board: id => hrefTo({ board: id }),
    space: id => hrefTo({ space: id }),
    group: id => hrefTo({ group: id }),
    team: id => hrefTo({ team: id }),
    teams: hrefTo({ admin: "teams" }),
    roles: hrefTo({ admin: "roles" }),
    offboard: hrefTo({ admin: "offboard" }),
    people: hrefTo({ admin: "people" }),
    spaces: hrefTo({ admin: "spaces" }),
    audit: hrefTo({ admin: "audit" }),
    trash: hrefTo({ trash: "1" }),
    access: (type, id) => hrefTo({ access: `${type}:${id}` }),
    admin: (sec = "people", extra = {}) => hrefTo({ admin: sec, ...extra }),
  };
  const dialogs = createDialogs({ host: root, api: spacesApi, hrefs, go: href => location.assign(href) });
  const isUnitAccess = Boolean(accessArg && accessArg[1] === "unit");
  const inAdminShell = adminPage || rolesPage || offboardPage || teamsPage || Boolean(teamId) || isUnitAccess;
  if (inAdminShell) {
    const section = adminPage
      ? normalizeAdminSection(q.get("admin"))
      : (rolesPage || isUnitAccess) ? "roles"
        : offboardPage ? "offboard"
          : "teams";
    const chrome = adminShell({ root, section, hrefs, themeCtrl, onLogout });
    hideGate();
    let tenant = null;
    try {
      const res = await orgApi.listTenants();
      const list = Array.isArray(res?.tenants) ? res.tenants : [];
      const found = list.find(t => t.isAdmin) ?? list[0] ?? null;
      if (found) tenant = { ...found, personal: found.domain === null };
      if (tenant?.name) chrome.setWorkspaceName(tenant.name);
    } catch {
      tenant = null;
    }
    if (isUnitAccess) {
      const api = httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock });
      const model = createAccessModel({ api, type: "unit", id: accessArg[2] });
      mountAccessPage({ root, chrome, model, api, hrefs, signIn: signInLink, newKey: () => randomKey(), themeCtrl });
      model.load();
    } else if (section === "people") {
      mountAdminPeople({ root, chrome, org: orgApi, tenant, hrefs });
    } else if (section === "spaces") {
      mountAdminSpaces({ chrome, org: orgApi, tenant, hrefs });
    } else if (section === "audit") {
      mountAdminAudit({ chrome, org: orgApi, tenant, clock });
    } else if (section === "roles") {
      const model = createRolesModel({ api: httpRoles({ fetch: fetchNow, token: signIn.token, timers: clock }), newKey: () => randomKey() });
      mountRolesPage({ root, chrome, model, hrefs, signIn: signInLink, themeCtrl, unitId: tenant?.id ?? null });
      model.load();
    } else if (section === "offboard") {
      const who = q.get("user") || (q.get("offboard") && q.get("offboard") !== "1" ? q.get("offboard") : null);
      const model = createOffboardModel({ api: httpOffboard({ fetch: fetchNow, token: signIn.token, timers: clock }), newKey: () => randomKey() });
      mountOffboardPage({
        root, chrome, model, hrefs, signIn: signInLink, start: who ? who.slice(0, 200) : null, themeCtrl,
        onDemoteAdmin: tenant?.id ? (uid => orgApi.removeTenantAdmin(tenant.id, uid)) : null,
      });
    } else if (teamId) {
      const api = httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock });
      const model = createTeamModel({ api, id: teamId });
      mountTeamPage({ root, chrome, model, api, hrefs, signIn: signInLink, themeCtrl });
      model.load();
    } else {
      const api = httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock });
      const model = createTeamsModel({ api });
      mountTeamsPage({ root, chrome, model, hrefs, signIn: signInLink, themeCtrl });
      model.load();
    }
  } else if (trashPage) {
    // The Trash (PROTOCOL.md § Trash and restore): what this person may restore. A caller outside a Unit gets the same "not available" page.
    const model = createTrashModel({ api: httpTrash({ fetch: fetchNow, token: signIn.token, timers: clock }), newKey: () => randomKey() });
    mountTrashPage({ root, model, hrefs, signIn: signInLink, themeCtrl }); hideGate(); model.load();
  } else if (accessArg) {
    // Access page of a group, space, or board scope.
    const api = httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock });
    const model = createAccessModel({ api, type: /** @type {"unit"|"group"|"space"|"board"} */ (accessArg[1]), id: accessArg[2] });
    mountAccessPage({ root, model, api, hrefs, signIn: signInLink, newKey: () => randomKey(), themeCtrl }); hideGate(); model.load();
  } else if (spaceId || groupId) {
    // A Space or Group page. An id the person can't open shows the same "not available" page as one that does not exist.
    const model = createPageModel({ api: spacesApi, kind: spaceId ? "space" : "group", id: spaceId ?? groupId });
    (spaceId ? mountSpacePage : mountGroupPage)({ root, model, dialogs, hrefs, signIn: signInLink, themeCtrl, access: httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock }), newKey: () => randomKey(),
      move: { port: httpMove({ fetch: fetchNow, token: signIn.token, timers: clock }), clock, newKey: () => randomKey() },
      trash: { api: httpTrash({ fetch: fetchNow, token: signIn.token, timers: clock }), clock, newKey: () => randomKey() } });
    hideGate();
    model.load();
  } else {
    const model = createHomeModel({ api: httpHome({ fetch: fetchNow, token: signIn.token, timers: clock }), clock });
    mountHome({ root, model, clock, signIn: signInLink, homeHref: location.pathname, dialogs,
      org: orgApi, onLogout, themeCtrl,
      boardHref: hrefs.board, spaceHref: hrefs.space, groupHref: hrefs.group, teamsHref: hrefs.teams, trashHref: hrefs.trash, rolesHref: hrefs.roles, offboardHref: hrefs.offboard, unitAccessHref: id => hrefs.access("unit", id), adminHref: hrefs.admin("people"),
      move: { port: httpMove({ fetch: fetchNow, token: signIn.token, timers: clock }), clock, newKey: () => randomKey() } });
    hideGate();
    model.load();
  }
} else {
  const id = signIn.identity;
  const me = { role: null, user: id?.user ?? "me", name: id?.name ?? id?.email ?? "You", email: id?.email ?? null, domain: id?.domain ?? null };
  const net = wsNet({ url: sameOriginWsUrl(location), WebSocket: globalThis.WebSocket, clock, fetch: fetchNow, inflate: browserInflate() });
  let inTrash = false;   // the Trash notice is showing: the room's "refused" banner would send the person to sign in for nothing
  const getBoardTitle = async () => {
    try {
      const res = await orgApi.listBoards();
      const hit = res?.boards?.find(b => b.id === board);
      return hit ? { title: typeof hit.title === "string" ? hit.title : "" } : null;
    } catch {
      return null;
    }
  };
  const app = mountApp({
    trashShown: () => inTrash,
    getBoardTitle,
    renameBoard: title => spacesApi.renameBoard(board, title),
    startSession: ({ mine, onChange }) => {
      // A board that refuses the visit may be in Trash (PROTOCOL.md § Trash and restore): ask once, and say so over the page when it is; any other answer leaves the page's own refusal.
      let session = null, asked = false;
      const trashNotice = () => {
        asked = true;
        const model = createNoticeModel({ api: httpTrash({ fetch: fetchNow, token: signIn.token, timers: clock }), board, newKey: () => randomKey() });
        mountTrashNotice({ host: document.body, model, homeHref: location.pathname, onRestored: () => location.reload() });
        model.subscribe(() => { inTrash = model.state.status === "ready" || model.state.status === "restored"; onChange(); });   // the page redraws its banners
        model.load();
      };
      session = createSession({
        join: () => net.join(), token: signIn.token, board, client: "web", user: me.user, mine, clock,
        .../** @type {any} */ ({ fetchSnapshot: net.fetchSnapshot, uploadBlob: net.uploadBlob, fetchBlob: net.fetchBlob }),
        onChange: () => { onChange(); if (!asked && session?.status === "refused") trashNotice(); },
      });
      return session;
    },
    net, board, me, prefs, theme: theme0,
    // Why the pill says "View only" (PROTOCOL.md § Access explanation and requests): looked up when the pill is opened, with Ask for access.
    access: httpAccess({ fetch: fetchNow, token: signIn.token, timers: clock }), newKey: () => randomKey(),
    // The Share dialog's calls (PROTOCOL.md § Share dialog).
    share: httpShare({ fetch: fetchNow, token: signIn.token, timers: clock }),
    // Move to… in the More menu (PROTOCOL.md § Move board, "Where it appears"): the same port as the Space page and Home.
    move: { port: httpMove({ fetch: fetchNow, token: signIn.token, timers: clock }), clock, newKey: () => randomKey() },
    // Board version history & named snapshots (#19).
    versions: httpVersions({ fetch: fetchNow, token: signIn.token, timers: clock }),
    // The collaboration UI over this session (presence and records ride the board connection; web/adapters/collab/sync.js).
    collab: (S, o) => syncCollabPort(S, { name: me.name, ...o }),
    notice: signInNotice(/** @type {any} */ ({ ...signIn, dev: null }), me.name),
    clock,
    // exp: seconds (the sign-in contract); the page warns before it on the clock's ms scale.
    expAt: Number.isFinite(signIn.exp) ? signIn.exp * 1000 : null,
    relogin: { href: signInLink.href, go: () => { rememberBoard(tabStore, board); location.assign(signInLink.href); } },
    onLogout,
    homeHref: `${location.pathname}${theme0 ? `?theme=${encodeURIComponent(theme0)}` : ""}`,
  });
  hideGate();
  globalThis.plenary = app;
  }
}

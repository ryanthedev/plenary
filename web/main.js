// PRODUCTION composition root of the canvas page (index.html's entry; served by server/static.js, whose allowlist is
// index.html + this file's import graph). The only page file that picks adapters and wires them: the browser clock,
// session storage for the sign-in session, local storage for preferences, the HTTP auth adapter, the WebSocket net to
// the same origin's /ws, and the DOM chrome. No dev rooms and no dev user table here (manager decision, p6-hex fix
// round): those live in web/dev-main.js. `?as=` exists here only through the server's own answer (GET /auth/dev, below). test/web/architecture.test.js checks this file's whole import graph.
//
// URL: ?board=<id> &theme=light|dark &as=<dev user>
//      &as= works ONLY when the server says dev sign-in is on (GET /auth/dev, web/ports/devconfig.js: the server has
//      a local server with PLENARY_DEV_TOKENS, no Google sign-in and a loopback bind); otherwise it is ignored and nothing in the page offers it. With dev on, the sign-in screen lists
//      the dev users, and a link with no board lands on the server's dev board.
//      #code=<single-use code> after Google sign-in (docs/m2/contracts/auth-exchange.md): dropped from the address
//      bar at once (or, if that fails, never exchanged), then exchanged by POST /auth/exchange for the session token.
// The token travels only in the first message on the socket (`hello`), never in the URL or a header (ws.js).

import { browserClock } from "./adapters/clock/browser.js";
import { sessionStore } from "./adapters/storage/session.js";
import { localStore } from "./adapters/storage/local.js";
import { httpAuth } from "./adapters/auth/http.js";
import { httpDevConfig } from "./adapters/auth/devconfig.js";
import { wsNet, sameOriginWsUrl } from "./adapters/transport/ws.js";
import { mountApp } from "./adapters/dom/app.js";
import { syncCollabPort } from "./adapters/collab/sync.js";
import { showGate, hideGate } from "./adapters/dom/gate.js";
import { takeSignIn, signInNotice, asParam, menuSignIn, devLinks } from "./core/signin.js";
import { createSession } from "./core/session.js";
import { rememberBoard, takeReturnBoard } from "./core/roles.js";

const clock = browserClock();

// Never a blank page: the gate shows before the exchange starts (p6-hexv MEDIUM; worst case ~22 s of retries).
if (location.hash) showGate({ title: "Signing in…" });

// First thing: the sign-in fragment off the address bar (takeSignIn drops it before anything else).
const tabStore = sessionStore();
const fromCode = await takeSignIn({
  fragment: location.hash,
  replaceFragment: () => { if (location.hash) history.replaceState(history.state, "", location.pathname + location.search); },
  storage: sessionStore(),
  auth: httpAuth({ fetch: (...a) => globalThis.fetch(...a), timers: clock }),
  clock,
});

// Dev sign-in: only when the SERVER offers it (the menu is null on a production server). Asked for when this tab has
// no session yet or the URL has `?as=`. A signed-in tab with no `?board=` asks once more, to find the dev board (a
// production server answers 404, which is null).
const devConfig = httpDevConfig({ fetch: (...a) => globalThis.fetch(...a), timers: clock });
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
// A dev user's link with no board lands on the server's dev board (its id comes from the same menu).
const devBoard = async () => { const t = (picked ?? fromCode).token, m = t ? await devMenu() : null; return m?.users.some(u => u.token === t) ? m.board : null; };
const board = asked ?? back ?? (await devBoard());
const signInLink = { href: "/auth/login", text: "Sign in with Google" };

if (!signIn.token) {
  // Signed out on a board's link (an expired sign-in, after a reload): the gate's sign-in comes back to that board.
  if (board) rememberBoard(tabStore, board);
  const wanted = asParam(location.search);
  const hint = menu ? (wanted ? `There is no dev user "${wanted}" on this server. ` : "") + "Dev sign-in is on: pick a user." : null;
  showGate({
    title: "Sign in to Plenary",
    detail: signInNotice({ ...signIn, dev: null }) ?? hint ?? "Sign in with your work Google account to open this board.",
    link: menu ? null : signInLink, links: menu ? devLinks(menu, board ?? menu.board) : [],
  });
} else if (!board) {
  showGate({ title: "No board in this link", detail: "Open the board from the link you were sent." });
} else {
  // Display only (p6-landv L5): the room decides the real user and role on every hello (the note lock uses welcome.user).
  const id = signIn.identity;
  const me = { role: null, user: id?.user ?? "me", name: id?.name ?? id?.email ?? "You" };
  const net = wsNet({ url: sameOriginWsUrl(location), WebSocket: globalThis.WebSocket, clock });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(), token: signIn.token, board, client: "web", user: me.user, mine, onChange, clock,
    }),
    net, board, me, prefs: localStore(), theme: q.get("theme"),
    // The collaboration UI over this session (presence and records ride the board connection; web/adapters/collab/sync.js).
    collab: (S, o) => syncCollabPort(S, { name: me.name, ...o }),
    notice: signInNotice({ ...signIn, dev: null }, me.name),
    clock,
    // exp: seconds (the sign-in contract); the page warns before it on the clock's ms scale.
    expAt: Number.isFinite(signIn.exp) ? signIn.exp * 1000 : null,
    relogin: { href: signInLink.href, go: () => { rememberBoard(tabStore, board); location.assign(signInLink.href); } },
  });
  hideGate();
  globalThis.plenary = app;
}

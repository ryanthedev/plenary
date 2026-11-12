// PRODUCTION composition root of the canvas page (index.html's entry; served by server/static.js, whose allowlist is
// index.html + this file's import graph). The only page file that picks adapters and wires them: the browser clock,
// session storage for the sign-in session, local storage for preferences, the HTTP auth adapter, the WebSocket net to
// the same origin's /ws, and the DOM chrome. No dev rooms, no dev users, no ?as= here (manager decision, p6-hex fix
// round): those live in web/dev-main.js. test/web/architecture.test.js checks this file's whole import graph.
//
// URL: ?board=<id> &theme=light|dark
//      #code=<single-use code> after Google sign-in (docs/m2/contracts/auth-exchange.md): dropped from the address
//      bar at once (or, if that fails, never exchanged), then exchanged by POST /auth/exchange for the session token.
// The token travels only in the first message on the socket (`hello`), never in the URL or a header (ws.js).

import { browserClock } from "./adapters/clock/browser.js";
import { sessionStore } from "./adapters/storage/session.js";
import { localStore } from "./adapters/storage/local.js";
import { httpAuth } from "./adapters/auth/http.js";
import { wsNet, sameOriginWsUrl } from "./adapters/transport/ws.js";
import { mountApp } from "./adapters/dom/app.js";
import { showGate, hideGate } from "./adapters/dom/gate.js";
import { takeSignIn, signInNotice } from "./core/signin.js";
import { createSession } from "./core/session.js";

const clock = browserClock();

// Never a blank page: the gate shows before the exchange starts (p6-hexv MEDIUM; worst case ~22 s of retries).
if (location.hash) showGate({ title: "Signing in…" });

// First thing: the sign-in fragment off the address bar (takeSignIn drops it before anything else).
const signIn = await takeSignIn({
  fragment: location.hash,
  replaceFragment: () => { if (location.hash) history.replaceState(history.state, "", location.pathname + location.search); },
  storage: sessionStore(),
  auth: httpAuth({ fetch: (...a) => globalThis.fetch(...a), timers: clock }),
  clock,
});

const q = new URLSearchParams(location.search);
const board = /^[\w-]{1,64}$/.test(q.get("board") ?? "") ? q.get("board") : null;
const signInLink = { href: "/auth/login", text: "Sign in with Google" };

if (!signIn.token) {
  showGate({ title: "Sign in to Plenary", detail: signInNotice({ ...signIn, dev: null }) ?? "Sign in with your work Google account to open this board.", link: signInLink });
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
    notice: signInNotice({ ...signIn, dev: null }, me.name),
  });
  hideGate();
  globalThis.plenary = app;
}

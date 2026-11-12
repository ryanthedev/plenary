// DEV-ONLY composition root (web/dev-main.html; never loaded by index.html, never served by server/static.js, whose
// allowlist is index.html + web/main.js's import graph). Wires the in-browser rooms: the SharedWorker room (or the
// in-page room when SharedWorker is missing or ?net=local) and the dev users (web/core/dev-users.js).
//
// URL: dev-main.html?board=<id> &as=<dev user: ada bo cy di ed fi> &theme=light|dark &net=shared|local
//      #code=<single-use code> is still honoured (exchanged by POST /auth/exchange), but the in-browser rooms know
//      only dev tokens, so a real session is refused here: the production page is index.html (web/main.js, ws.js).
// Who signs in (web/core/signin.js pageSignIn): an explicit known ?as= (token dev-<as>, nothing exchanged or
// stored); else the exchanged or stored session; else dev ada.

import { browserClock } from "./adapters/clock/browser.js";
import { sessionStore } from "./adapters/storage/session.js";
import { localStore } from "./adapters/storage/local.js";
import { httpAuth } from "./adapters/auth/http.js";
import { sharedNet } from "./adapters/transport/shared-worker/client.js";
import { localNet } from "./adapters/transport/local.js";
import { mountApp } from "./adapters/dom/app.js";
import { showGate, hideGate } from "./adapters/dom/gate.js";
import { DEV_USERS } from "./core/dev-users.js";
import { pageSignIn, signInNotice } from "./core/signin.js";
import { createSession } from "./core/session.js";

const clock = browserClock();
if (location.hash) showGate({ title: "Signing in…" });   // before the exchange starts (p6-hexv MEDIUM)

// First thing: the sign-in fragment off the address bar (pageSignIn drops it before anything else).
const signIn = await pageSignIn({
  query: location.search,
  fragment: location.hash,
  replaceFragment: () => { if (location.hash) history.replaceState(history.state, "", location.pathname + location.search); },
  storage: sessionStore(),
  auth: httpAuth({ fetch: (...a) => globalThis.fetch(...a), timers: clock }),
  clock,
  devUsers: DEV_USERS,
});

const q = new URLSearchParams(location.search);
const ok = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
const board = ok(q.get("board"), /^[\w-]{1,64}$/) ?? "demo";
// Display only (p6-landv L5): the room decides the real user and role on every hello.
const id = signIn.identity;
const me = signIn.dev
  ? DEV_USERS[`dev-${signIn.dev}`]
  : { role: null, user: id?.user ?? "me", name: id?.name ?? id?.email ?? "You" };
const net = (q.get("net") === "local" ? null : sharedNet({ board })) ?? localNet({ board, users: DEV_USERS });

const app = mountApp({
  startSession: ({ mine, onChange }) => createSession({
    join: () => net.join(), token: signIn.token, board, client: signIn.dev ?? "web", user: me.user, mine, onChange, clock,
  }),
  net, board, me, prefs: localStore(), theme: q.get("theme"),
  notice: signInNotice(signIn, me.name),
});
hideGate();
globalThis.plenary = app;

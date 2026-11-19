// The real canvas app (web/adapters/dom/app.js) mounted on the stub page (./stub-page.js) over a real wsNet to a real
// server: for tests that must show a picture reaches the screen's Editors without the test calling `want` itself.
// What stays by hand is only what needs a browser to decode a File: `upload(file)` runs the two lines app.js runs after
// decoding (S.addPicture(f), net.put(f)).
//   const page = appClient({ url, board, token, user });  await page.until(() => page.S.role === "presenter", "welcome");
//   page.close() when done (its transports end, so the session does not reconnect to a stopped server).
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { browserClock } from "../../web/adapters/clock/browser.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";
import { until } from "../server/helpers.js";

/** A picture painted through `new Image()`: a stub that never loads (the app only needs the call to work). */
const stubImage = () => { globalThis.Image ??= class { set src(v) { this._src = v; } }; };
/** Put the globals the stubs replaced back (afterAll of the test file). */
export const restoreAppGlobals = () => { restoreGlobals(); delete globalThis.Image; };

/** @param {{ url: string, board: string, token: string, user: string, name?: string }   // name: the client id (no colon)} o */
export function appClient({ url, board, token, user, name = user.replace(/\W/g, "") }) {
  installPage(); stubImage();
  const clock = browserClock(), transports = [];
  const net = wsNet({ url, WebSocket, clock });
  const wanted = [];
  const want = net.want; net.want = id => { wanted.push(id); return want(id); };   // observed, never replaced: the app is what calls it
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({ join: () => { const t = net.join(); transports.push(t); return t; }, token, board, client: name, user, mine, onChange, clock }),
    net, board, me: { user, name, role: null }, prefs: memoryStore(), theme: "light", clock,
  });
  const pump = () => { const q = stub.frames; stub.frames = []; for (const fn of q) fn(); };
  return {
    net, app, S: app.S, wanted, pump,
    /** Poll (running the page's animation frames) until `fn()` is truthy. */
    until: (fn, what, ms = 15_000) => until(() => { pump(); return fn(); }, what, ms),
    /** What app.js does with a decoded picture. */
    upload(file) { const id = this.S.addPicture(file); if (id) net.put(file); return id; },
    close() { for (const t of transports.splice(0)) t.close(); },
  };
}

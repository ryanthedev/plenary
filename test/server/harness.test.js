// The test harness itself (rig.js's client).
//
// R6 (p2-swapv round 2): "clients converge … (seed 1)" timed out in `settled` about 1 run in 40-70 under load.
// Captured with a trace in the harness (2 failures in 120 loaded runs, same shape): one client sat with
// `resync: true` on an OPEN socket with `wantOpen: false`, so its pump never reconnected it. Sequence: connect()
// started opening a new socket while the old one still looked open; the test loop's drop() ran in that window
// (wantOpen = false, old socket closed); then the new socket finished opening and was adopted anyway. The next
// `forbidden` set resync, and pump() ignored it because the client "didn't want" its socket. A harness race, not a
// server one. Fix: drop() counts; a socket that finishes opening after a drop is closed, never adopted.
import { test, expect, afterAll } from "bun:test";
import { rig, client } from "./rig.js";
import { cleanup, until, deferred } from "./helpers.js";

afterAll(cleanup);

test("R6: a drop() while a connect() is opening its socket wins: the late socket is closed, never adopted unwanted", async () => {
  const r = await rig();
  let gate = null;
  const c = client(r, "annotator", "annotator", { maxWaitMs: 0, beforeOpen: () => gate?.promise });
  await c.connect();
  await until(() => c.r.welcomed, "the first welcome");
  gate = deferred();
  const opening = c.connect();                                            // a second connect, held before its socket opens
  expect(c.open).toBe(true);                                              // the old socket still looks open…
  await c.drop();                                                         // …so a drop lands in the window
  gate.resolve(); await opening;
  // The invariant the race broke: an open socket is a wanted one.
  expect(c.open && !c.wantOpen).toBe(false);
  expect(c.s).toBe(null);
  // And the client still works: connect again, and a resync reconnects it (event-driven waits).
  gate = null;
  await c.connect(); await until(() => c.open && c.r.welcomed, "the welcome after reconnecting");
  const before = c.connects;
  c.r.resync = true; c.pump();
  await until(() => c.connects > before && c.open && !c.r.resync && c.r.welcomed, "the reconnect after a resync");
  await c.drop();
  await r.stop();
}, 20000);

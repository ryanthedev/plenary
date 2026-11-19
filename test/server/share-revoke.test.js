// Revoking an invite or a share link ends a connected holder's access (PROTOCOL.md § Share dialog, "Revoke"; #52), end to end: a real server (HTTP routes, announcing
// Registry, gateway, sockets), then the same with the announcement lost, where the gateway's timed re-check is the window.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";
import { rig, sock, tokenOf } from "./rig.js";
import { virtualTime } from "./virtual.js";
import { sleep } from "./helpers.js";

const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const TOKENS = JSON.stringify({ "dev-ada": { name: "ada", role: "owner" }, "dev-kim": { name: "kim", email: "kim@partner.test" } });

test("DW-52.5 an invite and a link, each revoked over HTTP, cut a connected holder off (auth 1008) within one re-check pass; a repeat revoke is still 204", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plenary-share-")); made.push(dir);
  const app = await start({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: TOKENS });
  try {
    const base = app.server.url, board = app.devBoard;
    await app.registry.setGrant(board, "dev:kim", null);                                   // kim holds nothing but what is shared with them
    const api = (method, path, tok, body) => fetch(base + path, { method, headers: { authorization: `Bearer dev-${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const join = async () => { const s = await sock(base.replace("http", "ws") + "/ws"); s.send({ t: "hello", v: 1, token: "dev-kim", board, since: 0, client: "kim" }); return s; };

    // before anything: kim is refused
    const none = await join(); await none.whenClosed(); expect(none.msgs.find(m => m.t === "error")?.code).toBe("auth");

    // invite
    const inv = (await (await api("POST", `/boards/${board}/invites`, "ada", { email: "kim@partner.test", role: "viewer" })).json()).invite;
    const a = await join();
    expect(await a.next(m => m.t === "welcome")).toMatchObject({ role: "viewer" });
    const t0 = Date.now();
    expect((await api("DELETE", `/boards/${board}/invites/${inv.id}`, "ada")).status).toBe(204);
    expect((await a.whenClosed(10_000)).code).toBe(1008);
    expect(Date.now() - t0).toBeLessThan(5000);                                            // announced: one pass, not the 60 s timer
    expect((await api("DELETE", `/boards/${board}/invites/${inv.id}`, "ada")).status).toBe(204);
    const again = await join(); await again.whenClosed(); expect(again.msgs.find(m => m.t === "error")?.code).toBe("auth");

    // link
    const { link } = await (await api("POST", `/boards/${board}/links`, "ada", { role: "annotator" })).json();
    expect((await api("GET", `/links/${link.id}`, "kim")).status).toBe(200);                 // kim redeems it (signed in)
    const b = await join();
    expect(await b.next(m => m.t === "welcome")).toMatchObject({ role: "annotator" });
    expect((await api("DELETE", `/boards/${board}/links/${link.id}`, "ada")).status).toBe(204);
    expect((await b.whenClosed(10_000)).code).toBe(1008);
    expect((await api("GET", `/boards/${board}/share`, "kim")).status).toBe(403);           // and kim never saw the lists
  } finally { await app.stop(); }
}, 40_000);

test("DW-52.5b with the announcement lost, a revoked link holder is cut off by the timed re-check (the documented window), not before it", async () => {
  const V = virtualTime({ start: Date.now(), settle: () => new Promise(res => setImmediate(res)) });
  const r = await rig({ now: V.now, timers: V.timers, limits: { roleRecheckMs: 200 } });
  const link = await r.registry.createLink({ board: r.ids.board, role: "viewer", by: "dev:owner" });
  await r.registry.addLinkUse(link.id, "dev:stranger");
  const s = await r.sock(); s.send({ t: "hello", v: 1, token: tokenOf("stranger"), board: r.ids.board, since: 0, client: "s" });
  expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "viewer" });
  await r.registry.revokeLink(link.id);                                                   // straight to the Registry: no `.grants` message
  await V.advance(100); await sleep(20);
  expect(s.closed).toBe(null);                                                            // inside the window: still connected
  await V.advance(300);
  expect((await s.whenClosed()).code).toBe(1008);
  await r.stop();
}, 20_000);

test("DW-52.5c the same for an INVITE: revoked straight in the Registry (announcement lost), the holder stays inside the window and is cut by the timed re-check", async () => {
  const V = virtualTime({ start: Date.now(), settle: () => new Promise(res => setImmediate(res)) });
  // the stranger signs in with an authoritative email, which is what an invite matches
  const withEmail = a => ({ ...a, async verify(t) { const id = await a.verify(t); return id && id.user === "dev:stranger" ? { ...id, email: "x@partner.test" } : id; } });
  const r = await rig({ now: V.now, timers: V.timers, limits: { roleRecheckMs: 200 }, wrapAuth: withEmail });
  const inv = await r.registry.createInvite({ board: r.ids.board, email: "x@partner.test", role: "viewer", by: "dev:owner" });
  const s = await r.sock(); s.send({ t: "hello", v: 1, token: tokenOf("stranger"), board: r.ids.board, since: 0, client: "s" });
  expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "viewer" });
  await r.registry.revokeInvite(inv.id);                                                  // no `.grants` message
  await V.advance(100); await sleep(20);
  expect(s.closed).toBe(null);
  await V.advance(300);
  expect((await s.whenClosed()).code).toBe(1008);
  await r.stop();
}, 20_000);

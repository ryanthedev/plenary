// web/core/move.js: the Move dialog's state (destination, diff, one key per submit, stale previews dropped) and Undo's outcomes, on a fake port.
import { test, expect } from "bun:test";
import { createMoveModel, createUndo, diffText, movedText } from "../../../web/core/move.js";

const role = (id, name) => ({ id, name });
const OPTIONS = { board: { id: "b-1", title: "Roadmap" }, from: { id: "s-1", name: "Mine", personal: true }, destinations: [{ id: "s-2", name: "Design", personal: false, general: "viewer", group: null }, { id: "s-3", name: "Platform", personal: false, general: null, group: null }], more: false };
const diff = to => ({ board: { id: "b-1", title: "Roadmap" }, from: OPTIONS.from, to: { id: to, name: to, personal: false }, gains: [{ subject: { type: "team", name: "Design team" }, before: null, after: role("editor", "Editor") }],
  keeps: [{ subject: { type: "user", id: "u", name: "Ada" }, self: true, before: role("owner", "Owner"), after: role("owner", "Owner") }], loses: [], invites: 2, links: 1, hidden: true, more: false });
const RESULT = { board: { id: "b-1", title: "Roadmap", space: { id: "s-2", name: "Design" } }, moved: true, undo: { space: { id: "s-1", name: "Mine", personal: true } } };
const port = (o = {}) => { const calls = []; return { calls, options: async () => o.options ?? { options: OPTIONS }, preview: async (b, to) => { calls.push(["preview", to]); return o.preview?.(to) ?? { diff: diff(to) }; },
  move: async (b, body, key) => { calls.push(["move", body, key]); return o.move?.(body) ?? { result: RESULT }; } }; };

test("diffText: the three sentences, you for self, invites and links under keeps, hidden as a note (no count)", () => {
  const t = diffText(diff("s-2"));
  expect(t.gains).toBe("Gains access: Design team (Editor).");
  expect(t.keeps).toBe("Keeps access: you (Owner), 2 invites, 1 link.");
  expect(t.loses).toBe("Loses access: nobody.");
  expect(t.notes).toEqual(["Some access comes from places you can't open."]);
});
test("a change of role reads 'Viewer to Editor'", () => {
  expect(diffText({ ...diff("s"), gains: [{ subject: { type: "user", name: "Max" }, before: role("viewer", "Viewer"), after: role("editor", "Editor") }] }).gains).toBe("Gains access: Max (Viewer to Editor).");
});
test("Move is off until the diff of the chosen Space has loaded; choosing loads it and says it once", async () => {
  const p = port(), m = createMoveModel({ move: p, board: "b-1", newKey: () => "k1" });
  await m.load();
  expect(m.state.status).toBe("ready");
  expect(m.canMove()).toBe(false);
  expect(await m.submit()).toBe(false);
  await m.choose("s-2");
  expect(m.canMove()).toBe(true);
  expect(m.state.said).toContain("Gains access: Design team (Editor).");
  await m.choose("not-listed");
  expect(p.calls.filter(c => c[0] === "preview").length).toBe(1);
});
test("a slow preview for an earlier pick is dropped", async () => {
  let release; const slow = new Promise(r => { release = r; });
  const p = port({ preview: to => (to === "s-2" ? slow.then(() => ({ diff: diff("s-2") })) : null) });
  const m = createMoveModel({ move: p, board: "b-1" });
  await m.load();
  const first = m.choose("s-2"); await m.choose("s-3");
  release(); await first;
  expect(m.state.to).toBe("s-3"); expect(m.state.diff.data.to.id).toBe("s-3");
});
test("submit sends from and to under one key, reused by a retry; a success forgets it", async () => {
  let fail = true;
  const p = port({ move: () => (fail ? { error: "unavailable" } : null) });
  const m = createMoveModel({ move: p, board: "b-1", newKey: (n => () => "key-" + ++n)(0) });
  await m.load(); await m.choose("s-2");
  expect(await m.submit()).toBe(false);
  expect(m.state.notice).toContain("Trying again unchanged is safe");
  fail = false;
  expect(await m.submit()).toBe(true);
  expect(p.calls.filter(c => c[0] === "move").map(c => [c[1], c[2]])).toEqual([[{ from: "s-1", to: "s-2" }, "key-1"], [{ from: "s-1", to: "s-2" }, "key-1"]]);
  expect(m.state.said).toBe("Moved Roadmap to Design.");
});
test("a hidden source cannot be moved from here", async () => {
  const h = createMoveModel({ move: port({ options: { options: { ...OPTIONS, from: { hidden: true } } } }), board: "b-1" }); await h.load(); await h.choose("s-2");
  expect(await h.submit()).toBe(false); expect(h.state.notice).toContain("not one you can open");
});
test("load outcomes: forbidden, notfound, auth, and a server error each have a status", async () => {
  for (const [error, status] of [["forbidden", "forbidden"], ["notfound", "notfound"], ["auth", "signed-out"], ["unavailable", "error"]]) {
    const m = createMoveModel({ move: { options: async () => ({ error }) }, board: "b" }); await m.load(); expect(m.state.status).toBe(status);
  }
});
test("undo: a move back from the new Space to the old under its own key; moved and forbidden have their sentences; none when not offered", async () => {
  const calls = []; let out = { result: RESULT };
  const mv = { move: async (b, body, key) => { calls.push([body, key]); return out; } };
  const u = createUndo({ move: mv, board: "b-1", result: RESULT, newKey: () => "undo-key" });
  expect((await u.run()).text).toBe("Moved Roadmap back to Mine.");
  expect(calls).toEqual([[{ from: "s-2", to: "s-1" }, "undo-key"]]);
  out = { error: "moved" }; expect((await u.run()).text).toBe("Can't undo: the board has been moved again.");
  out = { error: "forbidden" }; expect((await u.run()).text).toBe("You can no longer put this board back in Mine.");
  out = { error: "network" }; expect((await u.run()).ok).toBe(false);
  expect(createUndo({ move: mv, board: "b-1", result: { ...RESULT, undo: null } }).available).toBe(false);
  expect(movedText("", "X")).toBe("Moved Untitled to X.");
});

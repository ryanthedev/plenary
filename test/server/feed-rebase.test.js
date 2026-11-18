// server/feed.js: after the feed looks for a room checkpoint and misses (the room writes it just after it publishes the entries),
// it must keep looking on later heartbeats until the checkpoint exists. A single retry that lands before the checkpoint
// used to be the last look, and the feed then served a long tail instead of the folded snapshot until enough new entries came.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { boardFeed } from "../../server/feed.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { tempDir, cleanup } from "./helpers.js";

afterAll(cleanup);
const T = "t-feed", B = "b-feed";

test("a rebase look that finds no checkpoint is retried on every later heartbeat, and succeeds once the checkpoint exists", async () => {
  const store = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await store.acquire(T, B, "h-feed", 60_000);
  const entry = n => ({ seq: n, board: B, tenant: T, stream: "board", op: { elements: [{ id: "e" + n, type: "rectangle", version: 1, versionNonce: 1, x: n, y: 0, width: 1, height: 1, isDeleted: false }] }, by: "u", id: `c:${n}`, at: 1000 + n, rv: 1 });
  await store.append(T, B, [entry(1), entry(2), entry(3)], 0, epoch);
  const feed = boardFeed({ tenant: T, board: B, store, bus, onLive() {}, rebaseEvery: 2 });
  const settle = async () => { await bus.flush(); await feed.atomically(() => {}); };
  const beat = async () => { await bus.publish(subjects.entries(T, B), { seq: 3, epoch }); await settle(); };
  try {
    await feed.ready;
    expect(feed.base.seq).toBe(0);
    await beat();                                    // the look the entries cause: no checkpoint yet (the room writes it just after)
    await beat();                                    // the first heartbeat after it: still none (it lands before the room's checkpoint)
    await beat();                                    // and one more
    expect(feed.base.seq).toBe(0);
    const [e3] = await store.read(T, B, 3, 1);
    const emptyBoard = { elements: [], appState: {} };
    await store.putCheckpoint(T, B, { seq: 3, id: e3.id, by: e3.by, at: e3.at, streams: { board: emptyBoard, notes: emptyBoard }, appSeq: { board: {}, notes: {} }, records: { threads: [] }, clients: { horizon: 0, list: [] } }, epoch);
    await beat();                                    // the checkpoint exists now: the next heartbeat finds it
    expect(feed.base.seq).toBe(3);
    expect(feed.tail.length).toBe(0);
  } finally { feed.close(); await store.close(); await bus.close(); }
});

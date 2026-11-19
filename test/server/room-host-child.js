// A child process for room-host-proc.test.js: one room host on Postgres + NATS holding a board, so the test can
// kill -9 or SIGSTOP a real holder. argv: holder ttlMs schema. Prints "OPEN <epoch>" once it holds the board.
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { natsBus } from "../../server/bus/nats.js";
import { createLogger } from "../../server/log.js";

const log = createLogger({ write: l => { if (/stopped|lost|fenced|opened/.test(l)) console.error("CHILD", l.slice(0, 200)); } });
const [holder, ttl, schema] = process.argv.slice(2);
const store = await postgresStore({ url: process.env.DATABASE_URL, schema, max: 3 });
const bus = await natsBus({ url: process.env.NATS_URL, cluster: null });
const h = roomHost({ store, bus, holder, log, leaseTtlMs: Number(ttl), heartbeatMs: 200 });
await h.open("t-aaa", "b-one");
const p = await h.peek("t-aaa", "b-one");
console.log(`OPEN ${p ? p.epoch : "none"}`);
setInterval(() => {}, 1000);

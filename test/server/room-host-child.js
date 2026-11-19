// A child process for room-host-proc.test.js: one room host on Postgres + NATS holding a board, so the test can
// kill -9 or SIGSTOP a real holder. argv: holder ttlMs schema [gatewayId]. Prints "OPEN <epoch>" once it holds the board.
// With a gatewayId: after it logs "room stopped: lease lost" it lets two macrotask turns pass, then publishes `{ conn: "__sentinel" }` on that gateway's
// subject over its own bus connection. Same publisher, same subject, in order: whatever the stopped host sent to the gateway lands before the sentinel.
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { natsBus, subjects } from "../../server/bus/nats.js";
import { createLogger } from "../../server/log.js";

const [holder, ttl, schema, gatewayId] = process.argv.slice(2);
let bus;   // set below; the logger only fires after the host exists
const turn = () => new Promise(r => setTimeout(r, 0));
const log = createLogger({ write: l => {
  if (!/stopped|lost|fenced|opened/.test(l)) return;
  console.error("CHILD", l.slice(0, 200));
  if (gatewayId && /room stopped: lease lost/.test(l)) turn().then(turn).then(() => bus.publish(subjects.gateway(gatewayId), { conn: "__sentinel" })).catch(() => {});
} });
const store = await postgresStore({ url: process.env.DATABASE_URL, schema, max: 3 });
bus = await natsBus({ url: process.env.NATS_URL, cluster: null });
const h = roomHost({ store, bus, holder, log, leaseTtlMs: Number(ttl), heartbeatMs: 200 });
await h.open("t-aaa", "b-one");
const p = await h.peek("t-aaa", "b-one");
console.log(`OPEN ${p ? p.epoch : "none"}`);
setInterval(() => {}, 1000);

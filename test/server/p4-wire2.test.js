// p4-wire2: the p4-wire verifier's findings, one block each.
//   M1 NATS credentials in NATS_URL reach the client as options; L1 redact()'s missing URL forms; L2 every log line
//   after the start is redacted; L3 the sweep keeps `welcomed` equal to live welcomed conns; L4 a late `watching`
//   resolves at the grace's end; L5 a stale publish rejection leaves a newer open alone; L6 node ids; L7 empty URLs.
// Every secret here is fake. The live NATS-auth test runs only when nats-server is on PATH (its own server, port -1).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { start, redact, urlSecrets, nodeConfig, defaultNodeId } from "../../server/main.js";
import { natsBus, natsConnectOptions } from "../../server/bus/nats.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { roomHost, remoteRooms } from "../../server/room-host.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { cleanup, tempDir, sleep, until, deferred, spawnTracked } from "./helpers.js";

afterAll(cleanup);

const PW = "Hunter2-FAKE-pw", TOK = "Tok3n-FAKE-nats";
const KEY = { COOKIE_KEY: "k".repeat(32) };
const PG = `postgres://plen:${PW}@127.0.0.1:1/plenary`;

/** start(env) that must be refused; returns the error and the captured lines. */
async function refusedStart(env, deps = {}) {
  const lines = [];
  let err = null;
  try { const app = await start({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "debug", ...env }, { write: l => lines.push(l), ...deps }); await app.stop(); }
  catch (e) { err = e; }
  expect(err).not.toBe(null);
  return { err, lines };
}
const leakFree = (texts, secrets) => { for (const t of texts) for (const s of secrets) expect(t).not.toContain(s); };

// ---- M1: NATS credentials ----

test("M1: natsConnectOptions takes user:pass@ and token@ out of each server, decoded; the servers go on without them", () => {
  expect(natsConnectOptions(`nats://plen:${encodeURIComponent("p@ss/w:rd")}@127.0.0.1:4222`))
    .toEqual({ servers: ["nats://127.0.0.1:4222"], user: "plen", pass: "p@ss/w:rd" });
  expect(natsConnectOptions(`nats://${TOK}@nats:4222`)).toEqual({ servers: ["nats://nats:4222"], token: TOK });
  expect(natsConnectOptions(`tls://a:${PW}@h1:4222, nats://a:${PW}@h2:4222`)).toEqual({ servers: ["tls://h1:4222", "nats://h2:4222"], user: "a", pass: PW });
  expect(natsConnectOptions([`a:${PW}@h1:1`, "h2:2"])).toEqual({ servers: ["h1:1", "h2:2"], user: "a", pass: PW });
  expect(natsConnectOptions("nats://nats:4222")).toEqual({ servers: ["nats://nats:4222"] });
  expect(natsConnectOptions("nats://@nats:4222")).toEqual({ servers: ["nats://nats:4222"] });
  // Refusals name no value.
  for (const bad of [`nats://a:${PW}@h1,nats://a:x${PW}@h2`, `nats://a:${PW}@h1,nats://${TOK}@h2`, `nats://:${PW}@h`, `nats://${TOK}@`]) {
    let err = null; try { natsConnectOptions(bad); } catch (e) { err = e; }
    expect(err?.code).toBe("bad-config");
    leakFree([err.message, String(err.stack)], [PW, TOK, "h1", "h2"]);
  }
  expect(() => natsConnectOptions(" , ")).toThrow(TypeError);
});

/** A connect that records its options and refuses like an auth-protected server would. */
const refusingConnect = seen => async opts => { seen.push(opts); const e = new Error("Authorization Violation"); e.code = "AUTHORIZATION_VIOLATION"; throw e; };

test("M1: natsBus hands the client user/pass (or token) as options, never inside `servers`", async () => {
  for (const [url, want] of [[`nats://plen:${PW}@127.0.0.1:1`, { user: "plen", pass: PW }], [`nats://${TOK}@127.0.0.1:1`, { token: TOK }]]) {
    const seen = [];
    await expect(natsBus({ url, name: "n-1", connect: refusingConnect(seen) })).rejects.toThrow("Authorization Violation");
    expect(seen[0]).toMatchObject({ ...want, servers: ["nats://127.0.0.1:1"], name: "n-1" });
    leakFree([JSON.stringify(seen[0].servers)], [PW, TOK]);
  }
});

test("M1 through start(): the credentials reach the NATS client's options; the refusal and every line are free of them", async () => {
  for (const nats of [`nats://plen:${PW}@127.0.0.1:1`, `nats://${TOK}@127.0.0.1:1`]) {
    const seen = [];
    const adapters = {
      postgresStore: async () => ({ ...sqliteStore({ path: join(tempDir(), "p.db") }), clusterId: async () => "c-aaaaaaaaaaaaaaaa" }),
      postgresRegistry: async () => sqliteRegistry({ path: join(tempDir(), "r.db") }),
      natsBus: o => natsBus({ ...o, connect: refusingConnect(seen) }),
    };
    const { err, lines } = await refusedStart({ DATABASE_URL: PG, NATS_URL: nats, ...KEY }, { adapters });
    expect(err.message).toMatch(/^could not open the NATS bus \(NATS_URL\)/);
    expect(seen.length).toBe(1);
    expect(seen[0].pass ?? seen[0].token).toBe(nats.includes(TOK) ? TOK : PW);
    leakFree([err.message, String(err), err.stack ?? "", ...lines], [PW, TOK]);
  }
});

// A real nats-server with auth (user/pass, then a token), only when one is installed. Port -1 = a free port.
const natsServer = Bun.which("nats-server");
const liveNats = natsServer ? test : test.skip;
async function authServer(auth) {
  const dir = tempDir("plenary-nats-auth-");
  const conf = join(dir, "nats.conf"), log = join(dir, "nats.log");
  writeFileSync(conf, `listen: "127.0.0.1:-1"\nmax_payload: 2MB\nauthorization { ${auth} }\n`);
  const child = spawnTracked([natsServer, "-c", conf, "-l", log], { stdout: "ignore", stderr: "ignore" });
  let port;
  try {
    port = await until(async () => {
      const text = await Bun.file(log).text().catch(() => "");
      return Number(/Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(text)?.[1]) || null;
    }, "nats-server's port", 5000);
  } catch (err) { child.kill(); await child.exited; throw err; }   // never leave it running
  return { port, stop: async () => { child.kill(); await child.exited; } };
}
liveNats("M1 live: a NATS with user/password and one with a token both accept the URL's credentials; a wrong one is refused without echoing it", async () => {
  for (const [auth, good, bad] of [
    [`user: plen, password: "${PW}"`, p => `nats://plen:${PW}@127.0.0.1:${p}`, p => `nats://plen:x${PW}@127.0.0.1:${p}`],
    [`token: "${TOK}"`, p => `nats://${TOK}@127.0.0.1:${p}`, p => `nats://x${TOK}@127.0.0.1:${p}`],
  ]) {
    const srv = await authServer(auth);
    try {
      const bus = await natsBus({ url: good(srv.port), connectTimeoutMs: 2000 });
      const got = [];
      bus.subscribe("plen.t-a.b-1.entries", m => got.push(m));
      await bus.flush();
      await bus.publish("plen.t-a.b-1.entries", { seq: 1 });
      await until(() => got.length === 1, "the message back");
      await bus.close();
      let err = null;
      try { const b = await natsBus({ url: bad(srv.port), connectTimeoutMs: 2000 }); await b.close(); } catch (e) { err = e; }
      expect(err).not.toBe(null);
      leakFree([String(err?.message), String(err?.stack)], [PW, TOK]);
    } finally { await srv.stop(); }
  }
}, 30000);

// ---- L1: redact() ----

test("L1: redact() removes a query-string secret, a bare-token userinfo, and each element of a comma list", () => {
  const q = `postgres://u@h/db?sslmode=disable&password=${encodeURIComponent("Q@ss-FAKE")}&x_token=T0k-FAKE&apikey=K3y-FAKE`;
  const out = redact(`err: password=Q@ss-FAKE ${encodeURIComponent("Q@ss-FAKE")} T0k-FAKE K3y-FAKE sslmode=disable`, [q]);
  for (const s of ["Q@ss-FAKE", encodeURIComponent("Q@ss-FAKE"), "T0k-FAKE", "K3y-FAKE"]) expect(out).not.toContain(s);
  expect(out).toContain("sslmode=disable");           // not a secret parameter
  expect(redact(`auth ${TOK} failed`, [`nats://${TOK}@h:4222`])).toBe("auth *** failed");
  const list = `nats://a:p1-FAKE@h1:1,nats://b:${PW}@h2:2`;
  expect(redact(`h2 said ${PW}; b:${PW}`, [list])).not.toContain(PW);
  // A raw comma inside a password is still one secret (the whole value is read too, not only its elements).
  expect(redact('password "pa,ss-FAKE" refused', ["postgres://u:pa,ss-FAKE@h/db"])).toBe('password "***" refused');
  // A bare postgres userinfo is a user name, not a secret: "postgres" stays readable outside the URL.
  expect(redact("postgres says no", ["postgres://postgres@127.0.0.1:5/plenary"])).toBe("postgres says no");
  // On a JSON line, the userinfo rule stops at a quote: it never eats from a URL to a later "@".
  expect(redact('{"a":"nats://h:1","b":"ann@x"}', [])).toBe('{"a":"nats://h:1","b":"ann@x"}');
});

test("L1: whatever natsConnectOptions sends as pass or token, urlSecrets names (both read the same userinfo)", () => {
  for (const url of [`nats://u:${encodeURIComponent("a@b:c%d")}@h:1`, `nats://${encodeURIComponent("t@k%")}@h:1`, `h1:1,u:${PW}@h2:2`]) {
    const o = natsConnectOptions(url), secrets = urlSecrets(url);
    for (const s of [o.pass, o.token].filter(Boolean)) expect(secrets).toContain(s);
  }
});

// ---- L2: every line after the start ----

/** Cluster adapters on SQLite and the memory bus, with a store whose acquire throws an error carrying the secrets. */
function leakyAdapters(state) {
  const leak = () => { const e = new Error(`acquire failed on ${PG} (${PW})`); e.code = `CODE_${PW}`; e.cause = new Error(`cause ${PW}`); return e; };
  return {
    postgresStore: async () => { const s = sqliteStore({ path: join(tempDir(), "p.db") }); return { ...s, clusterId: async () => "c-aaaaaaaaaaaaaaaa", acquire: async () => { throw leak(); } }; },
    postgresRegistry: async () => sqliteRegistry({ path: join(tempDir(), "r.db") }),
    natsBus: async o => { state.onError = o.onError; state.bus = memoryBus({ onError: o.onError, cluster: o.cluster }); return state.bus; },
    leak,
  };
}

test("L2: the bus onError line and room-host's remote-open failure line carry no secret (message, code, cause, stack)", async () => {
  const state = {}, lines = [];
  const adapters = leakyAdapters(state);
  const app = await start({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "debug", DATABASE_URL: PG, NATS_URL: `nats://plen:${PW}@127.0.0.1:1`, ...KEY },
    { write: l => lines.push(l), adapters });
  try {
    state.onError(adapters.leak(), "plen.t-a.b-1.entries");
    // A remote open (as a gateway-only node would send) makes room-host's open throw the leaky error.
    state.bus.publish(subjects.open, { tenant: "t-aaa", board: "b-one", gateway: "r-gw-1", n: 1 });
    await until(() => lines.some(l => l.includes("remote open failed here")), "room-host's failure line");
    const bus = lines.find(l => l.includes('"bus error"'));
    expect(bus).toBeDefined();
    expect(JSON.parse(bus).err.code).toBe("CODE_***");
    leakFree(lines, [PW, "127.0.0.1:1/plenary"]);
  } finally { await app.stop(); }
});

// ---- L3: the sweep path of R2-L1 ----

test("L3: a gateway silent past 30 s (injected clock) loses its connections in the sweep, and `welcomed` shrinks with them", async () => {
  const T = "t-aaa", B = "b-one";
  let clock = 1_000_000;
  const bus = memoryBus(), store = sqliteStore({ path: join(tempDir(), "plenary.db") });
  const host = roomHost({ store, bus, leaseTtlMs: 30_000, sweepMs: 20, now: () => clock });
  const got = [];
  const gw = id => {
    let n = 0;
    bus.subscribe(subjects.gateway(id), m => got.push({ gw: id, conn: m.conn, msg: m.data ? JSON.parse(m.data) : null }));
    return {
      hello: (conn, client) => bus.publish(subjects.inbox(T, B), { n: 1, conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg: { t: "hello", v: PROTOCOL_VERSION, board: B, client } }),
      list: conns => bus.publish(subjects.inbox(T, B), { gateway: id, conns, n: ++n }),
    };
  };
  try {
    await host.open(T, B);
    const g1 = gw("g-1"), g2 = gw("g-2");
    const c1 = Array.from({ length: 40 }, (_, i) => `a-${i}`), c2 = Array.from({ length: 60 }, (_, i) => `b-${i}`);
    for (const c of c1) g1.hello(c, "k" + c);
    for (const c of c2) g2.hello(c, "k" + c);
    await until(() => got.filter(m => m.msg?.t === "welcome").length === 100, "100 welcomes", 10000);
    expect(await host.peek(T, B)).toMatchObject({ conns: 100, welcomed: 100 });
    // 29 s pass on the rooms' clock; g-1 speaks (a listing of all its connections), g-2 stays silent; 2 s more.
    // g-1 is heard before anyone is past 30 s, so whichever sweep runs, only g-2 is silent.
    clock += 29_000;
    await g1.list(c1);
    await host.idle(T, B);
    expect(await host.peek(T, B)).toMatchObject({ conns: 100, welcomed: 100 });
    clock += 2_000;
    await sleep(100);   // a few sweeps
    const p = await host.peek(T, B);
    expect([p.conns, p.welcomed]).toEqual([40, 40]);
  } finally { await host.close(); await store.close(); await bus.close(); }
}, 20000);

// ---- L4 and L5: remoteRooms on a fake clock ----

function fakeTimers() {
  let now = 0, id = 0;
  const due = new Map();
  return {
    setTimeout(fn, ms) { const t = ++id; due.set(t, { at: now + ms, fn }); return t; },
    clearTimeout(t) { due.delete(t); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].fn();
        await Promise.resolve();
      }
      now = end;
      await sleep(0);
    },
  };
}
const watch = p => { const s = { state: "pending" }; p.then(v => { s.state = "resolved"; s.value = v; }, e => { s.state = "rejected"; s.err = e; }); return s; };

test("L4: a `watching` answer late in the ttl resolves at the grace's end, not `unavailable` at the ttl", async () => {
  const bus = memoryBus(), timers = fakeTimers(), asked = [];
  bus.subscribe(subjects.open, m => asked.push(m));
  const rooms = remoteRooms({ bus, node: "gw-1", timeoutMs: 800, timers });
  try {
    expect(rooms.graceMs).toBe(200);
    const s = watch(rooms.open("t-aaa", "b-one"));
    await until(() => asked.length === 1, "the request");
    await timers.advance(750);
    await bus.publish(subjects.opened(rooms.requester), { n: asked[0].n, board: "b-one", state: "watching" });
    await bus.flush(); await sleep(0);
    await timers.advance(50);                   // t = 800: the ttl, inside the grace
    expect(s.state).toBe("pending");
    await timers.advance(149);                  // t = 949
    expect(s.state).toBe("pending");
    await timers.advance(1);                    // t = 950: the grace's end
    expect(s).toMatchObject({ state: "resolved", value: "watching" });
    // With no answer at all, the ttl still rejects.
    const none = watch(rooms.open("t-aaa", "b-two"));
    await timers.advance(800);
    expect(none.state).toBe("rejected");
    expect(none.err.code).toBe("unavailable");
  } finally { await rooms.close(); await bus.close(); }
});

test("L5: a late publish rejection of an old request leaves the newer request for the same board pending", async () => {
  const mem = memoryBus(), timers = fakeTimers(), sends = [];
  const bus = { ...mem, subscribe: mem.subscribe, publish: (subject, msg) => {
    if (subject !== subjects.open) return mem.publish(subject, msg);
    const d = deferred(); sends.push({ msg, d }); return d.promise;
  } };
  const rooms = remoteRooms({ bus, node: "gw-1", timeoutMs: 5000, timers });
  try {
    const first = watch(rooms.open("t-aaa", "b-one"));
    await until(() => sends.length === 1, "request 1");
    await mem.publish(subjects.opened(rooms.requester), { n: sends[0].msg.n, board: "b-one", state: "held" });
    await until(() => first.state === "resolved", "request 1 held");
    const second = watch(rooms.open("t-aaa", "b-one"));
    await until(() => sends.length === 2, "request 2");
    sends[0].d.reject(new Error("late failure of request 1"));
    await sleep(5);
    expect(second.state).toBe("pending");
    await mem.publish(subjects.opened(rooms.requester), { n: sends[1].msg.n, board: "b-one", state: "held" });
    await until(() => second.state === "resolved", "request 2 held");
    // Its own rejection still settles a request.
    const third = watch(rooms.open("t-aaa", "b-one"));
    await until(() => sends.length === 3, "request 3");
    sends[2].d.reject(new Error("send failed"));
    await until(() => third.state === "rejected", "request 3 rejected");
    expect(third.err.code).toBe("unavailable");
  } finally { await rooms.close(); await mem.close(); }
});

// ---- L6 and L7: env ----

test("L6: PLENARY_NODE_ID needs a letter or digit at both ends; the default never has a dash at either end", async () => {
  for (const bad of ["-", "---", "-a", "a-", "-a-"]) {
    const { err } = await refusedStart({ PLENARY_NODE_ID: bad });
    expect(err.message).toMatch(/^PLENARY_NODE_ID .*letter or digit/);
  }
  for (const ok of ["a", "0", "a-b", "gw-1", "host-1", "x".repeat(32), "a--b"]) expect(nodeConfig({ PLENARY_NODE_ID: ok }).node).toBe(ok);
  expect(defaultNodeId("-")).toBe("node");
  expect(defaultNodeId(".web.")).toBe("web");
  expect(defaultNodeId("a".repeat(31) + ".b")).toBe("a".repeat(31));
});

test("L7: DATABASE_URL or NATS_URL set but empty (or blank) refuses the start, naming the variable", async () => {
  for (const [env, name] of [
    [{ DATABASE_URL: "", NATS_URL: "" }, "DATABASE_URL"],
    [{ DATABASE_URL: "" }, "DATABASE_URL"],
    [{ NATS_URL: " " }, "NATS_URL"],
    [{ DATABASE_URL: PG, NATS_URL: "", ...KEY }, "NATS_URL"],
  ]) {
    const { err, lines } = await refusedStart(env);
    expect(err.message).toBe(`${name} is set but empty: unset it for a single node, or give the URL for a cluster`);
    leakFree([err.message, ...lines], [PW]);
  }
  expect(nodeConfig({}).cluster).toBe(false);   // unset is still a single node
});

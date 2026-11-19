// scripts/cluster-rig.js against real Postgres 17, NATS and Caddy, with stub nodes (test/deploy/stub-node.js) in
// place of server/main.js. Each guard has a test that fails without it (docs/m2/reports/p8-rig.md lists the mutations):
// only-ours teardown, crash-midway cleanup (in-process and a SIGKILLed CLI `up`), secrets never printed; and from p8-rig2
// (docs/m2/reports/p8-rig2.md): identity independent of TZ/locale, a copied rig.json written in place, loopback binding,
// SIGKILL escalation, the health-wait timeout, secrets absent from logs/; and from p8-rig3 (docs/m2/reports/p8-rig3.md):
// a failing ps refuses instead of reading as "gone", one `up` per dir (lock), a moved rig's paths, the real main.js e2e.
import { test, expect, afterAll, describe } from "bun:test";
import { rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { stopRig, rigStatus, killNode, readRig, isOurs, psInfo, TERMINAL_SIGNALS, STARTED_CLOCK, portFree, missingBins, _setPsPath, _setIpcPaths, _setLockHook, pgShmOf, removeOrphanShm, parseIpcsSegments, s3Env, parseArgs } from "../../scripts/cluster-rig.js";
import { freshDir, track, rigUp as startRig, spawnTracked, cleanupAll, CLEANUP_TIMEOUT_MS, killRecorded, namingDir } from "./rig-guard.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const RIG = join(ROOT, "scripts/cluster-rig.js");
const STUB = join(ROOT, "test/deploy/stub-node.js");
const stub = (...args) => [process.execPath, STUB, ...args];
const missing = missingBins();
const SKIP = missing.length > 0;
if (SKIP) console.warn(`cluster-rig tests skipped: missing ${missing.join(", ")} (brew install postgresql@17 nats-server minio caddy)`);

// Stop anything a failed, timed-out or killed test left (recorded PIDs only; test/deploy/rig-guard.js), then remove only
// the dirs this file created. Every in-process `up` here is rig-guard's rigUp (shared abort), every child is tracked.
afterAll(() => cleanupAll(), CLEANUP_TIMEOUT_MS);

const portsOf = rig => [rig.postgres?.port, rig.nats?.port, rig.nats?.monitorPort, Number(new URL(rig.blobs?.url ?? "http://127.0.0.1:0").port), rig.blobs?.consolePort, rig.lb?.port, ...rig.nodes.map(n => n.port)].filter(Boolean);
// The test's own identity check, independent of the module's: lstart under a fixed TZ and locale.
const PS_FIXED = { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" };
const lstartIn = (pid, env) => {   // "" when there is no such process; throws when ps itself fails (never a silent "")
  const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { env });
  const out = r.stdout.toString().trim(), err = r.stderr.toString().trim();
  if (r.exitCode === 1 && !out && !err) return "";
  if (r.exitCode !== 0 || !out) throw new Error(`/bin/ps failed for pid ${pid} (exit ${r.exitCode}, signal ${r.signalCode ?? "none"}): ${err}`);
  return out.replace(/\s+/g, " ");
};
const lstart = pid => lstartIn(pid, PS_FIXED);
const CLOCK = "lstart TZ=UTC LC_ALL=C";

test("gc parser only selects unattached SysV segments owned by the current user", () => {
  const output = `------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status\n0x00000001 123        alice      600        4096       0\n0x00000002 124        alice      600        4096       2\n0x00000003 125        bob        600        4096       0\n`;
  expect(parseIpcsSegments(output, "alice")).toEqual([{ id: 123, owner: "alice", nattch: 0 }]);
  const macOutput = `T     ID     KEY        MODE       OWNER    GROUP NATTCH\nm 126 0x00000004 600 alice staff 0\nm 127 0x00000005 600 alice staff 1\n`;
  expect(parseIpcsSegments(macOutput, "alice")).toEqual([{ id: 126, owner: "alice", nattch: 0 }]);
});

test("S3 environment output includes every setting consumed by the blob adapter", () => {
  expect(s3Env({ blobs: { url: "http://127.0.0.1:9000", bucket: "plenary", accessKey: "local-key", secretKey: "local-secret" } })).toEqual([
    "S3_ENDPOINT=http://127.0.0.1:9000", "S3_BUCKET=plenary", "S3_REGION=us-east-1",
    "S3_ACCESS_KEY_ID=local-key", "S3_SECRET_ACCESS_KEY=local-secret",
  ]);
});

test("rig CLI parses down-all and clean as independent flags", () => {
  expect(parseArgs(["down", "--all", "--clean"])).toEqual({ _: ["down"], all: true, clean: true });
});
// rig-tools-v5 audit: psInfo's ps shares its caller's process group, so a terminal Ctrl-C kills it too. `down` ignores
// those signals and must still finish, so a ps killed by SIGINT, SIGTERM or SIGHUP is run again (bounded); any other
// failure still refuses at once. Stub ps scripts count their runs in <stub>.count.
describe("psInfo: a ps killed by a terminal signal is run again", () => {
  const stubs = freshDir();
  const runs = f => existsSync(`${f}.count`) ? readFileSync(`${f}.count`, "utf8").split("\n").filter(Boolean).length : 0;
  /** A ps that kills itself with `sig` on the runs `when` (shell test on $n, the run number) and is /bin/ps otherwise. */
  const ps = (name, sig, when) => {
    const f = join(stubs, name);
    writeFileSync(f, `#!/bin/sh\necho x >> "$0.count"\nn=$(wc -l < "$0.count")\nif ${when}; then kill -${sig.replace(/^SIG/, "")} $$; fi\nexec /bin/ps "$@"\n`);
    chmodSync(f, 0o755);
    return f;
  };
  for (const sig of TERMINAL_SIGNALS) test(`${sig} on the first two runs: the third answers`, () => {
    const f = ps(`twice-${sig}`, sig, '[ "$n" -le 2 ]');
    try { _setPsPath(f); expect(psInfo(process.pid)).toEqual({ started: lstart(process.pid) }); } finally { _setPsPath(); }
    expect(runs(f)).toBe(3);
  });
  test("SIGINT on every run: refuses with the signal after 5 runs, never reads as gone", () => {
    const f = ps("always-int", "SIGINT", "true");
    try { _setPsPath(f); expect(() => psInfo(process.pid)).toThrow(/^cannot check processes: .* was killed by SIGINT/); } finally { _setPsPath(); }
    expect(runs(f)).toBe(5);
  });
  test("SIGKILL is not a terminal signal: refuses after one run", () => {
    const f = ps("kill9", "SIGKILL", "true");
    try { _setPsPath(f); expect(() => psInfo(process.pid)).toThrow(/was killed by SIGKILL/); } finally { _setPsPath(); }
    expect(runs(f)).toBe(1);
  });
  test("down (stopRig) finishes when every other ps it runs is killed by SIGINT: the service is stopped", async () => {
    const f = ps("odd-int", "SIGINT", '[ $((n % 2)) -eq 1 ]');
    const dir = freshDir(), svc = Bun.spawn(["/bin/sleep", "300"]);
    try {
      writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "sleep", dir, startedClock: STARTED_CLOCK, state: "up", nodes: [],
        procs: [{ name: "sleep", pid: svc.pid, started: lstart(svc.pid) }] }) + "\n");
      _setPsPath(f);
      const r = await stopRig(dir, { graceMs: 5000 });
      expect(r.stopped).toEqual(["sleep"]);
      expect(r.forced).toEqual([]);
      expect(await svc.exited).toBe(143);   // our SIGTERM
      expect(runs(f)).toBeGreaterThanOrEqual(4);   // several checks, each killed once
    } finally { _setPsPath(); try { svc.kill("SIGKILL"); } catch {} }
  });
});

/** An in-range PID that no process has right now: a child that has exited and been reaped. */
const reapedPid = async () => { const p = Bun.spawn(["true"]); await p.exited; return p.pid; };
const psGone = pid => {   // a failed ps throws: it never reads as "gone"
  const r = Bun.spawnSync(["/bin/ps", "-o", "pid=", "-p", String(pid)]);
  const out = r.stdout.toString().trim(), err = r.stderr.toString().trim();
  if (r.exitCode === 1 && !out && !err) return true;
  if (r.exitCode !== 0 || !out) throw new Error(`/bin/ps failed for pid ${pid} (exit ${r.exitCode}, signal ${r.signalCode ?? "none"}): ${err}`);
  return false;
};
async function expectAllDown(rig) {
  // An in-process rig's children are this process's: a stopped one may show as a zombie until Bun reaps it (ms).
  for (const p of rig.procs) {
    expect({ name: p.name, ours: isOurs(p) }).toEqual({ name: p.name, ours: false });
    for (let i = 0; i < 40 && !psGone(p.pid); i++) await Bun.sleep(50);
    expect({ name: p.name, gone: psGone(p.pid) }).toEqual({ name: p.name, gone: true });
  }
  for (const port of portsOf(rig)) expect({ port, free: portFree(port) }).toEqual({ port, free: true });
}
const wsFirst = url => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  const t = setTimeout(() => { ws.close(); rej(new Error("ws timeout")); }, 5000);
  ws.onmessage = e => { const hello = JSON.parse(e.data); ws.onmessage = e2 => { clearTimeout(t); ws.close(); res({ hello, echo: JSON.parse(e2.data) }); }; ws.send("ping"); };
  ws.onerror = () => { clearTimeout(t); rej(new Error("ws error")); };
});
async function cli(args, { timeout = 90_000, env = {} } = {}) {
  const p = spawnTracked([process.execPath, RIG, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  // SIGTERM first, so a stuck `up` still stops its own rig; SIGKILL only if it ignores that.
  const timer = setTimeout(() => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 20_000).unref(); }, timeout);
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  clearTimeout(timer);
  return { out, err, code };
}

describe.skipIf(SKIP)("cluster rig (real postgres, nats, caddy; stub nodes)", () => {
  test("up: env contract on every node, WebSocket through the LB reaches only gateways, kill one node, down frees every PID and port", async () => {
    const dir = freshDir();
    const rig = await startRig({ dir, nodeCmd: stub(), leaseTtlMs: 4321, timeoutMs: 60_000 });
    try {
      expect(rig.state).toBe("up");
      expect(rig.nodes.map(n => [n.id, n.roles.join(",")])).toEqual([["gw-1", "gateway"], ["gw-2", "gateway"], ["host-1", "host"]]);
      expect(rig.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio", "node:gw-1", "node:gw-2", "node:host-1", "caddy"]);
      expect(rig.blobs).toMatchObject({ bucket: "plenary", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), accessKey: expect.any(String), secretKey: expect.any(String) });

      // Every node got the contract env; the shared keys are the same everywhere; nothing else leaked in (.env, process.env).
      const infos = await Promise.all(rig.nodes.map(async n => (await fetch(n.url + "/info")).json()));
      const allowed = ["COOKIE_KEY", "DATABASE_URL", "HOME", "HOST", "LANG", "LOG_LEVEL", "NATS_URL", "PATH", "PLENARY_DATA_DIR", "PLENARY_DEV_TOKENS",
        "PLENARY_LEASE_TTL_MS", "PLENARY_MAX_CONNS_PER_USER", "PLENARY_NODE_ID", "PLENARY_ROLES", "PORT", "SESSION_KEY"];
      for (const [i, info] of infos.entries()) {
        const n = rig.nodes[i];
        expect(info).toMatchObject({ node: n.id, roles: n.roles, port: n.port, leaseTtlMs: 4321, databaseUrl: rig.postgres.url, natsUrl: rig.nats.url, dataDir: n.dataDir, maxConnsPerUser: 100000 });
        expect(info.envNames.filter(k => !allowed.includes(k) && !k.startsWith("__CF") && k !== "SHLVL" && k !== "PWD" && k !== "_" && k !== "OLDPWD")).toEqual([]);
        expect(info.cwd.startsWith(ROOT)).toBe(false);
        expect(info.cookieKeyHash).toBe(infos[0].cookieKeyHash);
        expect(info.sessionKeyHash).toBe(infos[0].sessionKeyHash);
        expect(info.cookieKeyHash).not.toBe(info.sessionKeyHash);
      }
      // DATABASE_URL reaches the rig's own database; NATS is up with 2 MB payloads.
      const sql = new Bun.SQL({ url: rig.postgres.url, max: 1 });
      try { expect((await sql`select current_database() as db`)[0].db).toBe("plenary"); } finally { await sql.close(); }
      const varz = await (await fetch(`http://127.0.0.1:${rig.nats.monitorPort}/varz`)).json();
      expect(varz.max_payload).toBe(2 * 1024 * 1024);

      // Loopback only (p8-rigv M2): every listening TCP socket of every recorded PID is on 127.0.0.1.
      const listening = [];
      for (const p of rig.procs) {
        const r = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(p.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
        for (const line of r.stdout.toString().split("\n")) if (line.startsWith("n")) listening.push({ name: p.name, addr: line.slice(1) });
      }
      expect(listening.length).toBe(10);   // minio also answers its API on [::1] (still loopback)
      expect(listening.filter(l => !l.addr.startsWith("127.0.0.1:") && !(l.name === "minio" && l.addr.startsWith("[::1]:")))).toEqual([]);
      expect(listening.map(l => l.name).sort()).toEqual(["caddy", "minio", "minio", "minio", "nats", "nats", "node:gw-1", "node:gw-2", "node:host-1", "postgres"]);
      { const pg = new Bun.SQL({ url: rig.postgres.url, max: 1 });
        try { expect((await pg.unsafe("show listen_addresses"))[0].listen_addresses).toBe("127.0.0.1"); } finally { await pg.close(); } }
      expect(varz.host).toBe("127.0.0.1");
      expect(varz.http_host).toBe("127.0.0.1");

      // WebSockets through Caddy: both gateways, never the host-only node, echo intact.
      const seen = new Set();
      for (let i = 0; i < 6; i++) { const r = await wsFirst(rig.lb.wsUrl); seen.add(r.hello.node); expect(r.echo).toEqual({ node: r.hello.node, echo: "ping" }); }
      expect([...seen].sort()).toEqual(["gw-1", "gw-2"]);

      // kill <node>: only that PID dies; the others stay up; the LB keeps working on the survivor.
      const killed = await killNode(dir, "gw-1");
      const st = rigStatus(dir);
      expect(st.nodes.map(n => [n.id, n.alive])).toEqual([["gw-1", false], ["gw-2", true], ["host-1", true]]);
      expect(killed.pid).toBe(st.nodes[0].pid);
      expect((await wsFirst(rig.lb.wsUrl)).hello.node).toBe("gw-2");
      await expect(killNode(dir, "gw-1")).rejects.toThrow(/not running/);
      await expect(killNode(dir, "nope")).rejects.toThrow(/no node/);
    } finally {
      const r = await stopRig(dir);
      expect(r.gone).toEqual(["node:gw-1"]);
    }
    const after = readRig(dir);
    expect(after.state).toBe("down");
    await expectAllDown(after);
  }, 90_000);

  test("up failing midway (the host node exits at once) stops everything that had started and throws", async () => {
    const dir = freshDir();
    let err = null;
    try { await startRig({ dir, nodeCmd: stub("--die-if-role=host"), timeoutMs: 60_000 }); } catch (e) { err = e; }
    expect(err?.message).toMatch(/node host-1: the process exited before it was ready/);
    const rig = readRig(dir);
    expect(rig.state).toBe("failed");
    expect(rig.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio", "node:gw-1", "node:gw-2", "node:host-1"]);
    expect(err.rig.procs.length).toBe(6);
    await expectAllDown(rig);
  }, 90_000);

  test("down and kill only signal a PID whose start time still matches rig.json (a reused PID is never ours)", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      const real = lstart(decoy.pid);
      const fake = { version: 1, name: "decoy", dir, startedClock: CLOCK, state: "up", nodes: [{ id: "gw-1", roles: ["gateway"], port: 1 }],
        procs: [{ name: "node:gw-1", pid: decoy.pid, started: "Mon Jan  1 00:00:00 2001", log: "/dev/null" }] };
      writeFileSync(join(dir, "rig.json"), JSON.stringify(fake));
      await expect(killNode(dir, "gw-1")).rejects.toThrow(/not running/);
      const r = await stopRig(dir, { graceMs: 500 });
      expect(r).toEqual({ stopped: [], gone: ["node:gw-1"], forced: [] });
      expect(decoy.killed || psGone(decoy.pid)).toBe(false);
      // Control: with the true start time the same record IS ours, and down stops it.
      writeFileSync(join(dir, "rig.json"), JSON.stringify({ ...fake, procs: [{ ...fake.procs[0], started: real }] }));
      expect((await stopRig(dir, { graceMs: 2000 })).stopped).toEqual(["node:gw-1"]);
      await decoy.exited;
      expect(psGone(decoy.pid)).toBe(true);
    } finally { decoy.kill("SIGKILL"); }
  }, 30_000);

  test("an older rig.json (no startedClock: local-time start times) is refused while a recorded PID exists; up never wipes it", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      // Recorded exactly as the old code did: lstart in the caller's TZ and locale.
      const local = lstartIn(decoy.pid, { PATH: process.env.PATH, TZ: "Asia/Kolkata", LC_ALL: "de_DE.UTF-8" });
      const old = { version: 1, name: "old", dir, state: "up", nodes: [{ id: "gw-1", roles: ["gateway"], port: 1 }],
        procs: [{ name: "node:gw-1", pid: decoy.pid, started: local, log: "/dev/null" }] };
      writeFileSync(join(dir, "rig.json"), JSON.stringify(old));
      mkdirSync(join(dir, "pg"));
      const before = readFileSync(join(dir, "rig.json"), "utf8");
      for (const call of [() => stopRig(dir, { graceMs: 200 }), () => killNode(dir, "gw-1"), async () => rigStatus(dir),
                          () => startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })])
        await expect(call()).rejects.toThrow(/older cluster-rig\.js.*cannot tell whether these processes belong to this rig: node:gw-1 \(pid \d+\)\. Check each one's start time and command with: LC_ALL=C TZ=UTC \/bin\/ps -o lstart=,command= -p <pid>\./);
      expect(readFileSync(join(dir, "rig.json"), "utf8")).toBe(before);
      expect(existsSync(join(dir, "pg"))).toBe(true);
      expect(psGone(decoy.pid)).toBe(false);
      // Once none of its PIDs exists, the old file is harmless: down marks it down.
      decoy.kill("SIGKILL"); await decoy.exited;
      expect((await stopRig(dir)).gone).toEqual(["node:gw-1"]);
    } finally { decoy.kill("SIGKILL"); }
  }, 30_000);

  test("a rig.json copied to another dir is read and written there; the original rig's file is never touched (p8-rigv M1)", async () => {
    const a = freshDir(), b = freshDir();
    const rigA = { version: 1, name: "a", dir: a, startedClock: CLOCK, state: "up", nodes: [{ id: "gw-1", roles: ["gateway"], port: 1 }],
      procs: [{ name: "node:gw-1", pid: await reapedPid(), started: "Thu Jan  1 00:00:00 2001", log: "/dev/null" }] };
    writeFileSync(join(a, "rig.json"), JSON.stringify(rigA));
    writeFileSync(join(b, "rig.json"), JSON.stringify(rigA));          // the copy still says dir: a
    const original = readFileSync(join(a, "rig.json"), "utf8");
    expect(rigStatus(b).dir).toBe(b);
    await expect(killNode(b, "gw-1")).rejects.toThrow(/not running/);
    await stopRig(b, { graceMs: 200 });
    expect(readFileSync(join(a, "rig.json"), "utf8")).toBe(original);
    expect(readRig(b)).toMatchObject({ dir: b, state: "down" });
  });

  test("down escalates to SIGKILL when a process ignores SIGTERM past the grace period", async () => {
    const dir = freshDir();
    const stubborn = Bun.spawn(["sh", "-c", "trap '' TERM; exec sleep 60"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(200);   // let sh exec sleep, keeping the PID and the ignored TERM
      const rig = { version: 1, name: "stubborn", dir, startedClock: CLOCK, state: "up", nodes: [],
        procs: [{ name: "node:gw-1", pid: stubborn.pid, started: lstart(stubborn.pid), log: "/dev/null" }] };
      writeFileSync(join(dir, "rig.json"), JSON.stringify(rig));
      const t0 = Date.now();
      const r = await stopRig(dir, { graceMs: 500 });
      expect(r).toEqual({ stopped: ["node:gw-1"], gone: [], forced: ["node:gw-1"] });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      expect(await stubborn.exited).toBe(137);   // reaped (it is this test's child), killed by SIGKILL
      expect(stubborn.signalCode).toBe("SIGKILL");
      expect(psGone(stubborn.pid)).toBe(true);
    } finally { stubborn.kill("SIGKILL"); }
  }, 30_000);

  test("up: a part that never becomes healthy fails with the timeout error, and everything started is stopped", async () => {
    const dir = freshDir();
    let err = null;
    try { await startRig({ dir, nodeCmd: ["sleep", "300"], timeoutMs: 5000 }); } catch (e) { err = e; }
    expect(err?.message).toMatch(/not ready after the timeout \(log: /);
    const rig = readRig(dir);
    expect(rig.state).toBe("failed");
    await expectAllDown(rig);
  }, 60_000);

  test("CLI: identity ignores TZ and locale: up in one, status/up/down in others; down stops all, a second up refuses and keeps the dir", async () => {
    const dir = freshDir();
    const envUp = { TZ: "Asia/Kolkata", LC_ALL: "de_DE.UTF-8" };
    const envOther = { TZ: "America/New_York", LC_ALL: "C" };
    const up = await cli(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`], { env: envUp });
    expect(up.code).toBe(0);
    const rig = readRig(dir);
    expect(rig.startedClock).toBe(CLOCK);
    try {
      expect(rig.procs.length).toBe(7);
      // Precondition: on this machine the raw lstart text really differs between the two envs (else the test is vacuous).
      const pid = rig.procs[0].pid;
      expect(lstartIn(pid, { PATH: process.env.PATH, ...envUp })).not.toBe(lstartIn(pid, { PATH: process.env.PATH, ...envOther }));
      for (const p of rig.procs) expect({ name: p.name, started: p.started }).toEqual({ name: p.name, started: lstart(p.pid) });

      const st = await cli(["status", "--dir", dir, "--json"], { env: { TZ: "Pacific/Chatham", LANG: "fr_FR.UTF-8" } });
      expect(st.code).toBe(0);
      expect(JSON.parse(st.out).procs.map(p => [p.name, p.alive])).toEqual(rig.procs.map(p => [p.name, true]));

      const before = readFileSync(join(dir, "rig.json"), "utf8");
      const again = await cli(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`], { env: envOther });
      expect(again.code).toBe(1);
      expect(again.err).toMatch(/is still running/);
      expect(readFileSync(join(dir, "rig.json"), "utf8")).toBe(before);
      expect(existsSync(join(dir, "pg", "PG_VERSION"))).toBe(true);
      for (const p of rig.procs) expect({ name: p.name, same: lstart(p.pid) === p.started }).toEqual({ name: p.name, same: true });

      const down = await cli(["down", "--dir", dir], { env: envOther });
      expect(down.code).toBe(0);
      expect(down.out).toMatch(/stopped caddy, node:host-1, node:gw-2, node:gw-1, minio, nats, postgres$/m);
      await expectAllDown(readRig(dir));
    } finally {
      // If the module's identity check is broken, stop the recorded PIDs here by the test's own check (never by pattern).
      // Match either form a broken rig might have recorded: the fixed one, or the env `up` ran under.
      killRecorded(rig.procs, dir);   // the fixed form, with the postmaster's SysV segment
      const procs = [...rig.procs, ...(existsSync(join(dir, "rig.json")) ? readRig(dir).procs : [])].reverse();
      for (const p of procs)
        if (p.started && (lstart(p.pid) === p.started || lstartIn(p.pid, { PATH: process.env.PATH, ...envUp }) === p.started ||
                          lstartIn(p.pid, { PATH: process.env.PATH, ...envOther }) === p.started)) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
    }
  }, 180_000);

  test("CLI: `up` SIGKILLed midway leaves rig.json naming what it started; `down` from another process stops all of it", async () => {
    const dir = freshDir();
    // A long health timeout and a node that never answers keep `up` waiting after Postgres and NATS are running.
    const up = spawnTracked([process.execPath, RIG, "up", "--dir", dir, "--timeout-ms", "120000", "--node-cmd", "sleep 300"],
      { cwd: ROOT, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    try {
      const deadline = Date.now() + 60_000;
      let rig = null;
      while (Date.now() < deadline) {
        try { rig = readRig(dir); } catch { rig = null; }
        if (rig?.procs?.some(p => p.name === "node:host-1")) break;
        await Bun.sleep(100);
      }
      expect(rig.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio", "node:gw-1", "node:gw-2", "node:host-1"]);
      up.kill("SIGKILL");
      await up.exited;
      expect(rig.procs.every(isOurs)).toBe(true);   // orphans now, still running
    } finally { up.kill("SIGKILL"); }
    const r = await cli(["down", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stopped node:host-1, node:gw-2, node:gw-1, minio, nats, postgres/);
    await expectAllDown(readRig(dir));
  }, 120_000);

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) test(`CLI: ${sig} during \`up\` makes it stop everything it had started and exit 1; nothing tied to the rig dir remains`, async () => {
    const dir = freshDir();
    const up = spawnTracked([process.execPath, RIG, "up", "--dir", dir, "--timeout-ms", "120000", "--node-cmd", "sleep 300"],
      { cwd: ROOT, stdout: "ignore", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    try {
      const deadline = Date.now() + 60_000;
      let rig = null;
      while (Date.now() < deadline) {
        try { rig = readRig(dir); } catch { rig = null; }
        if (rig?.procs?.some(p => p.name === "node:host-1")) break;
        await Bun.sleep(100);
      }
      up.kill(sig);
      const err = await new Response(up.stderr).text();
      expect(await up.exited).toBe(1);
      expect(err).toMatch(/up failed: aborted while waiting for node gw-1/);
    } finally { up.kill("SIGKILL"); }
    const rig = readRig(dir);
    expect(rig.state).toBe("failed");
    expect(rig.procs.length).toBe(6);
    await expectAllDown(rig);
    expect(namingDir(dir)).toEqual([]);
  }, 120_000);

  test("Leaks: an abort between spawns starts nothing more; what had started is stopped", async () => {
    const dir = freshDir();
    const abort = { aborted: false };
    let err = null;
    try { await startRig({ dir, nodeCmd: stub(), timeoutMs: 60_000, abort, onStep: m => { if (m === "node gw-2: starting") abort.aborted = true; } }); } catch (e) { err = e; }
    expect(err?.message).toMatch(/^aborted before starting node:gw-2/);
    const rig = readRig(dir);
    expect(rig.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio", "node:gw-1"]);
    await expectAllDown(rig);
    expect(namingDir(dir)).toEqual([]);
  }, 90_000);

  test("Leaks: a test run killed midway (SIGTERM, then SIGINT) leaves nothing of its rigs running, in-process or CLI", async () => {
    for (const sig of ["SIGTERM", "SIGINT"]) {
      const a = freshDir(), b = freshDir();
      const run = spawnTracked([process.execPath, "test", join(ROOT, "test/deploy/fixture-killed-run.js")],
        { cwd: ROOT, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp", RIG_FIXTURE_DIR_A: a, RIG_FIXTURE_DIR_B: b } });
      const seen = { [a]: [], [b]: [] };
      try {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          for (const d of [a, b]) { try { seen[d] = readRig(d).procs; } catch {} }
          if ([a, b].every(d => seen[d].some(p => p.name === "node:host-1"))) break;
          await Bun.sleep(100);
        }
        expect([a, b].map(d => seen[d].map(p => p.name))).toEqual([a, b].map(() => ["postgres", "nats", "minio", "node:gw-1", "node:gw-2", "node:host-1"]));
        expect([...seen[a], ...seen[b]].every(isOurs)).toBe(true);
        run.kill(sig);
        expect(await run.exited).toBe(sig === "SIGTERM" ? 143 : 130);
      } finally { run.kill("SIGKILL"); }
      for (const p of [...seen[a], ...seen[b]]) expect({ name: p.name, gone: psGone(p.pid) }).toEqual({ name: p.name, gone: true });
      expect([...namingDir(a), ...namingDir(b)]).toEqual([]);
      killRecorded(seen[a], a); killRecorded(seen[b], b);   // with the dir: a SIGKILLed postmaster's segment goes too
    }
  }, 240_000);

  // cleanupAll takes ONE ps snapshot and stops only the dirs it shows alive; these prove it still stops a leaked rig, never
  // touches a live pid recorded with another start time, and checks every dir when the snapshot is unusable (fails, prints
  // nothing, or prints a row that is not `pid stat lstart`). test/deploy/fixture-leaked-rig.js leaves a rig up and runs it.
  // A snapshot that parses but shows none of the rig's processes would make the filter skip (leak) a live rig: the last
  // two cases prove the full pass runs instead when an `up` is still in flight past the wait cap (N1) and when the ps
  // cannot even be spawned (N2: cleanup still removes the dirs and clears the shared abort flag).
  const OTHER_ROW = "echo '    1 Ss Mon Jan  1 00:00:00 2001'";
  for (const [label, psBody, extra = {}] of [["the snapshot ps works", null], ["the snapshot ps fails", "exit 2"], ["the snapshot ps prints nothing", "exit 0"], ["the snapshot ps prints a valid row and a row in another format", "echo '    1 Ss Mon Jan  1 00:00:00 2001'; echo '  123 S+ not-a-date'"],
                                              ["an `up` is still in flight past the wait cap", OTHER_ROW, { RIG_FIXTURE_INFLIGHT: "1" }], ["the snapshot ps cannot be spawned", null, { RIG_FIXTURE_PS: "/nonexistent/ps" }]]) {
    test.skipIf(SKIP)(`Leaks: cleanupAll stops a rig a test left up and spares a live pid with another start time (${label})`, async () => {
      const dir = freshDir(), out = join(freshDir(), "out.json"), fake = join(freshDir(), "fake-ps");
      if (psBody) { writeFileSync(fake, `#!/bin/sh\n${psBody}\n`); chmodSync(fake, 0o755); }
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp", RIG_FIXTURE_DIR: dir, RIG_FIXTURE_OUT: out, ...(psBody ? { RIG_FIXTURE_PS: fake } : {}), ...extra };
      const run = spawnTracked([process.execPath, "test", join(ROOT, "test/deploy/fixture-leaked-rig.js")], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env });
      let seen = null;
      try {
        expect(await run.exited).toBe(0);
        seen = JSON.parse(readFileSync(out, "utf8"));
        expect(seen.real.map(p => p.name)).toEqual(["postgres", "nats", "minio"]);
        for (const p of seen.real) expect({ name: p.name, gone: psGone(p.pid) }).toEqual({ name: p.name, gone: true });
        expect(namingDir(dir)).toEqual([]);
        expect(existsSync(dir)).toBe(false);
        expect(JSON.parse(readFileSync(`${out}.after`, "utf8"))).toEqual({ aborted: false });
        expect(psInfo(seen.decoy.pid)?.started).toBe(seen.decoy.started);   // still the same live process (psInfo: null for a zombie)
      } finally {
        run.kill("SIGKILL");
        if (seen) killRecorded([{ pid: seen.decoy.pid, started: seen.decoy.started }]);   // our own sleep, by pid and start time
      }
      for (let i = 0; i < 40 && !psGone(seen.decoy.pid); i++) await Bun.sleep(50);   // SIGKILL is delivered asynchronously
      expect(psGone(seen.decoy.pid)).toBe(true);
    }, 180_000);
  }

  test("CLI: keys and dev tokens never reach stdout or stderr (up, status, status --json, kill, down, a failing up); files are 0600; rig.json has none", async () => {
    const dir = freshDir();
    const outs = [];
    const run = async args => { const r = await cli(args); outs.push(r.out, r.err); return r; };
    const up = await run(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`]);
    expect(up.code).toBe(0);
    expect(up.out).toContain(join(dir, "tokens.json"));
    expect((await run(["status", "--dir", dir])).code).toBe(0);
    const json = await run(["status", "--dir", dir, "--json"]);
    const s = JSON.parse(json.out);
    expect(Object.keys(s).sort()).toEqual(["blobs", "createdAt", "dir", "keysFile", "lb", "leaseTtlMs", "logsDir", "maxConnsPerUser", "name", "nats", "nodes", "postgres", "procs", "startedClock", "state", "tokensFile", "version"]);
    expect(s.lb.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(s.tokensFile).toBe(join(dir, "tokens.json"));                              // absolute for callers…
    expect(readRig(dir)).toMatchObject({ tokensFile: "tokens.json", keysFile: "keys.json", logsDir: "logs" });   // …relative on disk (L6)
    expect((await run(["kill", "gw-2", "--dir", dir])).code).toBe(0);

    // Read the secrets now: a failing `up` on a second dir has its own; collect both sets.
    const secrets = [];
    const collect = d => {
      for (const f of ["keys.json", "tokens.json"]) expect((statSync(join(d, f)).mode & 0o777).toString(8)).toBe("600");
      const keys = JSON.parse(readFileSync(join(d, "keys.json"), "utf8"));
      const tokens = JSON.parse(readFileSync(join(d, "tokens.json"), "utf8"));
      secrets.push(keys.COOKIE_KEY, keys.SESSION_KEY, ...Object.keys(tokens));
      expect(Object.values(tokens).filter(t => t.admin === true && t.role === "owner" && t.domain === "rig.test").length).toBe(1);
      expect(readFileSync(join(d, "rig.json"), "utf8")).not.toMatch(/rig-[A-Za-z0-9_-]{20,}|COOKIE_KEY|SESSION_KEY/);
      // Every log too (p8-rigv L5): read at the end, after down, so they hold everything the processes wrote.
      logDirs.push(join(d, "logs"));
    };
    const logDirs = [];
    collect(dir);
    expect((await run(["down", "--dir", dir])).code).toBe(0);
    const bad = freshDir();
    const fail = await run(["up", "--dir", bad, "--node-cmd", `${process.execPath} ${STUB} --die-if-role=host`]);
    expect(fail.code).toBe(1);
    expect(fail.err).toMatch(/up failed: node host-1/);
    collect(bad);
    await expectAllDown(readRig(bad));

    expect(secrets.length).toBeGreaterThan(200);
    const logs = logDirs.flatMap(ld => readdirSync(ld).map(f => readFileSync(join(ld, f), "utf8")));
    expect(logs.length).toBeGreaterThanOrEqual(11);   // 6 + 5 log files
    const all = [...outs, ...logs].join("\n");
    const leaked = secrets.filter(sec => all.includes(sec));
    expect(leaked.length).toBe(0);
  }, 180_000);

  // ---- p8-rig3: H2 (ps failure never reads as "gone"), M3 (one `up` per dir), L6 (moved rig) ----

  // Stop recorded PIDs by the test's own /bin/ps check (never by pattern): used where the module's ps is stubbed.

  test("H2 CLI: with no ps on PATH, status still sees the rig alive, a second up refuses and keeps the dir, down stops all", async () => {
    const dir = freshDir();
    const NOPS = "/opt/homebrew/bin";   // has initdb/postgres/nats-server/caddy (bins() falls back to it), but no ps
    expect(existsSync(join(NOPS, "ps"))).toBe(false);
    expect(Bun.which("ps", { PATH: NOPS })).toBe(null);
    const up = await cli(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`]);
    expect(up.code).toBe(0);
    const rig = readRig(dir);
    try {
      const env = { PATH: NOPS };
      const st = await cli(["status", "--dir", dir, "--json"], { env });
      expect(st.code).toBe(0);
      expect(JSON.parse(st.out).procs.map(p => [p.name, p.alive])).toEqual(rig.procs.map(p => [p.name, true]));
      const before = readFileSync(join(dir, "rig.json"), "utf8");
      const again = await cli(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`], { env });
      expect(again.code).toBe(1);
      expect(again.err).toMatch(/is still running \(postgres, nats, minio, node:gw-1, node:gw-2, node:host-1, caddy\)/);   // got past the binaries check
      expect(readFileSync(join(dir, "rig.json"), "utf8")).toBe(before);
      expect(existsSync(join(dir, "pg", "PG_VERSION"))).toBe(true);
      expect(existsSync(join(dir, "up.lock"))).toBe(false);   // the refusing up released its lock
      for (const p of rig.procs) expect({ name: p.name, same: lstart(p.pid) === p.started }).toEqual({ name: p.name, same: true });
      const down = await cli(["down", "--dir", dir], { env });
      expect(down.code).toBe(0);
      expect(down.out).toMatch(/stopped caddy, node:host-1, node:gw-2, node:gw-1, minio, nats, postgres$/m);
      await expectAllDown(readRig(dir));
    } finally { killRecorded(rig.procs, dir); }
  }, 180_000);

  test("H2: a ps that fails in any way (missing, killed, non-zero, garbage, or 'absent' for everything), up front or only after the self-probe, makes status, kill, down and up refuse; nothing is signalled or removed", async () => {
    const dir = freshDir(), stubs = freshDir();
    const script = (name, body) => { const f = join(stubs, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
    const broken = {
      missing: join(stubs, "no-such-dir", "ps"),
      killed: script("killed", "kill -9 $$"),
      exit2: script("exit2", 'echo "ps: something broke" >&2; exit 2'),
      exit1stderr: script("exit1stderr", 'echo "ps: something broke" >&2; exit 1'),
      garbage: script("garbage", "echo hello; exit 0"),
      empty0: script("empty0", "exit 0"),
      absentForAll: script("absent", "exit 1"),
    };
    // "late" variants: the first call (the self-probe) is answered by /bin/ps, every later one fails. These hit the
    // per-call checks in psInfo, which the up-front self-probe would otherwise mask.
    const late = (name, bad) => () => script(name, `c="$0.count"; if [ ! -e "$c" ]; then : > "$c"; exec /bin/ps "$@"; fi\n${bad}`);
    const lateKinds = {
      lateMissing: () => script("late-missing", 'c="$0.count"; : > "$c"; mv "$0" "$0.away"; exec /bin/ps "$@"'),
      lateKilled: late("late-killed", "kill -9 $$"),
      lateExit2: late("late-exit2", 'echo "ps: something broke" >&2; exit 2'),
      lateGarbage: late("late-garbage", "echo hello; exit 0"),
    };
    // Rewrite before every call, so each call starts with a fresh stub (the late ones move or count themselves).
    const fresh = kind => { for (const f of readdirSync(stubs)) if (f.endsWith(".count") || f.endsWith(".away")) rmSync(join(stubs, f)); return lateKinds[kind]?.() ?? broken[kind]; };
    const rig = await startRig({ dir, nodeCmd: stub(), timeoutMs: 60_000 });
    try {
      expect(rig.procs.length).toBe(7);
      const before = readFileSync(join(dir, "rig.json"), "utf8");
      for (const kind of [...Object.keys(broken), ...Object.keys(lateKinds)]) {
        try {
          for (const [what, call] of [["status", async () => rigStatus(dir)], ["kill", () => killNode(dir, "gw-1")], ["down", () => stopRig(dir, { graceMs: 200 })],
                                      ["up", () => startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })]]) {
            let err = null;
            _setPsPath(fresh(kind));
            try { await call(); } catch (e) { err = e; }
            expect({ kind, what, msg: err?.message?.startsWith("cannot check processes: ") }).toEqual({ kind, what, msg: true });
          }
        } finally { _setPsPath(); }
        expect({ kind, same: readFileSync(join(dir, "rig.json"), "utf8") === before }).toEqual({ kind, same: true });
        expect(existsSync(join(dir, "pg", "PG_VERSION"))).toBe(true);
        expect(existsSync(join(dir, "up.lock"))).toBe(false);
        for (const p of rig.procs) expect({ kind, name: p.name, alive: lstart(p.pid) === p.started }).toEqual({ kind, name: p.name, alive: true });
      }
      const r = await stopRig(dir);
      expect(r.stopped.length).toBe(7);
      await expectAllDown(readRig(dir));
    } finally { _setPsPath(); killRecorded(rig.procs, dir); }
  }, 120_000);

  test("H2: ps failing in the middle of `up` (right after a spawn): up throws, and stops its own children by handle; nothing leaks", async () => {
    const dir = freshDir(), stubs = freshDir();
    const flag = join(stubs, "broken");
    const ps = join(stubs, "ps");
    writeFileSync(ps, `#!/bin/sh\n[ -e '${flag}' ] && { echo "ps: broken" >&2; exit 2; }\nexec /bin/ps "$@"\n`); chmodSync(ps, 0o755);
    _setPsPath(ps);
    let err = null, rig = null;
    try {
      await startRig({ dir, nodeCmd: stub(), timeoutMs: 60_000, onStep: m => { if (m === "nats: starting") writeFileSync(flag, ""); } });
    } catch (e) { err = e; }
    finally { _setPsPath(); rmSync(flag, { force: true }); rig = readRig(dir); }
    try {
      expect(err?.message).toMatch(/^cannot check processes: .* exited 2 \(ps: broken\).*stopped this up's own children instead: nats, postgres$/);
      expect(rig.state).toBe("failed");
      expect(rig.procs.map(p => p.name)).toEqual(["postgres"]);   // nats was spawned but never recorded: only its handle knew it
      const natsPort = Number(/listen: 127\.0\.0\.1:(\d+)/.exec(readFileSync(join(dir, "nats.conf"), "utf8"))[1]);
      expect({ nats: portFree(natsPort) }).toEqual({ nats: true });
      await expectAllDown(rig);
      expect(existsSync(join(dir, "up.lock"))).toBe(false);
    } finally { killRecorded(rig?.procs ?? [], dir); }
  }, 90_000);

  test("M3: a second `up` during the first one's initdb window (rig.json: starting, no procs) refuses; the dir is not wiped", async () => {
    const dir = freshDir();
    // A stopped rig already lives here, so A takes the reuse path (wipe all but the lock) before it writes `starting`.
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "prev", dir, startedClock: CLOCK, state: "down", nodes: [], procs: [] }));
    const a = spawnTracked([process.execPath, RIG, "up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`],
      { cwd: ROOT, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let seen = null;
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { seen = readRig(dir); } catch { seen = null; }
        if (seen?.state === "starting" && seen.procs.length === 0) break;
        await Bun.sleep(5);
      }
      expect({ state: seen?.state, procs: seen?.procs?.length }).toEqual({ state: "starting", procs: 0 });
      writeFileSync(join(dir, "sentinel"), "A's dir");
      const b = await cli(["up", "--dir", dir, "--node-cmd", `${process.execPath} ${STUB}`]);
      expect(b.code).toBe(1);
      expect(b.err).toMatch(/another `up` \(pid \d+\) is starting the rig at /);
      expect(readFileSync(join(dir, "sentinel"), "utf8")).toBe("A's dir");
      expect(await a.exited).toBe(0);
      const rig = readRig(dir);
      expect(rig.state).toBe("up");
      expect(rig.procs.length).toBe(7);
      expect(rig.procs.every(isOurs)).toBe(true);
      expect(existsSync(join(dir, "pg", "PG_VERSION"))).toBe(true);
      expect(existsSync(join(dir, "up.lock"))).toBe(false);
    } finally { a.kill("SIGKILL"); await a.exited; }
    await stopRig(dir);
    await expectAllDown(readRig(dir));
  }, 120_000);

  test("M3: a lock held by a live process refuses; a stale lock (its up gone) is cleared, up proceeds and releases it", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      const live = JSON.stringify({ pid: decoy.pid, started: lstart(decoy.pid) }) + "\n";
      writeFileSync(join(dir, "up.lock"), live);
      writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "x", dir, startedClock: CLOCK, state: "starting", nodes: [], procs: [] }));
      mkdirSync(join(dir, "pg"));
      await expect(startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })).rejects.toThrow(new RegExp(`another \`up\` \\(pid ${decoy.pid}\\) is starting`));
      expect(readFileSync(join(dir, "up.lock"), "utf8")).toBe(live);
      expect(existsSync(join(dir, "pg"))).toBe(true);
      // Stale: same PID, wrong start time (a reused PID is not the lock's owner).
      writeFileSync(join(dir, "up.lock"), JSON.stringify({ pid: decoy.pid, started: "Mon Jan  1 00:00:00 2001" }) + "\n");
      const rig = await startRig({ dir, nodeCmd: stub(), timeoutMs: 60_000 });
      expect(rig.state).toBe("up");
      expect(readdirSync(dir).filter(f => f.startsWith("up.lock"))).toEqual([]);
      expect(psGone(decoy.pid)).toBe(false);
      await stopRig(dir);
      await expectAllDown(readRig(dir));
    } finally { decoy.kill("SIGKILL"); }
  }, 90_000);

  test("L6: rig.json stores in-dir paths relative to the dir; a moved rig dir (and an older absolute-path file) resolves them under the dir given", async () => {
    const a = freshDir();
    const abs = f => join(a, f);
    // The round-2 shape: absolute paths under a.
    const old = { version: 1, name: "m", dir: a, startedClock: CLOCK, state: "up", tokensFile: abs("tokens.json"), keysFile: abs("keys.json"), logsDir: abs("logs"),
      nodes: [{ id: "gw-1", roles: ["gateway"], port: 1, dataDir: abs("nodes/gw-1/data"), log: abs("logs/gw-1.log") }],
      procs: [{ name: "node:gw-1", pid: await reapedPid(), started: "Thu Jan  1 00:00:00 2001", log: abs("logs/gw-1.log") }] };
    writeFileSync(join(a, "rig.json"), JSON.stringify(old));
    const c = track(a + "-moved");
    renameSync(a, c);
    const want = d => ({ dir: d, tokensFile: join(d, "tokens.json"), keysFile: join(d, "keys.json"), logsDir: join(d, "logs") });
    const st = rigStatus(c);
    expect(st).toMatchObject(want(c));
    expect(st.nodes[0]).toMatchObject({ dataDir: join(c, "nodes/gw-1/data"), log: join(c, "logs/gw-1.log") });
    expect(st.procs[0].log).toBe(join(c, "logs/gw-1.log"));
    // Any save writes them relative; moved again, they follow the dir.
    await stopRig(c, { graceMs: 200 });
    expect(readRig(c)).toMatchObject({ tokensFile: "tokens.json", keysFile: "keys.json", logsDir: "logs", nodes: [{ dataDir: "nodes/gw-1/data", log: "logs/gw-1.log" }] });
    const d = track(c + "2");
    renameSync(c, d);
    expect(rigStatus(d)).toMatchObject(want(d));
  });

  // End to end with the real server/main.js, which runs in cluster mode on the rig's env (DATABASE_URL, NATS_URL,
  // PLENARY_NODE_ID, PLENARY_ROLES, PLENARY_LEASE_TTL_MS): an op acked through the LB is seen on the other gateway.
  // Un-skipped in p8-rig3 after 3 green runs in a row.
  // p8-rig3v A: a ps that fails once (on the first probe of the server `up` just spawned) and then works again. stopRig
  // then succeeds and knows nothing of that unrecorded child, so the failed `up` must also stop its children by handle.
  // The stub writes the PID it failed on into `fired`, so the test proves it fired and that this very PID is gone.
  const flakyPs = (stubs, pattern) => {
    const mark = join(stubs, "fired"), ps = join(stubs, "ps");
    writeFileSync(ps, `#!/bin/sh\nfor a in "$@"; do pid="$a"; done\n` +
      `if [ ! -e '${mark}' ] && /bin/ps -o command= -p "$pid" 2>/dev/null | grep -q -- '${pattern}'; then echo "$pid" > '${mark}'; echo "ps: transient" >&2; exit 2; fi\n` +
      `exec /bin/ps "$@"\n`);
    chmodSync(ps, 0o755);
    return { ps, mark };
  };
  /** Last resort for a broken build (a mutant): stop what still names `dir` by its PID (postgres SIGINT, else SIGTERM). */
  const stopNaming = async dir => {
    for (const l of namingDir(dir)) { const pid = Number(l.split(/\s+/)[0]); try { process.kill(pid, l.includes("postgres -D") ? "SIGINT" : "SIGTERM"); } catch {} }
    for (let i = 0; i < 100 && namingDir(dir).length; i++) await Bun.sleep(100);
  };
  for (const [what, pattern] of [["nats", "nats-server --config"], ["postgres", "postgres -D"]]) test(`A: ps failing once on the just-spawned ${what} and then recovering: up throws and stops it by handle; nothing is left; a second up starts clean`, async () => {
    const dir = freshDir(), stubs = freshDir();
    const { ps, mark } = flakyPs(stubs, pattern);
    _setPsPath(ps);
    let err = null;
    try { await startRig({ dir, nodeCmd: stub(), gateways: 1, hosts: 0, timeoutMs: 60_000 }); } catch (e) { err = e; }
    finally { _setPsPath(); }
    let rig2 = null;
    try {
      expect(err?.message).toMatch(/^cannot check processes: .* exited 2 \(ps: transient\)/);
      const pid = Number(readFileSync(mark, "utf8").trim());
      expect(pid > 1).toBe(true);
      expect(readRig(dir).procs.map(p => p.pid)).not.toContain(pid);   // spawned, never recorded
      expect({ pid, gone: psGone(pid) }).toEqual({ pid, gone: true });
      expect(namingDir(dir)).toEqual([]);
      expect(existsSync(join(dir, "pg", "postmaster.pid"))).toBe(false);
      await expectAllDown(readRig(dir));
      // A second `up` on the dir: exactly one postmaster runs on it, and it is the recorded one.
      writeFileSync(join(dir, "pg", "SENTINEL"), "x");
      rig2 = await startRig({ dir, nodeCmd: stub(), gateways: 1, hosts: 0, timeoutMs: 60_000 });
      expect(rig2.state).toBe("up");
      const pms = namingDir(dir).filter(l => l.includes("postgres -D")).map(l => Number(l.split(/\s+/)[0]));
      expect(pms).toEqual([rig2.procs.find(p => p.name === "postgres").pid]);
      await stopRig(dir);
      await expectAllDown(readRig(dir));
    } finally { await stopNaming(dir); killRecorded(rig2?.procs ?? readRig(dir).procs, dir); }
  }, 120_000);

  // A second line of defence for A: a postmaster that rig.json does not name but that still runs on <dir>/pg (its
  // postmaster.pid's PID is alive and started when line 3 says) makes `up` refuse instead of wiping pg/ under it.
  test("A: up refuses to wipe pg/ while postmaster.pid names a live process started at the recorded time; a reused PID does not block", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(100);
      const startedAt = Math.round(Date.parse(lstart(decoy.pid) + " UTC") / 1000);
      writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "x", dir, startedClock: CLOCK, state: "failed", nodes: [], procs: [] }));
      mkdirSync(join(dir, "pg"));
      const pmPid = at => writeFileSync(join(dir, "pg", "postmaster.pid"), [decoy.pid, join(dir, "pg"), String(at), "5432", "", "127.0.0.1", "  1  2", "ready   ", ""].join("\n"));
      pmPid(startedAt);
      await expect(startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })).rejects.toThrow(new RegExp(`a postmaster \\(pid ${decoy.pid}\\) not recorded in rig.json is still running`));
      expect(existsSync(join(dir, "pg", "postmaster.pid"))).toBe(true);
      expect(readdirSync(dir).filter(f => f.startsWith("up.lock"))).toEqual([]);
      // Same PID, but the file says it started an hour earlier: a reused PID, not a postmaster; up proceeds.
      pmPid(startedAt - 3600);
      const rig = await startRig({ dir, nodeCmd: stub(), gateways: 1, hosts: 0, timeoutMs: 60_000 });
      expect(rig.state).toBe("up");
      await stopRig(dir);
      await expectAllDown(readRig(dir));
    } finally { decoy.kill("SIGKILL"); }
  }, 90_000);

  // p8-rig3v C: a save that fails inside `up` (here: a directory at rig.json.tmp) must not skip the cleanup.
  test("C: a failing save inside up (rig.json.tmp is a directory) still stops everything it started", async () => {
    const dir = freshDir();
    let err = null;
    try {
      await startRig({ dir, nodeCmd: stub(), gateways: 1, hosts: 0, timeoutMs: 30_000,
        onStep: m => { if (m === "nats: starting") mkdirSync(join(dir, "rig.json.tmp")); } });
    } catch (e) { err = e; }
    try {
      expect(err?.message).toMatch(/EISDIR/);
      const rig = readRig(dir);   // as last saved, before the directory appeared: postgres only
      expect(rig.procs.map(p => p.name)).toEqual(["postgres"]);
      const natsPort = Number(/listen: 127\.0\.0\.1:(\d+)/.exec(readFileSync(join(dir, "nats.conf"), "utf8"))[1]);
      expect({ nats: portFree(natsPort) }).toEqual({ nats: true });
      expect(namingDir(dir)).toEqual([]);
      await expectAllDown(rig);
      expect(readdirSync(dir).filter(f => f.startsWith("up.lock"))).toEqual([]);
    } finally { rmSync(join(dir, "rig.json.tmp"), { recursive: true, force: true }); await stopNaming(dir); killRecorded(readRig(dir).procs, dir); }
  }, 90_000);

  // p8-rig3v B: a stale up.lock is cleared only under an exclusive up.lock.break, and only while it still holds exactly
  // the text judged stale. Never two holders: anything unexpected refuses.
  test("B: a stale lock is cleared only under up.lock.break: a live breaker refuses, a left-over break lock refuses, a lock that changed after it was judged stale is kept", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const gone = await reapedPid();
    try {
      await Bun.sleep(100);
      const body = pid => JSON.stringify({ pid, started: pid === decoy.pid ? lstart(decoy.pid) : "Mon Jan  1 00:00:00 2001" }) + "\n";
      const stale = body(gone), live = body(decoy.pid);
      writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "x", dir, startedClock: CLOCK, state: "failed", nodes: [], procs: [] }));
      mkdirSync(join(dir, "pg"));
      const files = () => readdirSync(dir).filter(f => f.startsWith("up.lock")).sort();
      // 1. Another `up` (live) holds the break lock: refuse; nothing touched.
      writeFileSync(join(dir, "up.lock"), stale);
      writeFileSync(join(dir, "up.lock.break"), live);
      await expect(startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })).rejects.toThrow(new RegExp(`another \`up\` \\(pid ${decoy.pid}\\) is clearing a stale lock`));
      expect(files()).toEqual(["up.lock", "up.lock.break"]);
      expect(readFileSync(join(dir, "up.lock"), "utf8")).toBe(stale);
      // 2. A break lock left by a dead `up`: refuse and name the file; nothing touched.
      writeFileSync(join(dir, "up.lock.break"), stale);
      await expect(startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })).rejects.toThrow(/up\.lock\.break was left by an `up` that stopped while clearing a stale lock/);
      expect(files()).toEqual(["up.lock", "up.lock.break"]);
      expect(readFileSync(join(dir, "up.lock"), "utf8")).toBe(stale);
      expect(existsSync(join(dir, "pg"))).toBe(true);
      // 3. Judged stale, then (before the break) another `up` cleared it and took the lock: that lock is kept; refuse.
      rmSync(join(dir, "up.lock.break"));
      _setLockHook(stage => { if (stage === "stale") { _setLockHook(); rmSync(join(dir, "up.lock")); writeFileSync(join(dir, "up.lock"), live); } });
      try { await expect(startRig({ dir, nodeCmd: stub(), timeoutMs: 5000 })).rejects.toThrow(new RegExp(`another \`up\` \\(pid ${decoy.pid}\\) is starting`)); }
      finally { _setLockHook(); }
      expect(files()).toEqual(["up.lock"]);
      expect(readFileSync(join(dir, "up.lock"), "utf8")).toBe(live);
      expect(existsSync(join(dir, "pg"))).toBe(true);
    } finally { decoy.kill("SIGKILL"); }
  }, 60_000);

  test("B: `up` releases only its own lock: a lock replaced while it ran is left in place", async () => {
    const dir = freshDir();
    const other = JSON.stringify({ pid: 999999, started: "Mon Jan  1 00:00:00 2001" }) + "\n";
    const rig = await startRig({ dir, nodeCmd: stub(), gateways: 1, hosts: 0, timeoutMs: 60_000,
      onStep: m => { if (m === "postgres: initdb") writeFileSync(join(dir, "up.lock"), other); } });
    try {
      expect(rig.state).toBe("up");
      expect(readFileSync(join(dir, "up.lock"), "utf8")).toBe(other);
    } finally { rmSync(join(dir, "up.lock"), { force: true }); await stopRig(dir); }
    await expectAllDown(readRig(dir));
  }, 90_000);

  test("e2e: hello over the LB, an op acked, the entry visible from a client on the other gateway", async () => {
    const dir = freshDir();
    const rig = await startRig({ dir, timeoutMs: 60_000 });
    try {
      const tokens = JSON.parse(readFileSync(rig.tokensFile, "utf8"));
      const tokenOf = name => Object.entries(tokens).find(([, t]) => t.name === name)[0];
      // A board in tenant rig.test, created through the LB with the admin token; every rig token is a rig.test member.
      const res = await fetch(rig.lb.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${tokenOf("rig-admin")}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "rig e2e", memberRole: "viewer" }) });
      expect(res.status).toBe(201);
      const { board } = await res.json();
      const boardId = typeof board === "string" ? board : board.id;
      const sock = url => new Promise((res, rej) => {
        const ws = new WebSocket(url), msgs = [], waiters = [];
        ws.onmessage = e => { const m = JSON.parse(e.data); msgs.push(m); for (const w of [...waiters]) if (w.f(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } };
        ws.onopen = () => res({ ws, send: m => ws.send(JSON.stringify(m)), next: f => { const hit = msgs.find(f); return hit ? Promise.resolve(hit) : new Promise(r => waiters.push({ f, res: r })); } });
        ws.onerror = rej;
      });
      const a = await sock(rig.lb.wsUrl);                                     // through Caddy
      a.send({ t: "hello", v: 1, token: tokenOf("rig-admin"), board: boardId, since: 0, client: "a" });
      expect((await a.next(m => m.t === "welcome")).role).toBe("owner");
      const gw2 = rig.nodes.find(n => n.id === "gw-2");
      const b = await sock(`ws://127.0.0.1:${gw2.port}/ws`);                  // straight to the other gateway
      b.send({ t: "hello", v: 1, token: tokenOf("viewer-1"), board: boardId, since: 0, client: "b" });
      expect((await b.next(m => m.t === "welcome")).role).toBe("viewer");
      a.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { appState: { grid: 20 }, appBase: { grid: 0 } } });
      expect(await a.next(m => m.t === "ack")).toMatchObject({ id: "a:1", seq: 1 });
      expect((await b.next(m => m.t === "entries")).entries[0]).toMatchObject({ seq: 1, by: "dev:rig-admin" });
      a.ws.close(); b.ws.close();
    } finally { await stopRig(dir); }
    await expectAllDown(readRig(dir));
  }, 120_000);
});

// p8-rig3 Leaks: a SIGKILLed postmaster's SysV segment is removed (macOS allows 32; orphans block every Postgres).
// No Postgres needed: ipcs and ipcrm are stubs (ipcs prints a fixed table, ipcrm only logs its argv), so these tests
// never remove a real segment.
describe("SysV segment of a SIGKILLed postmaster (stub ipcs/ipcrm)", () => {
  const setup = (rows, { ipcsFails = false } = {}) => {
    const d = freshDir();
    const table = join(d, "ipcs.txt"), log = join(d, "ipcrm.log");
    writeFileSync(table, "IPC status from <running system>\nT     ID     KEY        MODE       OWNER    GROUP NATTCH\nShared Memory:\n" + rows.join("\n") + "\n");
    const sh = (name, body) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
    _setIpcPaths({ ipcs: sh("ipcs", ipcsFails ? "exit 1" : `cat '${table}'`), ipcrm: sh("ipcrm", `echo "$@" >> '${log}'`) });
    return { d, removed: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const pmFile = (d, pid, line7 = "    12345       777") => { mkdirSync(join(d, "pg"), { recursive: true });
    writeFileSync(join(d, "pg", "postmaster.pid"), [pid, join(d, "pg"), "1700000000", "5432", "", "127.0.0.1", line7, "ready   ", ""].join("\n")); };
  const row = (id, keyDec, nattch) => `m ${id} 0x${keyDec.toString(16).padStart(8, "0")} --rw-------        r    staff      ${nattch}`;
  afterAll(() => _setIpcPaths());

  test("removeOrphanShm removes exactly the segment named, only when ipcs lists that id with that key and NATTCH 0", () => {
    try {
      const shm = { key: 12345, id: 777 };
      let t = setup([row(776, 12345, 0), row(777, 12345, 0)]);
      expect(removeOrphanShm(shm)).toBe(true); expect(t.removed()).toEqual(["-m 777"]);
      t = setup([row(777, 12345, 1)]);           expect(removeOrphanShm(shm, { waitMs: 0 })).toBe(false); expect(t.removed()).toEqual([]);   // still attached
      t = setup([row(777, 99999, 0)]);           expect(removeOrphanShm(shm)).toBe(false); expect(t.removed()).toEqual([]);   // id reused by another key
      t = setup([row(778, 12345, 0)]);           expect(removeOrphanShm(shm)).toBe(false); expect(t.removed()).toEqual([]);   // already gone
      t = setup([row(777, 12345, 0)], { ipcsFails: true }); expect(removeOrphanShm(shm)).toBe(false); expect(t.removed()).toEqual([]);
      expect(removeOrphanShm(null)).toBe(false);
    } finally { _setIpcPaths(); }
  });

  // p8-rig3v D: a backend may still be attached for a moment after its postmaster died; retry (bounded) until NATTCH 0,
  // re-checking the exact id and key on every try.
  const seq = (tables, { d = freshDir() } = {}) => {
    const log = join(d, "ipcrm.log"), count = join(d, "count");
    const head = "IPC status from <running system>\nT     ID     KEY        MODE       OWNER    GROUP NATTCH\nShared Memory:\n";
    tables.forEach((rows, i) => writeFileSync(join(d, `t${i}`), head + rows.join("\n") + "\n"));
    const sh = (name, body) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
    _setIpcPaths({ ipcs: sh("ipcs", `n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n+1)) > '${count}'; last=${tables.length - 1}; [ $n -gt $last ] && n=$last; cat '${d}/t'$n`),
                   ipcrm: sh("ipcrm", `echo "$@" >> '${log}'`) });
    return { removed: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], calls: () => Number(readFileSync(count, "utf8")) };
  };
  test("D: removeOrphanShm waits (bounded) for the last backend to detach; a segment still attached at the bound, or whose key changes, is kept", () => {
    try {
      const shm = { key: 12345, id: 777 };
      let t = seq([[row(777, 12345, 2)], [row(777, 12345, 1)], [row(777, 12345, 0)]]);
      expect(removeOrphanShm(shm, { waitMs: 3000 })).toBe(true); expect(t.removed()).toEqual(["-m 777"]); expect(t.calls()).toBe(3);
      t = seq([[row(777, 12345, 1)]]);
      const t0 = Date.now();
      expect(removeOrphanShm(shm, { waitMs: 400 })).toBe(false); expect(t.removed()).toEqual([]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350); expect(Date.now() - t0).toBeLessThan(2000); expect(t.calls()).toBeGreaterThan(1);
      t = seq([[row(777, 12345, 1)], [row(777, 99999, 0)]]);
      expect(removeOrphanShm(shm, { waitMs: 3000 })).toBe(false); expect(t.removed()).toEqual([]); expect(t.calls()).toBe(2);
      t = seq([[row(777, 12345, 1)], []]);
      expect(removeOrphanShm(shm, { waitMs: 3000 })).toBe(false); expect(t.removed()).toEqual([]); expect(t.calls()).toBe(2);
    } finally { _setIpcPaths(); }
  });

  test("pgShmOf reads line 7 of postmaster.pid, only for the postmaster PID on line 1", () => {
    const d = freshDir();
    expect(pgShmOf(join(d, "pg"), 4242)).toBe(null);                 // no file
    pmFile(d, 4242);
    expect(pgShmOf(join(d, "pg"), 4242)).toEqual({ key: 12345, id: 777 });
    expect(pgShmOf(join(d, "pg"), 4243)).toBe(null);                 // another postmaster's file
    pmFile(d, 4242, "garbage");
    expect(pgShmOf(join(d, "pg"), 4242)).toBe(null);
  });

  test("down SIGKILLs a postmaster that ignores SIGINT and removes its segment; a clean exit removes nothing", async () => {
    try {
      // Ignores SIGINT/SIGTERM: down must escalate.
      const d = freshDir(); const t = setup([row(777, 12345, 0)]);
      const stubborn = Bun.spawn(["sh", "-c", "trap '' INT TERM; exec sleep 60"], { stdout: "ignore", stderr: "ignore" });
      try {
        await Bun.sleep(200);
        pmFile(d, stubborn.pid);
        writeFileSync(join(d, "rig.json"), JSON.stringify({ version: 1, name: "pg", dir: d, startedClock: CLOCK, state: "up", nodes: [],
          procs: [{ name: "postgres", pid: stubborn.pid, started: lstart(stubborn.pid), log: "/dev/null" }] }));
        expect(await stopRig(d, { graceMs: 300 })).toEqual({ stopped: ["postgres"], gone: [], forced: ["postgres"] });
        expect(t.removed()).toEqual(["-m 777"]);
      } finally { stubborn.kill("SIGKILL"); }
      // Exits on SIGINT (as a real postmaster's fast shutdown, which removes its own segment): nothing removed.
      const d2 = freshDir(); const t2 = setup([row(777, 12345, 0)]);
      const polite = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
      try {
        pmFile(d2, polite.pid);
        writeFileSync(join(d2, "rig.json"), JSON.stringify({ version: 1, name: "pg", dir: d2, startedClock: CLOCK, state: "up", nodes: [],
          procs: [{ name: "postgres", pid: polite.pid, started: lstart(polite.pid), log: "/dev/null" }] }));
        expect((await stopRig(d2, { graceMs: 3000 })).forced).toEqual([]);
        expect(t2.removed()).toEqual([]);
      } finally { polite.kill("SIGKILL"); }
    } finally { _setIpcPaths(); }
  }, 30_000);

  test("rig-guard's last-resort SIGKILL of a recorded postmaster removes its segment too", async () => {
    try {
      const d = freshDir(); const t = setup([row(777, 12345, 0)]);
      const pm = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
      try {
        pmFile(d, pm.pid);
        killRecorded([{ name: "postgres", pid: pm.pid, started: lstart(pm.pid) }], d);
        expect(await pm.exited).toBe(137);
        expect(t.removed()).toEqual(["-m 777"]);
      } finally { pm.kill("SIGKILL"); }
    } finally { _setIpcPaths(); }
  }, 30_000);
});

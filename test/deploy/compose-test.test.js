// Guards for the compose cluster test (#71, scripts/test-compose.js, deploy/cluster.compose.test.yml). The container
// test itself runs only through `bun run test:compose`; these check its parts without a container runtime.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectRuntime, skipDecision, alive, sameStart, machineId, ownerString, parseOwner, ownerDead, sweep, run, TIMEOUT_CODE } from "../../scripts/test-compose.js";

const ROOT = join(import.meta.dir, "../..");
const ok = (out = "") => ({ code: 0, out });
const no = { code: 1, out: "" };

test("runtime detection: docker with `docker compose` is preferred; CONTAINER_CLI forces podman", async () => {
  const which = n => ({ docker: "/bin/docker", podman: "/bin/podman" })[n] ?? null;
  const rt = await detectRuntime({ env: {}, which, probe: async () => ok() });
  expect(rt).toMatchObject({ cliName: "docker", compose: ["/bin/docker", "compose"] });
  const calls = [];
  const forced = await detectRuntime({ env: { CONTAINER_CLI: "podman", DOCKER_HOST: "unix:///x.sock" }, which: n => (n === "podman" ? "/bin/podman" : n === "docker-compose" ? "/bin/docker-compose" : null),
    probe: async c => { calls.push(c.join(" ")); return ok(); } });
  expect(forced).toMatchObject({ cliName: "podman", compose: ["/bin/docker-compose"] });
  expect(calls[0]).toBe("/bin/podman info");
});

test("runtime detection: podman's machine socket becomes DOCKER_HOST (macOS), and a missing socket is a skip", async () => {
  const which = n => (n === "podman" ? "/bin/podman" : n === "docker-compose" ? "/bin/docker-compose" : null);
  const probe = async c => (c.includes("inspect") ? ok("/tmp/p.sock") : ok());
  expect(await detectRuntime({ env: {}, which, probe, exists: () => true, platform: "darwin" })).toMatchObject({ env: { DOCKER_HOST: "unix:///tmp/p.sock" } });
  expect(await detectRuntime({ env: {}, which, probe, exists: () => false, platform: "darwin" })).toMatchObject({ skip: expect.stringContaining("no podman API socket") });
});

test("runtime detection: nothing installed, a dead daemon, or no Compose is a skip that says why; a CONTAINER_CLI path that is missing says not found", async () => {
  expect(await detectRuntime({ env: {}, which: () => null, probe: async () => ok() })).toMatchObject({ skip: expect.stringContaining("docker: not found; podman: not found") });
  expect(await detectRuntime({ env: {}, which: n => (n === "docker" ? "/bin/docker" : null), probe: async () => no })).toMatchObject({ skip: expect.stringContaining("daemon not reachable") });
  expect(await detectRuntime({ env: {}, which: n => (n === "docker" ? "/bin/docker" : null), probe: async c => (c.includes("compose") ? no : ok()) })).toMatchObject({ skip: expect.stringContaining("no Compose") });
  const missing = await detectRuntime({ env: { CONTAINER_CLI: "/nope/podman" }, which: () => null, exists: () => false, probe: async () => ok() });
  expect(missing.skip).toContain("/nope/podman: not found");
  expect(missing.skip).not.toContain("daemon not reachable");
});

test("skip decision: a loud banner; exit 0 unless the run must not skip", () => {
  const a = skipDecision("no usable container runtime (x)", false);
  expect(a.code).toBe(0);
  expect(a.banner).toContain("SKIPPED test:compose: no usable container runtime (x)");
  expect(a.banner).toContain("did NOT run");
  const b = skipDecision("why", true);
  expect(b.code).toBe(1);
  expect(b.banner).toContain("--require: failing");
});

test("alive: a live pid and EPERM (someone else's process) are alive; ESRCH is dead", () => {
  expect(alive(1, () => true)).toBe(true);
  expect(alive(1, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); })).toBe(true);
  expect(alive(1, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); })).toBe(false);
  expect(alive(process.pid)).toBe(true);
});

const HOST = { host: "h", boot: "b" };
const own = (pid, start = "S1", host = "h", boot = "b") => ownerString(pid, { host, boot, start });

test("owner strings round-trip; garbage does not parse", () => {
  expect(parseOwner(own(42))).toEqual({ host: "h", boot: "b", pid: 42, start: "S1" });
  expect(parseOwner("nonsense")).toBeNull();
  expect(parseOwner(undefined)).toBeNull();
});

test("ownerDead: only this host's provably dead owners; never self, a live pid, another host, or on doubt", () => {
  const dead = pid => ({ ...HOST, isAlive: p => p !== pid, startOf: () => "S1" });
  expect(ownerDead(parseOwner(own(7)), own(1), dead(7))).toBe(true);                                           // pid gone
  expect(ownerDead(parseOwner(own(7)), own(1), { ...HOST, isAlive: () => true, startOf: () => "S1" })).toBe(false);   // live, same start
  expect(ownerDead(parseOwner(own(7)), own(1), { ...HOST, isAlive: () => true, startOf: () => "S2" })).toBe(true);    // pid reused by another process
  expect(ownerDead(parseOwner(own(7)), own(1), { ...HOST, isAlive: () => true, startOf: () => null })).toBe(false);   // start unknown: doubt
  expect(ownerDead(parseOwner(own(7, "S1", "other")), own(1), dead(7))).toBe(false);                           // another host
  // A different boot id alone proves nothing (a clock step moves it while the run lives): only the pid and its start time decide.
  expect(ownerDead(parseOwner(own(7, "S1", "h", "oldboot")), own(1), { ...HOST, isAlive: () => true, startOf: () => "S1" })).toBe(false);
  expect(ownerDead(parseOwner(own(7, "S1", "h", "oldboot")), own(1), { ...HOST, isAlive: () => false, startOf: () => "S1" })).toBe(true);
  expect(ownerDead(parseOwner(own(7, "S1", "h", "oldboot")), own(1), { ...HOST, isAlive: () => true, startOf: () => "S2" })).toBe(true);
  // macOS start times are epoch seconds with a few seconds' tolerance: a small shift is the same process, a large one is not.
  expect(ownerDead(parseOwner(own(7, "epoch:1000")), own(1), { ...HOST, isAlive: () => true, startOf: () => "epoch:1003" })).toBe(false);
  expect(ownerDead(parseOwner(own(7, "epoch:1000")), own(1), { ...HOST, isAlive: () => true, startOf: () => "epoch:1010" })).toBe(true);
  expect(ownerDead(parseOwner(own(7)), own(7), dead(7))).toBe(false);                                           // itself
  expect(ownerDead(parseOwner(own(7, "S0")), own(7, "S1"), { ...HOST, isAlive: () => true, startOf: () => "S1" })).toBe(true);   // same pid, older start: a reused pid's leftover
});

test("sameStart: epoch times within 5 s match, anything else must be equal; the machine id is stable and not the hostname's job", () => {
  expect(sameStart("epoch:100", "epoch:105")).toBe(true);
  expect(sameStart("epoch:100", "epoch:106")).toBe(false);
  expect(sameStart("linux:b:123", "linux:b:123")).toBe(true);
  expect(sameStart("linux:b:123", "linux:b:124")).toBe(false);
  expect(sameStart("S1", "epoch:1")).toBe(false);
  expect(machineId()).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(machineId()).toBe(machineId());
});

/** A fake container CLI over a table of labelled objects, recording every removal. */
function fakeCli(objects) {
  const rm = [];
  const kindOf = a => (a[0] === "ps" ? "container" : a[0] === "network" ? "network" : a[0] === "volume" ? "volume" : a[0] === "images" ? "image" : null);
  const cli = async a => {
    if (["ps", "images"].includes(a[0]) || (["network", "volume"].includes(a[0]) && a[1] === "ls")) return ok(objects.filter(o => o.kind === kindOf(a)).map(o => o.id).join("\n"));
    if (a[0] === "inspect" || a[1] === "inspect") { const id = a.at(-1); const o = objects.find(x => x.id === id); return o ? ok(o.owner) : no; }
    if (a[0] === "rm" || a[0] === "rmi" || a[1] === "rm") { rm.push(a.at(-1)); return ok(); }
    return no;
  };
  return { cli, rm };
}

test("sweep removes a dead owner's containers, network, volume and image, and nothing else (live pid, own pid, EPERM, other host)", async () => {
  const objs = [
    ...["c1", "n1", "v1", "i1"].map((id, i) => ({ id, kind: ["container", "network", "volume", "image"][i], owner: own(100) })),   // dead
    { id: "c2", kind: "container", owner: own(200) },                    // live
    { id: "c3", kind: "container", owner: own(300) },                    // EPERM: alive
    { id: "c4", kind: "container", owner: own(1) },                      // self
    { id: "c5", kind: "container", owner: own(400, "S1", "elsewhere") }, // another host
    { id: "c6", kind: "container", owner: "garbage" },                   // unparsable
  ];
  const { cli, rm } = fakeCli(objs);
  const kill = pid => { if (pid === 100) throw Object.assign(new Error(), { code: "ESRCH" }); if (pid === 300) throw Object.assign(new Error(), { code: "EPERM" }); };
  const done = await sweep(cli, own(1), { ...HOST, isAlive: p => alive(p, kill), startOf: () => "S1" });
  expect(rm.sort()).toEqual(["c1", "i1", "n1", "v1"]);
  expect(done).toHaveLength(1);
  expect(done[0]).toContain("pid 100");
});

test("sweep with the same pid but an older start time removes that leftover, image included (a reused pid)", async () => {
  const { cli, rm } = fakeCli([{ id: "c1", kind: "container", owner: own(55, "OLD") }, { id: "i1", kind: "image", owner: own(55, "OLD") }, { id: "c2", kind: "container", owner: own(55, "NEW") }]);
  await sweep(cli, own(55, "NEW"), { ...HOST, isAlive: () => true, startOf: () => "NEW" });
  expect(rm.sort()).toEqual(["c1", "i1"]);
});

test("sweep stops at once when the run is interrupted", async () => {
  const { cli, rm } = fakeCli([{ id: "c1", kind: "container", owner: own(100) }]);
  await sweep(cli, own(1), { ...HOST, isAlive: () => false, startOf: () => "S1" }, () => true);
  expect(rm).toEqual([]);
});

test("run: a timeout has its own exit code, and an abort signal kills the child", async () => {
  const slow = await run(["sleep", "5"], { timeoutMs: 100 });
  expect(slow).toMatchObject({ code: TIMEOUT_CODE, timedOut: true, aborted: false });
  const ac = new AbortController();
  const p = run(["sleep", "5"], { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  expect(await p).toMatchObject({ code: 130, aborted: true });
  expect(await run(["true"], { signal: ac.signal })).toMatchObject({ aborted: true });
});

test("the real cluster file: all three nodes are gateway,host and behind the load balancer", () => {
  const c = readFileSync(join(ROOT, "deploy/cluster.compose.yml"), "utf8");
  expect(c.match(/PLENARY_ROLES: gateway,host/g)).toHaveLength(3);
  expect(c).not.toMatch(/PLENARY_ROLES: (gateway|host)\s*$/m);
  const lb = c.slice(c.indexOf("  lb:"));
  for (const n of ["app-1", "app-2", "app-3"]) expect(lb).toContain(`${n}:\n        condition: service_healthy`);
  expect(readFileSync(join(ROOT, "deploy/cluster/Caddyfile"), "utf8")).toContain("reverse_proxy app-1:8080 app-2:8080 app-3:8080");
});

test("the test override: short lease, no restart, random loopback ports, limits, owner labels; it does not change roles; the script is not part of `bun test` or test:cluster", () => {
  const o = readFileSync(join(ROOT, "deploy/cluster.compose.test.yml"), "utf8");
  expect(o).not.toContain("PLENARY_ROLES:");
  expect(o).toContain('PLENARY_LEASE_TTL_MS: "3000"');
  expect(o).toContain('restart: "no"');
  expect(o.match(/127\.0\.0\.1::\d+/g)).toHaveLength(2);   // the app nodes (one anchor) and postgres: never a fixed host port
  expect(o).not.toMatch(/\b8099\b/);
  expect(o).toContain("mem_limit");
  expect(o).toContain("plenary.c3.owner");
  for (const top of ["networks:", "volumes:"]) expect(o).toContain(`\n${top}\n`);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(pkg.scripts["test:compose"]).toContain("scripts/test-compose.js");
  expect(pkg.scripts["test:cluster"]).not.toContain("compose");
  const script = readFileSync(join(ROOT, "scripts/test-compose.js"), "utf8");
  expect(script).toContain('"down", "-v", "--remove-orphans"');
  expect(script.indexOf('process.on(sig, () => abortRun(sig))')).toBeLessThan(script.indexOf("await sweep("));   // signal handlers before the sweep
});

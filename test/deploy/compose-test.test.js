// Guards for the compose cluster test (#71, scripts/test-compose.js, deploy/cluster.compose.test.yml). The container
// test itself runs only through `bun run test:compose`; these check its parts without a container runtime.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectRuntime, projectsOf, pidOf, PROJECT_RE } from "../../scripts/test-compose.js";

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

test("runtime detection: nothing installed, a dead daemon, or no Compose is a skip that says why", async () => {
  expect(await detectRuntime({ env: {}, which: () => null, probe: async () => ok() })).toMatchObject({ skip: expect.stringContaining("docker: not found; podman: not found") });
  expect(await detectRuntime({ env: {}, which: n => (n === "docker" ? "/bin/docker" : null), probe: async () => no })).toMatchObject({ skip: expect.stringContaining("daemon not reachable") });
  expect(await detectRuntime({ env: {}, which: n => (n === "docker" ? "/bin/docker" : null), probe: async c => (c.includes("compose") ? no : ok()) })).toMatchObject({ skip: expect.stringContaining("no Compose") });
});

test("stale projects are read from network names, and only plenary-c3-<pid> projects", () => {
  expect(projectsOf(["bridge", "plenary-c3-123_default", "plenary-c3-123_default", "plenary-c3-9_default", "plenary-cluster_default", "x-plenary-c3-5_default"]).sort()).toEqual(["plenary-c3-123", "plenary-c3-9"]);
  expect(pidOf("plenary-c3-4242")).toBe(4242);
  expect(PROJECT_RE.test("plenary-c3-1x")).toBe(false);
});

test("the test override: every node hosts, short lease, no restart, random loopback ports, limits; and it is not part of `bun test` or test:cluster", () => {
  const o = readFileSync(join(ROOT, "deploy/cluster.compose.test.yml"), "utf8");
  expect(o).toContain("PLENARY_ROLES: gateway,host");
  expect(o).toContain('PLENARY_LEASE_TTL_MS: "3000"');
  expect(o).toContain('restart: "no"');
  expect(o.match(/127\.0\.0\.1::\d+/g)).toHaveLength(2);   // the app nodes (one anchor) and postgres: never a fixed host port
  expect(o).not.toMatch(/\b8099\b/);
  expect(o).toContain("mem_limit");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(pkg.scripts["test:compose"]).toContain("scripts/test-compose.js");
  expect(pkg.scripts["test:cluster"]).not.toContain("compose");
  const script = readFileSync(join(ROOT, "scripts/test-compose.js"), "utf8");
  expect(script).toContain('"down", "-v", "--remove-orphans"');
});

// Lints deploy/Dockerfile and the compose files without a container runtime (the build itself is the CI job
// `image` / scripts/image-smoke.sh). Guards: base pinned by digest, non-root numeric user, HEALTHCHECK, exec-form CMD,
// OCI labels from build args, one image name across both compose files.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// Instructions only: comments dropped, line continuations joined.
const docker = read("deploy/Dockerfile").replace(/\\\n/g, " ").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const instr = (name) => docker.filter((l) => l.toUpperCase().startsWith(name + " "));

test("base image is pinned by digest and the Bun version matches CI", () => {
  const [from] = instr("FROM");
  expect(from).toMatch(/^FROM oven\/bun:\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/);
  const ci = read(".github/workflows/ci.yml");
  const tag = /oven\/bun:(\d+\.\d+\.\d+)/.exec(from)[1];
  for (const m of ci.matchAll(/bun-version: (\S+)/g)) expect(m[1]).toBe(tag);
});

test("runs as a fixed numeric non-root user, with a HEALTHCHECK and an exec-form CMD", () => {
  const users = instr("USER");
  const last = users[users.length - 1];
  expect(last).toMatch(/^USER [1-9]\d*:[1-9]\d*$/);
  expect(instr("HEALTHCHECK").length).toBe(1);
  expect(instr("HEALTHCHECK")[0]).toContain("/health");
  expect(instr("HEALTHCHECK")[0]).not.toMatch(/\bcurl\b|\bwget\b/);
  const cmd = instr("CMD");
  expect(cmd.length).toBe(1);
  expect(cmd[0]).toMatch(/^CMD \[".*"\]$/); // exec form: bun is PID 1 and gets SIGTERM itself
});

test("dependencies come from the frozen lockfile, production only", () => {
  expect(docker.join("\n")).toMatch(/bun install --frozen-lockfile --production/);
  expect(docker.some((l) => /^COPY\s+\.\s/.test(l))).toBe(false); // never `COPY . .`
});

test("OCI labels are driven by build args", () => {
  const text = docker.join("\n");
  for (const a of ["VERSION", "REVISION", "CREATED"]) expect(text).toContain(`ARG ${a}=`);
  for (const k of ["source", "revision", "version"]) expect(text).toMatch(new RegExp(`org\\.opencontainers\\.image\\.${k}="`));
  expect(text).toContain('image.version="${VERSION}"');
  expect(text).toContain('image.revision="${REVISION}"');
});

test(".dockerignore keeps tests, design, .rig, node_modules and secrets out", () => {
  const ign = read(".dockerignore").split("\n").map((l) => l.trim());
  for (const p of ["test", "design", ".rig", "**/node_modules", "**/.env", "deploy", ".git"]) expect(ign).toContain(p);
  expect(ign).not.toContain("bun.lock");
});

test("both compose files use the same image name, selectable with PLENARY_IMAGE", () => {
  for (const f of ["deploy/compose.yml", "deploy/cluster.compose.yml"]) {
    expect(read(f)).toMatch(/^\s+image: \$\{PLENARY_IMAGE:-plenary:dev\}$/m);
  }
});

// A stock single node (server/main.js start(env), port 0, temp data dir) bootstraps each dev domain's tenant from
// PLENARY_DEV_TOKENS, so a dev token of that domain can POST /boards (into its personal space) and a user with no tenant can't (brief
// p5-devadmin, live finding S1). Plus the operator CLI (scripts/admin-bootstrap.js) in process, on SQLite.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";
import { run, parseArgs } from "../../scripts/admin-bootstrap.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";

const made = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "plenary-devadmin-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const ADMIN = "tok-admin-" + crypto.randomUUID(), MEMBER = "tok-member-" + crypto.randomUUID();
const TOKENS = {
  [ADMIN]: { name: "ann", role: "editor", domain: "acme.test", email: "ann@acme.test", admin: true },
  [MEMBER]: { name: "bob", role: "editor", domain: "acme.test", email: "bob@acme.test" },
};
// Only these keys: start() reads its argument, never process.env (so no DATABASE_URL from a checkout's .env).
const env = (dir, tokens = TOKENS) => ({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: JSON.stringify(tokens) });
const post = (app, token) => fetch(app.server.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "all hands" }) });

test("start(env): a dev token of the domain can POST /boards (201) and owns the board; a restart keeps one tenant", async () => {
  const dir = tempDir();
  let app = await start(env(dir));
  let tenantId;
  try {
    const t = await app.registry.tenantByDomain("acme.test");
    expect(t.admins).toEqual(["dev:ann"]);
    tenantId = t.id;
    const ok = await post(app, ADMIN);
    expect(ok.status).toBe(201);
    const { board } = await ok.json();
    expect(board.tenant).toBe(tenantId);
    expect(await app.registry.grant(board.id, "dev:ann")).toBe("owner");
    // Since #48 any member of the Unit makes boards in their personal space (no admin needed); a user with no Unit still can't (next test).
    const mine = await post(app, MEMBER);
    expect(mine.status).toBe(201);
    const made = (await mine.json()).board;
    expect(await app.registry.grant(made.id, "dev:bob")).toBe("owner");
    expect((await app.registry.space(made.space)).owner).toBe("dev:bob");
  } finally { await app.stop(); }

  // Restart on the same data dir, with bob flagged admin too and ann's flag dropped: same tenant, both admins.
  app = await start(env(dir, { [ADMIN]: { ...TOKENS[ADMIN], admin: undefined }, [MEMBER]: { ...TOKENS[MEMBER], admin: true } }));
  try {
    const t = await app.registry.tenantByDomain("acme.test");
    expect(t.id).toBe(tenantId);
    expect([...t.admins].sort()).toEqual(["dev:ann", "dev:bob"]);
    expect((await post(app, ADMIN)).status).toBe(201);
    expect((await post(app, MEMBER)).status).toBe(201);
  } finally { await app.stop(); }
}, 20000);

test("start(env): no admin token → no tenant from the dev path (POST /boards stays 403); a bad domain is skipped, not fatal", async () => {
  const dir = tempDir();
  const app = await start(env(dir, { [MEMBER]: TOKENS[MEMBER], x: { name: "zed", domain: "not a domain", admin: true } }));
  try {
    expect(await app.registry.tenantByDomain("acme.test")).toBe(null);
    expect((await post(app, MEMBER)).status).toBe(403);
  } finally { await app.stop(); }
}, 20000);

// ---- the CLI ----

const io = () => { const o = { out: [], err: [] }; return { o, io: { out: s => o.out.push(s), err: s => o.err.push(s) } }; };

test("CLI: creates the tenant on SQLite, prints one JSON line, re-runs as a no-op, adds a new admin", async () => {
  const dir = tempDir();
  const a = io();
  expect(await run(["--domain", "Acme.com", "--admin", "alice@acme.com", "--admin=dev:ann"], { PLENARY_DATA_DIR: dir }, a.io)).toBe(0);
  const first = JSON.parse(a.o.out[0]);
  expect(first).toMatchObject({ ok: true, registry: "sqlite", domain: "acme.com", created: true });
  expect([...first.added].sort()).toEqual(["dev:ann", "email:alice@acme.com"]);

  const b = io();
  expect(await run(["--domain", "acme.com", "--admin", "alice@acme.com"], { PLENARY_DATA_DIR: dir }, b.io)).toBe(0);
  expect(JSON.parse(b.o.out[0])).toMatchObject({ ok: true, tenant: first.tenant, created: false, added: [] });

  // --data-dir wins over PLENARY_DATA_DIR
  const other = tempDir(), c = io();
  expect(await run(["--domain", "acme.com", "--admin", "google:42", "--data-dir", dir], { PLENARY_DATA_DIR: other }, c.io)).toBe(0);
  expect(JSON.parse(c.o.out[0])).toMatchObject({ tenant: first.tenant, added: ["google:42"] });

  const r = sqliteRegistry({ path: join(dir, "registry.db") });
  try { expect([...(await r.tenantByDomain("acme.com")).admins].sort()).toEqual(["dev:ann", "email:alice@acme.com", "google:42"]); }
  finally { await r.close(); }
});

test("CLI: bad arguments exit 2 with usage and touch nothing", async () => {
  const dir = tempDir();
  for (const argv of [[], ["--admin", "dev:ann"], ["--domain", "acme.test"], ["--domain=acme.test", "--data-dir", dir], ["--domain"], ["--domain", "acme.com", "--nope"], ["--domain", "localhost"], ["--domain", "acme.com", "--admin", "ann"]]) {
    const x = io();
    expect(await run(argv, { PLENARY_DATA_DIR: dir }, x.io)).toBe(2);
    expect(x.o.out).toEqual([]);
    expect(x.o.err.join("\n").length).toBeGreaterThan(0);
  }
  expect(existsSync(join(dir, "registry.db"))).toBe(false);
  expect(parseArgs(["--domain=acme.com", "--admin", "a@acme.com", "--admin", "dev:b"])).toEqual({ domain: "acme.com", admins: ["a@acme.com", "dev:b"] });
});

test("CLI: an email admin off --domain, or a control character, exits 2 naming the entry and touches nothing", async () => {
  const dir = tempDir();
  for (const [bad, shown] of [["bob@evil.com", '"bob@evil.com"'], ["x@acme.com\u0007", '"x@acme.com\\u0007"']]) {
    const x = io();
    expect(await run(["--domain", "acme.com", "--admin", "dev:ann", "--admin", bad], { PLENARY_DATA_DIR: dir }, x.io)).toBe(2);
    expect(x.o.out).toEqual([]);
    expect(x.o.err.join("\n")).toContain(shown);
  }
  expect(existsSync(join(dir, "registry.db"))).toBe(false);
});

test("CLI: DEL, C1 CSI, RLO, ZWSP and NEL in an admin entry, a domain or an unknown flag reach stderr escaped, never raw", async () => {
  const dir = tempDir();
  const RAW = { DEL: "\u007f", CSI: "\u009b", RLO: "\u202e", ZWSP: "\u200b", NEL: "\u0085", LS: "\u2028", TAG: "\u{e0001}" };
  const enc = new TextEncoder();
  const has = (hay, needle) => { for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((b, j) => hay[i + j] === b)) return true; return false; };
  for (const [name, c] of Object.entries(RAW)) {
    for (const argv of [
      ["--domain", "acme.com", "--admin", "dev:a" + c + "nn"],              // admin entry (normAdmin)
      ["--domain", "acme" + c + ".com", "--admin", "dev:ann"],             // domain (normDomain)
      ["--domain", "acme.com", "--admin", "dev:ann", "--nope" + c + "[2J"], // unknown flag (parseArgs)
      ["--domain", "acme.com", "--admin", "dev:ann", "--x" + c + "=1"],     // unknown flag, inline value
    ]) {
      const x = io();
      expect(await run(argv, { PLENARY_DATA_DIR: dir }, x.io)).toBe(2);
      const err = x.o.err.join("\n");
      const bytes = enc.encode(err);
      expect(has(bytes, [...enc.encode(c)]), `${name} raw in: ${JSON.stringify(err)}`).toBe(false);
      expect(/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(err.replaceAll("\n", ""))).toBe(false);   // only usage's own newline
      const n = c.codePointAt(0);
      expect(err).toContain(n > 0xffff ? `\\u{${n.toString(16)}}` : "\\u" + n.toString(16).padStart(4, "0"));
    }
  }
  expect(existsSync(join(dir, "registry.db"))).toBe(false);
});

const UNSAFE_RE = new RegExp("[\\p{Cc}\\p{Cf}\\u2028\\u2029]", "u");

// p5-tidyv V1: the exit-1 `failed:` line echoes a path from argv or env. A real process, real stderr bytes; cwd is a
// temp dir and the env is explicit, so no checkout .env (DATABASE_URL) is loaded.
test("CLI process: a --data-dir or PLENARY_DATA_DIR with DEL, C1 CSI or RLO fails (exit 1) with stderr escaped, still JSON", async () => {
  const cwd = tempDir();
  const file = join(cwd, "not-a-dir");
  await Bun.write(file, "x");                                   // mkdir under a regular file fails, naming the path
  const script = join(import.meta.dir, "../../scripts/admin-bootstrap.js");
  const RAW = { DEL: String.fromCodePoint(0x7f), CSI: String.fromCodePoint(0x9b), RLO: String.fromCodePoint(0x202e), TAG: String.fromCodePoint(0xe0001) };
  const enc = new TextEncoder();
  const has = (hay, needle) => { for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((b, j) => hay[i + j] === b)) return true; return false; };
  for (const [name, c] of Object.entries(RAW)) {
    const dir = join(file, "d" + c + "2J");
    for (const [args, extra] of [[["--data-dir", dir], {}], [[], { PLENARY_DATA_DIR: dir }]]) {
      const p = Bun.spawn([process.execPath, script, "--domain", "acme.com", "--admin", "dev:ann", ...args], {
        cwd, env: { PATH: process.env.PATH ?? "", ...extra }, stdout: "pipe", stderr: "pipe",
      });
      const [code, errBytes, out] = [await p.exited, new Uint8Array(await new Response(p.stderr).arrayBuffer()), await new Response(p.stdout).text()];
      const label = `${name} ${args.length ? "--data-dir" : "PLENARY_DATA_DIR"}`;
      expect(code, label).toBe(1);
      expect(out, label).toBe("");
      expect(has(errBytes, [...enc.encode(c)]), label).toBe(false);
      const text = new TextDecoder().decode(errBytes).trim();
      expect(UNSAFE_RE.test(text), label).toBe(false);
      const line = JSON.parse(text);                             // still one valid JSON line
      expect(line.ok).toBe(false);
      expect(line.error).toStartWith("failed: ");
      expect(line.error).toContain("d" + c + "2J");              // and it round-trips to the real path
    }
  }
}, 30000);

test("CLI: a Registry it can't open exits 1 and never prints the URL", async () => {
  const x = io();
  const secret = "postgres://user:s3cr3t-pw@127.0.0.1:1/db";
  expect(await run(["--domain", "acme.com", "--admin", "dev:ann"], { DATABASE_URL: secret }, x.io)).toBe(1);
  expect(x.o.out).toEqual([]);
  expect(x.o.err.join("\n")).not.toContain("s3cr3t-pw");
}, 20000);

test("CLI: a database that accepts the connection and never answers fails with exit 1 after the timeout, naming no URL", async () => {
  // A TCP server that takes the connection and says nothing: the Postgres client waits for a handshake that never comes.
  const hang = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
  const x = io();
  const t = Date.now();
  try {
    const code = await run(["--domain", "acme.com", "--admin", "dev:ann"], { DATABASE_URL: `postgres://u:secretpw@127.0.0.1:${hang.port}/db` }, { ...x.io, timeoutMs: 700 });
    expect(code).toBe(1);
  } finally { hang.stop(true); }
  expect(Date.now() - t).toBeLessThan(5000);
  expect(JSON.parse(x.o.err[0])).toEqual({ ok: false, error: "failed: timed out after 1 s" });
  expect(x.o.err.join("") + x.o.out.join("")).not.toContain("secretpw");
}, 15000);

// The web app over HTTP (server/static.js, brief p-serve): an allowlist from the page's import graph, a deny list
// after it, exact-match lookups, safe paths, exact headers, ETag/304, and the engine routes unchanged.
// Most tests plant a temp web root (client's p6-hex is moving web/ files); one smoke test reads the real tree.
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { rig } from "./rig.js";
import { cleanup, tempDir } from "./helpers.js";
import { createServer } from "../../server/server.js";
import { staticSite, safePath, scanModule, scanHtml, denied, CSP, DEFAULT_MOUNTS } from "../../server/static.js";

afterAll(cleanup);

// Every deny-list entry, each imported from the planted main.js (or linked from index.html), each importing a file
// beyond it that must not be reached through it.
const DENIED = {
  "web/dev.js": "/dev.js",
  "web/collab/x.js": "/collab/x.js",
  "web/adapters/transport/shared-worker/client.js": "/adapters/transport/shared-worker/client.js",
  "web/adapters/auth/fake.js": "/adapters/auth/fake.js",
  "web/adapters/collab/fake.js": "/adapters/collab/fake.js",
  "web/adapters/transport/local.js": "/adapters/transport/local.js",
  "web/adapters/clock/virtual.js": "/adapters/clock/virtual.js",
  "web/core/clock/virtual.js": "/core/clock/virtual.js",
  "web/test/t.js": "/test/t.js",
  "web/docs/d.js": "/docs/d.js",
  "web/server/s.js": "/server/s.js",
  "web/node_modules/n.js": "/node_modules/n.js",
  "web/.hidden.js": "/.hidden.js",
  "web/.git/h.js": "/.git/h.js",
};

function plant() {
  const root = tempDir("plenary-static-");
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put("web/index.html", `<!doctype html><link rel="stylesheet" href="style.css"><link rel="prefetch" href="dev.html">
<!-- <script src="commented.js"></script> --><script type="module" src="main.js"></script>`);
  put("web/style.css", "body{}");
  put("web/dev.html", "<p>dev</p>");
  put("web/commented.js", "");
  put("web/main.js", [
    `import { a } from "./a.js";`,
    `export { b } from "./sub/b.js";`,
    `import "./side.js";`,
    `import { editor } from "../packages/core/editor.js";`,
    `const lazy = await import("./lazy.js");`,
    `const w = new URL("./worker.js", import.meta.url);`,
    `/** @type {import("./typeonly.js").T} */`,
    `// import "./commented-import.js";`,
    `const name = "./computed.js"; await import(name);`,
    `import "./link.js";`,
    `import "./data.txt";`,
    `import "./missing.js";`,
    `import "bare-package";`,
    ...Object.keys(DENIED).map(f => `import "./${f.slice(4)}";`),
    `import "../test/outside.js";`,
  ].join("\n"));
  for (const f of ["a.js", "sub/b.js", "side.js", "lazy.js", "worker.js", "typeonly.js", "commented-import.js", "computed.js", "data.txt", "orphan.js"])
    put("web/" + f, "");
  for (const f of Object.keys(DENIED)) put(f, `import "./beyond-${f.replace(/\W/g, "_")}.js";`);
  for (const f of Object.keys(DENIED)) put(join(dirname(f), `beyond-${f.replace(/\W/g, "_")}.js`), "export const x = 1;");
  put("test/outside.js", "");
  put("secret.js", "export const secret = 1;");
  symlinkSync(join(root, "secret.js"), join(root, "web/link.js"));
  put("packages/core/editor.js", `import { m } from "./model.js";\nimport { r } from "../protocol/room.js";`);
  put("packages/core/model.js", "export const m = 1;");
  put("packages/core/unused.js", "");
  put("packages/protocol/room.js", "export const r = 1;");
  const mounts = [
    { url: "/", dir: join(root, "web") },
    { url: "/packages/core/", dir: join(root, "packages/core") },
    { url: "/packages/protocol/", dir: join(root, "packages/protocol") },
  ];
  return { root, mounts, put };
}

const logs = () => { const lines = []; return { lines, info: (msg, f) => lines.push({ level: "info", msg, ...f }), warn: (msg, f) => lines.push({ level: "warn", msg, ...f }) }; };
const get = (site, path, init = {}) => site.handle(new Request("http://x" + path, init));

test("the allowlist is the page's graph: entries, static, re-export, side-effect, import(), new URL(), packages/ through relative imports", () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  expect([...site.files.keys()].sort()).toEqual([
    "/a.js", "/index.html", "/lazy.js", "/main.js", "/packages/core/editor.js", "/packages/core/model.js",
    "/packages/protocol/room.js", "/side.js", "/style.css", "/sub/b.js", "/worker.js",
  ]);
});

test("what the scan leaves out is logged at start-up with why: computed import(), bare, missing, unknown type, symlink out, outside, denied", () => {
  const p = plant(), log = logs();
  const site = staticSite({ mounts: p.mounts, log });
  const why = site.skipped.map(s => `${s.why} ${s.url ?? s.spec}`);
  expect(why).toContain("computed import() (not resolvable statically) import(name)");
  expect(why).toContain("not a relative path bare-package");
  expect(why).toContain("missing /missing.js");
  expect(why).toContain("unknown file type /data.txt");
  expect(why).toContain("symlink leaves its root /link.js");
  expect(why).toContain("outside every mount ../test/outside.js");
  expect(why).toContain("denied: web/dev*.html|js (dev pages and their roots) /dev.html");
  for (const url of Object.values(DENIED)) expect(site.skipped.some(s => s.url === url && s.why.startsWith("denied:"))).toBe(true);
  expect(log.lines.filter(l => l.level === "warn").length).toBe(site.skipped.length);
  expect(log.lines.find(l => l.level === "info")).toMatchObject({ msg: "static: serving", files: site.files.size });
  // the importer is named, so a denied-but-imported file is easy to trace
  expect(site.skipped.find(s => s.url === "/collab/x.js")).toMatchObject({ from: "/main.js", spec: "./collab/x.js", how: "import" });
});

test("every deny-list path is 404 even though the page imports it, and the walk never goes past it", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  for (const url of [...Object.values(DENIED), "/dev.html"]) {
    expect([url, (await get(site, url))?.status ?? 404]).toEqual([url, 404]);
    expect(site.files.has(url)).toBe(false);
  }
  expect([...site.files.keys()].filter(u => u.includes("beyond"))).toEqual([]);
});

test("the deny rules themselves, by path", () => {
  for (const u of ["/dev.html", "/dev.js", "/collab/a.js", "/collab/x/y.css", "/adapters/transport/shared-worker/worker.js",
    "/adapters/storage/fake.js", "/adapters/clock/virtual.js", "/adapters/collab/fake.js", "/adapters/transport/local.js", "/collab/dev.html", "/x/clock/virtual.js", "/packages/core/clock/virtual.js",
    "/dev-main.js", "/dev-main.html", "/core/dev-users.js", "/adapters/storage/memory.js",
    "/test/a.js", "/a/test/b.js", "/docs/a.html", "/server/main.js", "/.env", "/a/.git/config", "/node_modules/x.js"])
    expect([u, !!denied(u)]).toEqual([u, true]);
  for (const u of ["/index.html", "/main.js", "/adapters/dom/app.js", "/adapters/transport/ws.js", "/adapters/clock/browser.js",
    "/core/users.js", "/x/dev.js", "/adapters/storage/idb.js", "/packages/core/editor.js", "/adapters/dom/collab/ui.js", "/fake.js",
    "/adapters/collab/sync.js", "/adapters/collab/x.js"])
    expect([u, !!denied(u)]).toEqual([u, false]);
});

test("not in the graph is 404: an orphan file, a package file nothing imports, a JSDoc type import, a commented import", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  for (const u of ["/orphan.js", "/packages/core/unused.js", "/typeonly.js", "/commented-import.js", "/commented.js", "/computed.js", "/link.js", "/secret.js", "/data.txt"])
    expect([u, (await get(site, u))?.status ?? 404]).toEqual([u, 404]);
});

test("/ serves index.html; modules and packages/ resolve with 200 and the right MIME type; style.css is text/css", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  const want = { "/": "text/html; charset=utf-8", "/index.html": "text/html; charset=utf-8", "/style.css": "text/css",
    "/main.js": "text/javascript", "/packages/core/editor.js": "text/javascript", "/packages/core/model.js": "text/javascript",
    "/packages/protocol/room.js": "text/javascript" };
  for (const [u, type] of Object.entries(want)) {
    const res = await get(site, u);
    expect([u, res.status, res.headers.get("content-type")]).toEqual([u, 200, type]);
  }
  expect(await (await get(site, "/")).text()).toContain(`src="main.js"`);
});

test("headers are exact: CSP, nosniff, no-referrer, no-cache, a strong ETag", async () => {
  const p = plant();
  const res = await get(staticSite({ mounts: p.mounts }), "/main.js");
  expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  expect(CSP).toBe(res.headers.get("content-security-policy"));
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{43}"$/);   // strong (no W/): sha-256, base64url
  expect([...res.headers.keys()].sort()).toEqual(["cache-control", "content-security-policy", "content-type", "etag", "referrer-policy", "x-content-type-options"]);
});

test("ETag: a matching If-None-Match gives 304 with no body (also W/ and lists); another tag gives 200; an edit changes the tag", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  const etag = (await get(site, "/a.js")).headers.get("etag");
  for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
    const res = await get(site, "/a.js", { headers: { "if-none-match": inm } });
    expect([inm, res.status, await res.text()]).toEqual([inm, 304, ""]);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  }
  expect((await get(site, "/a.js", { headers: { "if-none-match": `"other"` } })).status).toBe(200);
  p.put("web/a.js", "export const a = 2;");
  const res = await get(site, "/a.js", { headers: { "if-none-match": etag } });
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).not.toBe(etag);
  expect(await res.text()).toBe("export const a = 2;");
});

test("GET and HEAD only; HEAD has the headers and no body", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  const head = await get(site, "/main.js", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("text/javascript");
  expect(head.headers.get("etag")).toBe((await get(site, "/main.js")).headers.get("etag"));
  expect(await head.text()).toBe("");
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) expect([method, await get(site, "/main.js", { method })]).toEqual([method, null]);
});

test("safePath refuses traversal, encoded traversal, NUL, backslashes, empty and dot segments (raw strings)", () => {
  for (const p of ["/../etc/passwd", "/a/../main.js", "/..", "/%2e%2e/x", "/%2E%2E/x", "/.%2e/x", "/a%2fb", "/a%2Fb", "/a%5cb",
    "/a%00b", "/a\0b", "/a\\b", "/\\x", "//etc/passwd", "/a//b", "/./main.js", "/a/./b", "/a/", "etc/passwd", "C:/x", "",
    "/" + "a".repeat(1100)])
    expect([p, safePath(p)]).toEqual([p, false]);
  for (const p of ["/", "/main.js", "/packages/core/editor.js", "/a-b_c.d.js"]) expect([p, safePath(p)]).toEqual([p, true]);
});

// Raw HTTP: fetch() and new URL() normalise the path before sending, so these go over a socket as written.
function raw(port, target) {
  return new Promise((ok, fail) => {
    const c = connect(port, "127.0.0.1");
    let b = "";
    c.on("data", d => { b += d; });
    c.on("end", () => ok(Number(b.split(" ")[1])));
    c.on("error", fail);
    c.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

test("over a real server: every traversal form is 404 (raw request targets, not normalised by a client)", async () => {
  const p = plant(), r = await rig();
  const s = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, static: { mounts: p.mounts } });
  try {
    expect(await raw(s.port, "/main.js")).toBe(200);
    for (const t of ["/../secret.js", "/../../secret.js", "/%2e%2e/secret.js", "/%2E%2E/%2e%2e/secret.js", "/..%2fsecret.js",
      "/%2e%2e%2fsecret.js", "/..\\secret.js", "/%5c..%5csecret.js", "/main.js%00", "/main.js%00.html", "//secret.js",
      "/../test/outside.js", "/collab%2fx.js", "/adapters%2ftransport%2fshared-worker%2fclient.js", "/%2edev.js", "/.%2e/secret.js",
      "/link.js", "/sub/../dev.js", "/collab/../collab/x.js", "/../../../../etc/passwd", "/..%5c..%5cetc/passwd"])
      expect([t, await raw(s.port, t)]).toEqual([t, 404]);
  } finally { await s.stop(); await r.stop(); }
});

test("over a real server: /health and /ws unchanged; unknown paths and POST / are 404; static: false gives 404 at /", async () => {
  const p = plant(), r = await rig();
  const s = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, static: { mounts: p.mounts } });
  const off = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, static: false });
  try {
    const h = await fetch(s.url + "/health");
    expect(h.status).toBe(200);
    expect(h.headers.get("content-type")).toBe("application/json");
    expect(await h.json()).toMatchObject({ ok: true });
    expect((await fetch(s.url + "/ws")).status).toBe(426);
    expect((await fetch(s.url + "/nope")).status).toBe(404);
    expect((await fetch(s.url + "/", { method: "POST" })).status).toBe(404);
    expect((await fetch(s.url + "/")).status).toBe(200);
    expect((await fetch(off.url + "/")).status).toBe(404);
    expect((await fetch(off.url + "/main.js")).status).toBe(404);
    expect((await fetch(off.url + "/health")).status).toBe(200);
    expect(off.site).toBe(null);
  } finally { await s.stop(); await off.stop(); await r.stop(); }
});

test("platform's http routes keep precedence over static", async () => {
  const p = plant(), r = await rig();
  const s = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, static: { mounts: p.mounts },
    http: (req, url) => (url.pathname === "/main.js" ? new Response("platform") : null) });
  try {
    expect(await (await fetch(s.url + "/main.js")).text()).toBe("platform");
    expect((await fetch(s.url + "/a.js")).status).toBe(200);
  } finally { await s.stop(); await r.stop(); }
});

test("the scanners: Bun's parser for JS (comments and strings add nothing), tags for HTML (comments add nothing)", () => {
  const { specs, computed } = scanModule([
    `import x from "./x.js"; import{y}from'./y.js'`,
    `export * from "./z.js";`,
    `/** @returns {import("./type.js").T} */`,
    `// import "./c.js";`,
    `/* import d from "./d.js"; */`,
    `const s = 'import "./str.js"';`,
    `const u = new URL( "./w.js" , import.meta.url );`,
    `new URL("./not-relative-to-module.js", location.href);`,
    `import(\`./t.js\`); import(spec);`,
  ].join("\n"));
  expect(specs.map(s => s.spec).sort()).toEqual(["./t.js", "./w.js", "./x.js", "./y.js", "./z.js"]);
  expect(computed).toEqual(["import(spec)"]);
  expect(scanHtml(`<script src="a.js"></script><!-- <script src="b.js"> --><link rel=stylesheet href='c.css'><a href="d.html">`).map(s => s.spec))
    .toEqual(["a.js", "c.css"]);
});

// p-servev H1: round 1's regex started a match at "import" inside a comment and ran on to the next real `from "…"`,
// then dropped the whole match as a comment, so the real import vanished (web/adapters/storage/session.js lost
// ../../ports/storage.js).
const H1_SHAPE = [
  `// Storage adapter. Same few lines as local.js on purpose: adapters never import each other.`,
  `// More words with no quote or semicolon`,
  ``,
  `import { STORAGE_UNAVAILABLE } from "../../ports/storage.js";`,
].join("\n");

test("H1: a comment with the word import does not swallow the next real import (scanner)", () => {
  expect(scanModule(H1_SHAPE).specs.map(s => s.spec)).toEqual(["../../ports/storage.js"]);
  const block = `/* adapters never import each other\n   and so on */\nexport { a } from "./a.js";\nimport "./side.js";`;
  expect(scanModule(block).specs.map(s => s.spec)).toEqual(["./a.js", "./side.js"]);
});

test("H1: through staticSite, the module behind such a comment is served (planted root)", async () => {
  const root = tempDir("plenary-static-h1-");
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put("web/index.html", `<script type="module" src="main.js"></script>`);
  put("web/main.js", `import { sessionStore } from "./adapters/storage/session.js";`);
  put("web/adapters/storage/session.js", H1_SHAPE + `\nexport const sessionStore = () => STORAGE_UNAVAILABLE;`);
  put("web/ports/storage.js", `export const STORAGE_UNAVAILABLE = "storage-unavailable";`);
  const site = staticSite({ mounts: [{ url: "/", dir: join(root, "web") }] });
  expect([...site.files.keys()].sort()).toEqual(["/adapters/storage/session.js", "/index.html", "/main.js", "/ports/storage.js"]);
  expect((await get(site, "/ports/storage.js")).status).toBe(200);
});

test("a module that doesn't parse is logged, and nothing it imports is served", () => {
  const root = tempDir("plenary-static-bad-");
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "web/main.js"), `import "./a.js";\nthis is not javascript (`);
  writeFileSync(join(root, "web/a.js"), "");
  const site = staticSite({ mounts: [{ url: "/", dir: join(root, "web") }] });
  expect([...site.files.keys()]).toEqual(["/main.js"]);
  expect(site.skipped.map(s => s.why)).toEqual(["unparseable (its imports are not served)"]);
});

// An independent crawl: Bun's bundler resolves web/main.js's graph (its metafile lists each input's imports); walk it
// from main.js, stop at denied files (the walk never goes past them), and map paths to URLs by mount.
async function bundlerGraph() {
  const repo = join(import.meta.dir, "../..");
  const r = await Bun.build({ entrypoints: [join(repo, "web/main.js")], target: "browser", metafile: true, write: false });
  expect(r.success).toBe(true);
  const abs = k => resolve(process.cwd(), k);
  const inputs = new Map(Object.entries(r.metafile.inputs).map(([k, v]) => [abs(k), v.imports.map(i => abs(i.path))]));
  const toUrl = f => {
    const rel = relative(repo, f).split("\\").join("/");
    if (rel.startsWith("web/")) return "/" + rel.slice(4);
    if (rel.startsWith("packages/core/") || rel.startsWith("packages/protocol/")) return "/" + rel;
    return null;
  };
  // index.html's own stylesheets, read with a plain regex here (not static.js's scanHtml), so the crawl stays independent.
  const html = await Bun.file(join(repo, "web/index.html")).text();
  const sheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(m => "/" + m[1]);
  const served = new Set(["/index.html", ...sheets.filter(u => !denied(u))]), seen = new Set(), q = [join(repo, "web/main.js")];
  while (q.length) {
    const f = q.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const u = toUrl(f);
    if (!u || denied(u)) continue;
    served.add(u);
    q.push(...(inputs.get(f) ?? []));
  }
  return [...served].sort();
}

test("the real tree: the allowlist equals an independent crawl of web/main.js (Bun's bundler), minus the deny list", async () => {
  const site = staticSite();
  expect([...site.files.keys()].sort()).toEqual(await bundlerGraph());
  expect(site.files.has("/ports/storage.js")).toBe(true);   // p-servev H1, while main.js imports a storage adapter
});

test("the real tree: defaults come from static.js's own path; / and main.js and a packages/ module are served", async () => {
  expect(DEFAULT_MOUNTS.map(m => m.url)).toEqual(["/", "/packages/core/", "/packages/protocol/"]);
  expect(DEFAULT_MOUNTS[0].dir).toBe(join(import.meta.dir, "../../web"));
  const site = staticSite();
  for (const u of ["/", "/main.js", "/style.css"]) expect([u, (await get(site, u)).status]).toEqual([u, 200]);
  expect([...site.files.keys()].some(u => u.startsWith("/packages/core/"))).toBe(true);
  expect([...site.files.keys()].some(u => u.startsWith("/packages/protocol/"))).toBe(true);
  for (const u of ["/dev.html", "/dev.js", "/collab/dev.js", "/adapters/clock/virtual.js", "/adapters/auth/fake.js", "/adapters/collab/fake.js",
    "/adapters/transport/local.js", "/adapters/transport/shared-worker/client.js"])
    expect([u, (await get(site, u))?.status ?? 404]).toEqual([u, 404]);
});

test("E-5: immutable /v/<build>/... serves from startup memory cache with max-age=31536000, immutable; wrong build or index.html is 404", async () => {
  const p = plant();
  const site = staticSite({ mounts: p.mounts });
  expect(site.build).toMatch(/^[A-Za-z0-9_-]{12}$/);

  const res = await get(site, `/v/${site.build}/main.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("content-type")).toBe("text/javascript");
  const etag = res.headers.get("etag");
  expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);

  // 304 on matching If-None-Match keeps immutable cache-control.
  const r304 = await get(site, `/v/${site.build}/main.js`, { headers: { "if-none-match": etag } });
  expect(r304.status).toBe(304);
  expect(r304.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

  // Wrong build id, index.html under /v/, and denied paths under /v/ are all 404.
  expect(await get(site, `/v/wrongbuildid/main.js`)).toBe(null);
  expect(await get(site, `/v/${site.build}/index.html`)).toBe(null);
  expect(await get(site, `/v/${site.build}/dev.js`)).toBe(null);

  // Immutable URL and cache:true both serve startup bytes even if the file changes on disk.
  const cached = staticSite({ mounts: p.mounts, cache: true });
  const orig = await res.text();
  p.put("web/main.js", "export const changed = 1;");
  expect(await (await get(site, `/v/${site.build}/main.js`)).text()).toBe(orig);
  p.put("web/a.js", "export const a = 999;");
  expect(await (await get(cached, "/a.js")).text()).toBe("");
});

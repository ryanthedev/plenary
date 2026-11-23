// @ts-check
// The web app over HTTP (brief p-serve): a driving adapter that serves the canvas page and the modules it imports.
// It imports only node: built-ins (no room host, gateway or driven adapter), and server.js mounts it as the last
// fallback, after /health, /ws and platform's routes.
//
// Mounts (URL prefix -> folder): "/" -> web/, "/packages/core/" -> packages/core/, "/packages/protocol/" ->
// packages/protocol/. The page imports packages by relative path ("../../../packages/core/editor.js"), which the
// browser resolves to /packages/core/editor.js.
//
// ALLOWLIST, NEVER A DIRECTORY. At start-up the servable set is built once: index.html, style.css, the relative
// src/href of index.html, and the import graph of main.js (static imports, re-exports, side-effect imports,
// `import("literal")`, `new URL("literal", import.meta.url)`, which covers `new Worker(new URL(...))`). A request is an
// exact lookup in that map; request text is never joined onto a folder. A file added later is not served until a
// restart. Anything the scan can't resolve (a computed import(), a bare specifier, a target outside every mount, a
// missing file, an unknown file type, a symlink leaving its root) is logged at start-up and left out.
// Parser: Bun's own (Bun.Transpiler, see scanModule), so comments and strings never add or hide an import.
// index.html: only RELATIVE src/href are followed ("main.js", "./x.css"). An absolute one ("/main.js",
// "https://...") is skipped and logged as "not a relative path"; main.js and style.css are served anyway as fixed
// entries, but any other file referenced absolutely from index.html is 404 (p-servev L2).
//
// DENY LIST, checked after the allowlist. These are never served even when the page imports them: the importer is
// logged (warn) and the walk does not go past them. See DENY below.
//
// Requests: GET and HEAD only. "/" serves index.html. Paths with an encoded dot, slash, backslash or NUL, a
// backslash, a NUL, a "." or ".." segment, or an empty segment are refused (Bun already collapses literal ".." and
// "\" before the handler sees the URL; the exact-match map is the real guard). Not served -> null, and server.js
// answers its usual 404.
// Headers: the CSP below, nosniff, no-referrer, the file's MIME type, a strong ETag (sha-256 of the bytes, computed
// once at start-up and cached in memory; refreshed only when mtime/size changes unless `cache: true`), and 304 on a
// matching If-None-Match. Unversioned paths carry `Cache-Control: no-cache`; versioned `/v/<build>/...` paths (E-5)
// serve from the startup memory cache with `Cache-Control: public, max-age=31536000, immutable`.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");

/** Default mounts: resolved from this file's own path, never from the working directory. */
export const DEFAULT_MOUNTS = Object.freeze([
  { url: "/", dir: join(REPO, "web") },
  { url: "/packages/core/", dir: join(REPO, "packages", "core") },
  { url: "/packages/protocol/", dir: join(REPO, "packages", "protocol") },
]);

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "frame-src https://www.youtube-nocookie.com; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export const MIME = Object.freeze({
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
});

/**
 * Never served, even when reached from the page. Tested on the URL path (e.g. "/collab/x.js", "/packages/core/a.js").
 * web/dev*.html|js, web/core/dev-users.js, web/adapters/storage/memory.js (p7-archtest C-16), web/collab/**, web/adapters/transport/shared-worker/**, web/adapters/transport/local.js
 * and web/adapters/<x>/fake.js are web-root rules (client's list, t18m 2026-11-12). web/adapters/collab/ is served
 * (sync.js is the production collab adapter); its fake.js is covered by the <x>/fake.js rule; clock/virtual.js, test/, docs/, server/, node_modules/ and dotfiles are denied at any depth.
 */
export const DENY = Object.freeze([
  { why: "web/dev*.html|js (dev pages and their roots)", test: p => /^\/dev[^/]*\.(js|html)$/.test(p) },
  { why: "web/core/dev-users.js (dev token table)", test: p => p === "/core/dev-users.js" },
  { why: "web/adapters/storage/memory.js (test store)", test: p => p === "/adapters/storage/memory.js" },
  { why: "web/collab/** (dev harness)", test: p => p.startsWith("/collab/") },
  { why: "web/adapters/transport/shared-worker/** (in-browser dev room)", test: p => p.startsWith("/adapters/transport/shared-worker/") },
  { why: "web/adapters/transport/local.js (in-page dev room)", test: p => p === "/adapters/transport/local.js" },
  { why: "web/adapters/*/fake.js (test fakes)", test: p => /^\/adapters\/[^/]+\/fake\.js$/.test(p) },
  { why: "clock/virtual.js (test clock)", test: p => /(^|\/)clock\/virtual\.js$/.test(p) },
  { why: "test/, docs/, server/, node_modules/", test: p => p.split("/").some(s => ["test", "docs", "server", "node_modules"].includes(s)) },
  { why: "dotfile", test: p => p.split("/").some(s => s.startsWith(".")) },
]);

/** The deny rule that matches URL path `p`, or null. */
export const denied = p => DENY.find(d => d.test(p)) ?? null;

/**
 * Is `pathname` (as the URL parser left it) a shape we could ever serve? Pure, so raw request text is testable here
 * even though Bun normalises "..", "\" and "%2e%2e" before a handler sees it.
 */
export function safePath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 1024) return false;
  if (/%(2e|2f|5c|00)/i.test(pathname)) return false;          // encoded ".", "/", "\", NUL
  if (/[\\\0]/.test(pathname)) return false;                    // backslash, NUL
  if (pathname === "/") return true;
  const segs = pathname.slice(1).split("/");
  return segs.every(s => s !== "" && s !== "." && s !== "..");   // no "//", "/./", "/../", no trailing "/"
}

// ---- the import scan: Bun's own parser (round 2, p-servev H1) ----
// Imports come from Bun.Transpiler.scanImports, which parses the module, so a comment or a string that mentions
// "import" can't add or hide one (round 1's regexes could: a comment with the word "import" swallowed the next real
// import). Bun-specific code is fine here: this is the server's HTTP adapter, not code that runs in Herdr.
// scanImports doesn't report `new URL("literal", import.meta.url)` (the Worker/SharedWorker pattern) or a computed
// import(), so those two are matched on transformSync's output, which has every comment removed. A string literal
// whose text looks like `new URL("./x.js", import.meta.url)` would still match: that only adds a file that exists in
// a mount and passes the deny list, so the cost is over-serving one file, never escaping the allowlist.

const transpiler = new Bun.Transpiler({ loader: "js" });
const NEWURL = /\bnew\s+URL\(\s*(["'\x60])([^"'\x60$]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const DYN_ANY = /\bimport\(\s*([^\s)])/g;
const HOW = { "import-statement": "import", "dynamic-import": "import()" };

/**
 * The specifiers a JS module loads at run time: `{ spec, how }`; `computed` lists import() calls with no literal.
 * Throws if `src` is not valid JavaScript (the caller logs it and serves nothing it would import).
 */
export function scanModule(src) {
  const specs = transpiler.scanImports(src).map(i => ({ spec: i.path, how: HOW[i.kind] ?? i.kind }));
  const code = transpiler.transformSync(src);
  const computed = [];
  for (const m of code.matchAll(NEWURL)) specs.push({ spec: m[2], how: "new URL()" });
  for (const m of code.matchAll(DYN_ANY)) {
    if (`"'\``.includes(m[1])) continue;
    computed.push(code.slice(m.index, code.indexOf(")", m.index) + 1 || m.index + 40).slice(0, 80));
  }
  return { specs, computed };
}

/** Relative src/href of <script> and <link> tags in an HTML page (plus `rel` on <link> tags). */
export function scanHtml(src) {
  const out = [];
  for (const tag of src.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(script|link)\b[^>]*>/gi)) {
    let rel = "";
    if (tag[1].toLowerCase() === "link") {
      const rm = /\brel\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i.exec(tag[0]);
      rel = (rm?.[1] ?? rm?.[2] ?? "").trim().toLowerCase();
    }
    for (const m of tag[0].matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gi))
      out.push({ spec: m[2], how: `<${tag[1]} ${m[1]}>`, ...(rel ? { rel } : {}) });
  }
  return out;
}

/** Icon `src` URLs declared in a Web App Manifest JSON file. Throws if `src` is not valid JSON. */
export function scanManifest(src) {
  const m = JSON.parse(src);
  const out = [];
  if (m && Array.isArray(m.icons)) {
    for (const icon of m.icons) {
      if (icon && typeof icon.src === "string" && icon.src.trim()) out.push({ spec: icon.src, how: "manifest icon" });
    }
  }
  return out;
}

const PWA_LINK_RELS = new Set(["manifest", "icon", "apple-touch-icon", "shortcut icon"]);

const isRelative = s => s.startsWith("./") || s.startsWith("../");
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const real = p => { try { return realpathSync(p); } catch { return null; } };
const extOf = p => { const i = p.lastIndexOf("."); return i > p.lastIndexOf("/") ? p.slice(i).toLowerCase() : ""; };

/**
 * Build the servable set and the request handler.
 * @param {{ mounts?: readonly { url: string, dir: string }[], log?: { info: Function, warn: Function }, cache?: boolean }} [o]
 *   mounts: URL prefix (ends with "/") -> folder; the first is the web root (index.html, style.css, main.js).
 * @returns {{ handle: (req: Request, url?: URL) => Promise<Response | null>, files: Map<string, string>, skipped: object[], build: string }}
 *   files: URL path -> real file path (what is served). skipped: what the scan found and left out, with why.
 */
export function staticSite({ mounts = DEFAULT_MOUNTS, log = { info() {}, warn() {} }, cache = false } = {}) {
  const roots = mounts.map(m => ({ url: m.url, dir: resolve(m.dir), real: real(resolve(m.dir)) })).filter(m => m.real);
  const web = roots.find(m => m.url === "/");
  const files = new Map(), skipped = [], seen = new Set();
  const skip = (why, fields) => { skipped.push({ why, ...fields }); log.warn("static: not served", { why, ...fields }); };

  /** Disk path -> URL path through the mount it falls under, or null. */
  const urlOf = abs => {
    for (const m of roots) {
      const rel = relative(m.dir, abs);
      if (rel && !rel.startsWith("..") && !rel.includes(":") && !rel.split(sep).includes("..")) return { url: m.url + rel.split(sep).join("/"), mount: m };
    }
    return null;
  };

  const queue = [];
  const add = (abs, from, spec, how) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const at = urlOf(abs);
    const fields = { from, spec, how };
    if (!at) return skip("outside every mount", fields);
    const d = denied(at.url);
    if (d) return skip(`denied: ${d.why}`, { ...fields, url: at.url });
    if (!safePath(at.url)) return skip("unsafe path", { ...fields, url: at.url });
    if (!MIME[extOf(at.url)]) return skip("unknown file type", { ...fields, url: at.url });
    if (!isFile(abs)) return skip("missing", { ...fields, url: at.url });
    const r = real(abs);
    if (!r || !r.startsWith(at.mount.real + sep)) return skip("symlink leaves its root", { ...fields, url: at.url });
    files.set(at.url, r);
    queue.push({ abs, url: at.url });
  };

  if (web) {
    for (const f of ["index.html", "style.css", "main.js"]) if (isFile(join(web.dir, f))) add(join(web.dir, f), "(entry)", f, "entry");
    while (queue.length) {
      const { abs, url } = queue.shift();
      const ext = extOf(abs);
      if (ext !== ".js" && ext !== ".mjs" && ext !== ".html" && ext !== ".webmanifest") continue;
      let src;
      try { src = readFileSync(abs, "utf8"); } catch (err) { skip("unreadable", { from: url, err }); continue; }
      let scanned;
      try {
        scanned = ext === ".html" ? { specs: scanHtml(src), computed: [] }
          : ext === ".webmanifest" ? { specs: scanManifest(src), computed: [] }
          : scanModule(src);
      } catch (err) { skip("unparseable (its imports are not served)", { from: url, err }); continue; }
      const { specs, computed } = scanned;
      for (const c of computed) skip("computed import() (not resolvable statically)", { from: url, spec: c, how: "import()" });
      for (const { spec, how, rel } of specs) {
        const clean = spec.split(/[?#]/)[0];
        if (!isRelative(clean)) {
          if ((ext === ".html" || ext === ".webmanifest") && /^[\w-]+(\/[\w.-]+)*\.\w+$/.test(clean)) {
            add(resolve(dirname(abs), clean), url, spec, how);
            continue;
          }
          if ((ext === ".webmanifest" || (ext === ".html" && PWA_LINK_RELS.has(rel))) && clean.startsWith("/") && !clean.startsWith("//") && safePath(clean)) {
            add(join(web.dir, clean.slice(1)), url, spec, how);
            continue;
          }
          skip("not a relative path", { from: url, spec, how });
          continue;
        }
        add(resolve(dirname(abs), clean), url, spec, how);
      }
    }
  }
  // E-5: pre-read and pre-hash every allowed file at start-up so a join wave does zero disk I/O and zero sha-256 per
  // request, and compute a single build id for immutable `/v/<build>/...` URLs.
  const entries = new Map();
  const buildHash = createHash("sha256");
  for (const url of [...files.keys()].sort()) {
    const file = files.get(url);
    try {
      const st = statSync(file), body = readFileSync(file);
      const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
      entries.set(url, { body, etag, mtimeMs: st.mtimeMs, size: st.size });
      buildHash.update(url).update("\0").update(etag).update("\n");
    } catch { /* unreadable after add: handled on request */ }
  }
  const build = entries.size ? buildHash.digest("base64url").slice(0, 12) : "empty";
  const versionPrefix = `/v/${build}/`;
  log.info("static: serving", { files: files.size, skipped: skipped.length, build, root: web?.dir ?? null });

  async function handle(req, url = new URL(req.url)) {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const path = url.pathname;
    if (!safePath(path)) return null;
    let key = path === "/" ? "/index.html" : path === "/favicon.ico" ? "/favicon.svg" : path;
    let immutable = false;
    if (path.startsWith("/v/")) {
      if (!path.startsWith(versionPrefix)) return null;
      key = "/" + path.slice(versionPrefix.length);
      if (key === "/index.html") return null;   // index.html is always unversioned (entry point)
      immutable = true;
    }
    if (denied(key)) return null;                      // belt and braces: the map never holds one
    const file = files.get(key);
    if (!file) return null;
    let entry = entries.get(key);
    if (!entry || (!immutable && !cache)) {
      try {
        const st = statSync(file);
        if (!entry || st.mtimeMs !== entry.mtimeMs || st.size !== entry.size) {
          const r = realpathSync(file);                // swapped for a symlink since start-up?
          if (!roots.some(m => r.startsWith(m.real + sep))) return null;
          const body = readFileSync(r);
          const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
          entry = { body, etag, mtimeMs: st.mtimeMs, size: st.size };
          entries.set(key, entry);
        }
      } catch { return null; }
    }
    const { body, etag } = entry;
    const headers = {
      "content-type": MIME[extOf(key)],
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "etag": etag,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (matches(req.headers.get("if-none-match"), etag)) {
      const { "content-type": _, ...h } = headers;
      return new Response(null, { status: 304, headers: h });
    }
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(body.byteLength) } });
    return new Response(body, { status: 200, headers });
  }

  return { handle, files, skipped, build };
}

/** If-None-Match uses the weak comparison (RFC 9110 13.1.2): "*" or any listed tag, W/ ignored. */
function matches(header, etag) {
  if (!header) return false;
  return header.split(",").map(s => s.trim().replace(/^W\//, "")).some(t => t === "*" || t === etag);
}

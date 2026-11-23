// Issue #23: Embed boards elsewhere — read-only embed tokens, /embed/:board CSP & live WS shell,
// /oembed 1.0 JSON endpoint, and OpenGraph / Twitter / Slack unfurl meta tags.
import { describe, test, expect } from "bun:test";
import { createEmbedTokens, canEmbedTokenPerform, EMBED_SCOPE, EMBED_ROLE } from "../../server/core/auth/embed-token.js";
import {
  embedRoutes,
  buildFrameAncestorsDirective,
  buildEmbedCsp,
  renderUnfurlMetaTags,
} from "../../server/adapters/driving/embed-http.js";
import { b64url, utf8 } from "../../server/core/auth/util.js";

const TEST_KEY = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff);
const OTHER_KEY = new Uint8Array(32).map((_, i) => (i * 29 + 3) & 0xff);

describe("Issue #23 — Read-only HMAC embed tokens (server/auth/embed-token.js)", () => {
  test("mints and verifies strictly scoped read-only tokens bound to a single board and tenant", async () => {
    let clock = 1_700_000_000_000;
    const revoked = new Set();
    const tokens = createEmbedTokens({
      key: TEST_KEY,
      now: () => clock,
      isRevoked: claims => revoked.has(claims.jti),
    });

    const { token, claims } = await tokens.mint({
      board: "board-alpha",
      tenant: "acme",
      ttlMs: 60_000,
      issuedBy: "google:owner1",
    });

    expect(claims.scope).toBe(EMBED_SCOPE);
    expect(claims.role).toBe(EMBED_ROLE);
    expect(claims.board).toBe("board-alpha");
    expect(claims.tenant).toBe("acme");

    const v = await tokens.verify(token, { board: "board-alpha" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.scope).toBe("embed");
      expect(v.claims.role).toBe("viewer");
      expect(canEmbedTokenPerform(v.claims, "read", "board-alpha")).toBe(true);
      expect(canEmbedTokenPerform(v.claims, "view", "board-alpha")).toBe(true);
      expect(canEmbedTokenPerform(v.claims, "subscribe", "board-alpha")).toBe(true);
      // Never allowed to write, annotate, comment, delete, or access another board
      for (const action of ["write", "edit", "annotate", "comment", "delete", "share", "admin"]) {
        expect(canEmbedTokenPerform(v.claims, action, "board-alpha")).toBe(false);
      }
      expect(canEmbedTokenPerform(v.claims, "read", "board-beta")).toBe(false);
    }

    // Wrong board rejected
    expect(await tokens.verify(token, { board: "board-beta" })).toEqual({ ok: false, code: "wrong-board" });

    // Revocation enforced
    revoked.add(claims.jti);
    expect(await tokens.verify(token, { board: "board-alpha" })).toEqual({ ok: false, code: "revoked" });
    revoked.delete(claims.jti);

    // Expiry enforced
    clock += 60_000;
    expect(await tokens.verify(token, { board: "board-alpha" })).toEqual({ ok: false, code: "expired" });
  });

  test("rejects tampered tokens, escalated role/scope, and cross-key signatures", async () => {
    const tokens = createEmbedTokens({ key: TEST_KEY, now: () => 1_700_000_000_000 });
    const otherTokens = createEmbedTokens({ key: OTHER_KEY, now: () => 1_700_000_000_000 });

    const { token } = await tokens.mint({ board: "board-1", tenant: "t1", ttlMs: 60_000 });
    const [body, sig] = token.split(".");

    // Cross-key rejected
    expect(await otherTokens.verify(token)).toEqual({ ok: false, code: "bad-token" });

    // Tampered payload rejected
    const forgedPayload = b64url(utf8(JSON.stringify({
      v: 1, jti: "abcd1234", board: "board-1", tenant: "t1", scope: "embed", role: "editor", iat: 1, exp: 9_999_999_999_999,
    })));
    expect(await tokens.verify(`${forgedPayload}.${sig}`)).toEqual({ ok: false, code: "bad-token" });

    // Even if signed with the right key, non-viewer role or non-embed scope is rejected as bad-scope
    const rawKey = await crypto.subtle.importKey("raw", TEST_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const forgedSig = b64url(await crypto.subtle.sign("HMAC", rawKey, utf8("emb1." + forgedPayload)));
    expect(await tokens.verify(`${forgedPayload}.${forgedSig}`)).toEqual({ ok: false, code: "bad-scope" });

    // Malformed tokens rejected without throwing
    for (const bad of ["", null, undefined, "abc", `${body}.`, `.${sig}`, "a.b.c"]) {
      expect(await tokens.verify(bad)).toEqual({ ok: false, code: "bad-token" });
    }
  });
});

describe("Issue #23 — /embed/:board, /oembed, CSP frame-ancestors, and OG unfurl tags (server/embed-http.js)", () => {
  const boards = new Map([
    ["roadmap-q4", {
      id: "roadmap-q4",
      tenant: "acme",
      title: 'Q4 Roadmap <2026> & "Launch"',
      description: "Live architecture & launch plan",
      imageUrl: "https://cdn.plenary.app/previews/roadmap-q4.png",
      embedPolicy: {
        frameAncestors: ["'self'", "https://notion.so", "https://*.acme.com", "http://insecure.example", "https://evil.com; script-src *"],
      },
    }],
    ["private-board", {
      id: "private-board",
      tenant: "acme",
      title: "Private Board",
      embedPolicy: null,
    }],
  ]);

  function makeRoutes(logEntries = []) {
    const tokens = createEmbedTokens({ key: TEST_KEY, now: () => 1_700_000_000_000 });
    const log = {
      debug(msg, f) { logEntries.push({ level: "debug", msg, f }); },
      info(msg, f) { logEntries.push({ level: "info", msg, f }); },
      warn(msg, f) { logEntries.push({ level: "warn", msg, f }); },
      error(msg, f) { logEntries.push({ level: "error", msg, f }); },
    };
    const routes = embedRoutes({
      tokens,
      publicUrl: "https://boards.plenary.app",
      resolveBoard: async id => boards.get(id) ?? null,
      log,
    });
    return { tokens, routes };
  }

  test("buildFrameAncestorsDirective & buildEmbedCsp sanitize origins and default safely to 'self'", () => {
    expect(buildFrameAncestorsDirective(null)).toBe("frame-ancestors 'self'");
    expect(buildFrameAncestorsDirective([])).toBe("frame-ancestors 'self'");
    expect(buildFrameAncestorsDirective(["'none'", "https://notion.so"])).toBe("frame-ancestors 'none'");
    expect(buildFrameAncestorsDirective([
      "'self'",
      "https://notion.so",
      "https://*.acme.com",
      "http://insecure.example",
      "https://evil.com; script-src *",
    ])).toBe("frame-ancestors 'self' https://notion.so https://*.acme.com");

    const csp = buildEmbedCsp(["https://notion.so"]);
    expect(csp).toContain("frame-ancestors https://notion.so");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("GET /embed/:board verifies read-only token, sets tenant frame-ancestors CSP, passes token via WS hello, and never logs token", async () => {
    const logs = [];
    const { tokens, routes } = makeRoutes(logs);
    const { token } = await tokens.mint({ board: "roadmap-q4", tenant: "acme", ttlMs: 60_000 });

    const reqUrl = new URL(`https://boards.plenary.app/embed/roadmap-q4?token=${encodeURIComponent(token)}`);
    const res = await routes.handle(new Request(reqUrl), reqUrl);
    expect(res).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://notion.so https://*.acme.com");
    expect(res.headers.get("content-security-policy")).not.toContain("insecure.example");
    expect(res.headers.get("content-security-policy")).not.toContain("evil.com");

    const html = await res.text();
    expect(html).toContain('data-plenary-embed="readonly"');
    expect(html).toContain('t: "hello"');
    expect(html).toContain('scope: "embed"');
    expect(html).toContain('role: "viewer"');
    expect(html).toContain('clean.searchParams.delete("token")');
    // Escaped title in HTML and OG tags
    expect(html).toContain("&lt;2026&gt;");
    expect(html).not.toContain("<2026>");
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('type="application/json+oembed"');

    // Default frame-ancestors is 'self' when board has no embedPolicy
    const { token: privTok } = await tokens.mint({ board: "private-board", tenant: "acme", ttlMs: 60_000 });
    const privUrl = new URL(`https://boards.plenary.app/embed/private-board?token=${encodeURIComponent(privTok)}`);
    const privRes = await routes.handle(new Request(privUrl), privUrl);
    expect(privRes.status).toBe(200);
    expect(privRes.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");

    // Wrong board returns 403 and NEVER logs the token
    const wrongUrl = new URL(`https://boards.plenary.app/embed/private-board?token=${encodeURIComponent(token)}`);
    const wrongRes = await routes.handle(new Request(wrongUrl), wrongUrl);
    expect(wrongRes.status).toBe(403);
    expect(await wrongRes.json()).toEqual({ error: "wrong-board" });
    expect(JSON.stringify(logs)).not.toContain(token);

    // Missing token returns 401
    const noTokUrl = new URL("https://boards.plenary.app/embed/roadmap-q4");
    const noTokRes = await routes.handle(new Request(noTokUrl), noTokUrl);
    expect(noTokRes.status).toBe(401);
  });

  test("GET /oembed returns standard oEmbed 1.0 JSON response and validates format/origin/board", async () => {
    const { tokens, routes } = makeRoutes();
    const { token } = await tokens.mint({ board: "roadmap-q4", tenant: "acme", ttlMs: 60_000 });
    const target = `https://boards.plenary.app/embed/roadmap-q4?token=${encodeURIComponent(token)}`;
    const oembedUrl = new URL(`https://boards.plenary.app/oembed?url=${encodeURIComponent(target)}&format=json&maxwidth=640&maxheight=360`);

    const res = await routes.handle(new Request(oembedUrl), oembedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toMatchObject({
      version: "1.0",
      type: "rich",
      provider_name: "Plenary",
      provider_url: "https://boards.plenary.app",
      title: 'Q4 Roadmap <2026> & "Launch"',
      width: 640,
      height: 360,
    });
    expect(body.html).toContain("<iframe ");
    expect(body.html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(body.html).toContain('width="640"');
    expect(body.html).toContain('height="360"');
    expect(body.html).toContain("&lt;2026&gt;");

    // Unsupported format -> 501
    const xmlUrl = new URL(`https://boards.plenary.app/oembed?url=${encodeURIComponent(target)}&format=xml`);
    expect((await routes.handle(new Request(xmlUrl), xmlUrl)).status).toBe(501);

    // Untrusted origin -> 400
    const evilUrl = new URL(`https://boards.plenary.app/oembed?url=${encodeURIComponent("https://evil.example/embed/roadmap-q4")}`);
    expect((await routes.handle(new Request(evilUrl), evilUrl)).status).toBe(400);

    // Unknown board -> 404
    const missingUrl = new URL(`https://boards.plenary.app/oembed?url=${encodeURIComponent("https://boards.plenary.app/b/does-not-exist")}`);
    expect((await routes.handle(new Request(missingUrl), missingUrl)).status).toBe(404);
  });

  test("renderUnfurlMetaTags generates escaped OpenGraph, Twitter, and oEmbed discovery tags", () => {
    const tags = renderUnfurlMetaTags({
      title: 'Design "Review" <script>',
      description: "Live board updates",
      url: "https://boards.plenary.app/embed/roadmap-q4",
      oembedUrl: "https://boards.plenary.app/oembed?url=https%3A%2F%2Fboards.plenary.app%2Fembed%2Froadmap-q4&format=json",
      imageUrl: "https://cdn.plenary.app/thumb.png",
    });
    expect(tags).toContain('<meta property="og:type" content="website">');
    expect(tags).toContain('<meta property="og:title" content="Design &quot;Review&quot; &lt;script&gt;">');
    expect(tags).toContain('<meta property="og:description" content="Live board updates">');
    expect(tags).toContain('<meta property="og:url" content="https://boards.plenary.app/embed/roadmap-q4">');
    expect(tags).toContain('<meta property="og:image" content="https://cdn.plenary.app/thumb.png">');
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(tags).toContain('<link rel="alternate" type="application/json+oembed" href="https://boards.plenary.app/oembed?url=https%3A%2F%2Fboards.plenary.app%2Fembed%2Froadmap-q4&amp;format=json"');
  });
});

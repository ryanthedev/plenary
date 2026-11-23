// Share link policy (#37): scrypt passcode hashing/verification, validation, checkLinkPolicy,
// per-link brute-force backoff, and safe persistence across Memory & SQLite registries.
import { describe, test, expect } from "bun:test";
import {
  PASSCODE_MIN_LEN,
  PASSCODE_MAX_LEN,
  MAX_SHARE_EXPIRY_MS,
  hashPasscode,
  verifyPasscode,
  validateSharePolicy,
  createLinkRateLimiter,
  checkLinkPolicy,
} from "../../server/core/auth/share-policy.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { createLink, shareView, verifyLinkAccess } from "../../server/core/admin/boards.js";

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

describe("share-policy: hashPasscode & verifyPasscode", () => {
  test("hashes with random 16-byte salt and verifies with timingSafeEqual", () => {
    const h1 = hashPasscode("s3cr3t-pass");
    const h2 = hashPasscode("s3cr3t-pass");
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(verifyPasscode("s3cr3t-pass", h1)).toBe(true);
    expect(verifyPasscode("s3cr3t-pass", h2)).toBe(true);
    expect(verifyPasscode("wrong-pass", h1)).toBe(false);
    expect(verifyPasscode("s3cr3t-pas", h1)).toBe(false);
  });

  test("enforces 4..128 character passcode bounds", () => {
    const min = "a".repeat(PASSCODE_MIN_LEN);
    const max = "z".repeat(PASSCODE_MAX_LEN);
    expect(verifyPasscode(min, hashPasscode(min))).toBe(true);
    expect(verifyPasscode(max, hashPasscode(max))).toBe(true);
    expect(() => hashPasscode("abc")).toThrow();
    expect(() => hashPasscode("x".repeat(PASSCODE_MAX_LEN + 1))).toThrow();
    expect(() => hashPasscode(/** @type {any} */ (1234))).toThrow();
  });

  test("returns false without throwing on malformed hashes or non-string inputs", () => {
    const valid = hashPasscode("good-pass");
    expect(verifyPasscode(null, valid)).toBe(false);
    expect(verifyPasscode(undefined, valid)).toBe(false);
    expect(verifyPasscode("", valid)).toBe(false);
    expect(verifyPasscode("a".repeat(PASSCODE_MAX_LEN + 1), valid)).toBe(false);
    expect(verifyPasscode("good-pass", null)).toBe(false);
    expect(verifyPasscode("good-pass", "")).toBe(false);
    expect(verifyPasscode("good-pass", "plain-text")).toBe(false);
    expect(verifyPasscode("good-pass", "bcrypt$16384$8$1$" + "0".repeat(32) + "$" + "0".repeat(64))).toBe(false);
    expect(verifyPasscode("good-pass", "scrypt$100$8$1$" + "0".repeat(32) + "$" + "0".repeat(64))).toBe(false);
    expect(verifyPasscode("good-pass", "scrypt$999999$8$1$" + "0".repeat(32) + "$" + "0".repeat(64))).toBe(false);
    expect(verifyPasscode("good-pass", "scrypt$16384$8$1$nothex$" + "0".repeat(64))).toBe(false);
    expect(verifyPasscode("good-pass", "scrypt$16384$8$1$" + "0".repeat(32) + "$short")).toBe(false);
  });
});

describe("share-policy: validateSharePolicy", () => {
  test("accepts defaults and valid combinations", () => {
    expect(validateSharePolicy({}, T0)).toEqual({
      ok: true,
      policy: { passcode: null, noDownload: false, expiresAt: null },
    });
    expect(validateSharePolicy({ passcode: "1234", noDownload: true, expiresAt: T0 + 60_000 }, T0)).toEqual({
      ok: true,
      policy: { passcode: "1234", noDownload: true, expiresAt: T0 + 60_000 },
    });
    expect(validateSharePolicy({ passcode: null, noDownload: false, expiresAt: null }, T0)).toEqual({
      ok: true,
      policy: { passcode: null, noDownload: false, expiresAt: null },
    });
  });

  test("rejects invalid passcode, noDownload, expiresAt, or non-object input", () => {
    expect(validateSharePolicy(/** @type {any} */ (null), T0)).toMatchObject({ ok: false, code: "bad-policy" });
    expect(validateSharePolicy(/** @type {any} */ ([]), T0)).toMatchObject({ ok: false, code: "bad-policy" });
    expect(validateSharePolicy({ passcode: "123" }, T0)).toMatchObject({ ok: false, code: "bad-passcode" });
    expect(validateSharePolicy({ passcode: "x".repeat(129) }, T0)).toMatchObject({ ok: false, code: "bad-passcode" });
    expect(validateSharePolicy({ passcode: 12345 }, T0)).toMatchObject({ ok: false, code: "bad-passcode" });
    expect(validateSharePolicy({ noDownload: "yes" }, T0)).toMatchObject({ ok: false, code: "bad-no-download" });
    expect(validateSharePolicy({ expiresAt: T0 }, T0)).toMatchObject({ ok: false, code: "bad-expiry" });
    expect(validateSharePolicy({ expiresAt: T0 - 1 }, T0)).toMatchObject({ ok: false, code: "bad-expiry" });
    expect(validateSharePolicy({ expiresAt: T0 + MAX_SHARE_EXPIRY_MS + 1 }, T0)).toMatchObject({ ok: false, code: "bad-expiry" });
    expect(validateSharePolicy({ expiresAt: 1.5 }, T0)).toMatchObject({ ok: false, code: "bad-expiry" });
  });
});

describe("share-policy: checkLinkPolicy & brute-force rate limiting", () => {
  test("evaluates open, noDownload, expired, revoked, and passcode-protected links", () => {
    const hash = hashPasscode("open-sesame");

    expect(checkLinkPolicy({ id: "lnk1", expiresAt: null, noDownload: false, hasPasscode: false }, { now: T0 })).toEqual({
      ok: true,
      policy: { noDownload: false, expiresAt: null, hasPasscode: false },
    });

    expect(checkLinkPolicy({ id: "lnk1", expiresAt: T0 + 1000, noDownload: true, hasPasscode: false }, { now: T0 })).toEqual({
      ok: true,
      policy: { noDownload: true, expiresAt: T0 + 1000, hasPasscode: false },
    });

    expect(checkLinkPolicy({ id: "lnk1", expiresAt: T0, noDownload: false, hasPasscode: false }, { now: T0 })).toEqual({
      ok: false,
      code: "expired",
    });

    expect(checkLinkPolicy({ id: "lnk1", revoked: true, expiresAt: null, noDownload: false, hasPasscode: false }, { now: T0 })).toEqual({
      ok: false,
      code: "expired",
    });

    // Passcode required
    expect(checkLinkPolicy({ id: "lnk2", expiresAt: null, hasPasscode: true, noDownload: true }, { passcodeHash: hash, now: T0 })).toEqual({
      ok: false,
      code: "passcode-required",
    });

    // Fail closed when hasPasscode is true but no hash is available
    expect(checkLinkPolicy({ id: "lnk2", expiresAt: null, hasPasscode: true, noDownload: true }, { passcode: "open-sesame", now: T0 })).toEqual({
      ok: false,
      code: "bad-passcode",
    });

    // Wrong passcode
    expect(checkLinkPolicy({ id: "lnk2", expiresAt: null, hasPasscode: true, noDownload: true }, { passcode: "wrong", passcodeHash: hash, now: T0 })).toEqual({
      ok: false,
      code: "bad-passcode",
    });

    // Correct passcode (hash passed separately so link stays clean)
    const ok = checkLinkPolicy({ id: "lnk2", expiresAt: T0 + 5000, hasPasscode: true, noDownload: true }, { passcode: "open-sesame", passcodeHash: hash, now: T0 });
    expect(ok).toEqual({
      ok: true,
      policy: { noDownload: true, expiresAt: T0 + 5000, hasPasscode: true },
    });
    expect(JSON.stringify(ok)).not.toContain("scrypt$");
    expect(JSON.stringify(ok)).not.toContain("open-sesame");
  });

  test("rate-limits brute-force attempts with exponential backoff and resets on success", () => {
    const hash = hashPasscode("correct-horse");
    const rl = createLinkRateLimiter({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, windowMs: 60_000, maxEntries: 3 });
    const link = { id: "lnk-bf", expiresAt: null, hasPasscode: true, noDownload: false };
    let t = T0;

    // Missing passcode does not burn attempts
    for (let i = 0; i < 5; i++) {
      expect(checkLinkPolicy(link, { passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({ ok: false, code: "passcode-required" });
    }
    expect(rl.size()).toBe(0);

    // 3 wrong attempts trigger lockout of 1_000ms
    expect(checkLinkPolicy(link, { passcode: "bad1", passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({ ok: false, code: "bad-passcode" });
    expect(checkLinkPolicy(link, { passcode: "bad2", passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({ ok: false, code: "bad-passcode" });
    expect(checkLinkPolicy(link, { passcode: "bad3", passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({ ok: false, code: "bad-passcode" });

    // Even correct passcode is blocked while locked
    const blocked = checkLinkPolicy(link, { passcode: "correct-horse", passcodeHash: hash, now: t + 500, rateLimiter: rl });
    expect(blocked).toMatchObject({ ok: false, code: "rate-limited", retryAfterMs: 500 });

    // After backoff expires, another failure doubles backoff to 2_000ms
    t += 1_000;
    expect(checkLinkPolicy(link, { passcode: "bad4", passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({ ok: false, code: "bad-passcode" });
    expect(checkLinkPolicy(link, { passcode: "correct-horse", passcodeHash: hash, now: t + 1_500, rateLimiter: rl })).toMatchObject({
      ok: false,
      code: "rate-limited",
      retryAfterMs: 500,
    });

    // After 2_000ms, valid passcode succeeds and resets limiter
    t += 2_000;
    expect(checkLinkPolicy(link, { passcode: "correct-horse", passcodeHash: hash, now: t, rateLimiter: rl })).toEqual({
      ok: true,
      policy: { noDownload: false, expiresAt: null, hasPasscode: true },
    });
    expect(rl.size()).toBe(0);

    // LRU cap bounds memory under random link probing
    rl.recordFailure("a", t);
    rl.recordFailure("b", t);
    rl.recordFailure("c", t);
    rl.recordFailure("d", t);
    expect(rl.size()).toBe(3);

    // Non-finite maxEntries/options fall back to safe finite bounds (never disable eviction)
    const safeRl = createLinkRateLimiter({ maxEntries: Number.NaN, maxAttempts: Number.POSITIVE_INFINITY, baseDelayMs: -5 });
    safeRl.recordFailure("k1", t);
    expect(safeRl.size()).toBe(1);
  });
});

describe("share-policy: registry & admin createLink persistence (memory & sqlite)", () => {
  for (const [label, make] of [
    ["memory", () => memoryRegistry({ now: () => T0 })],
    ["sqlite", () => sqliteRegistry({ path: ":memory:", now: () => T0, fullfsync: false })],
  ]) {
    test(`${label}: persists passcodeHash and noDownload without ever returning passcode_hash`, async () => {
      const registry = make();
      try {
        const tenancy = makeTenancy({ registry, now: () => T0 });
        const tenant = await registry.createTenant({ domain: "acme.com", admins: ["dev:ada"] });
        const space = await registry.createSpace({ tenant: tenant.id, name: "Design", owner: "dev:ada" });
        const board = await registry.createBoard({ tenant: tenant.id, title: "Deck", space: space.id, owner: "dev:ada" });
        const caller = { user: "dev:ada", email: "ada@acme.com", domain: "acme.com", name: "Ada" };

        // Plain link remains backwards-compatible
        const plain = await createLink({ caller, board: board.id, role: "viewer" }, { registry, tenancy, now: () => T0 });
        expect(plain).toMatchObject({ board: board.id, role: "viewer", hasPasscode: false, noDownload: false });
        expect("passcodeHash" in plain).toBe(false);
        expect("passcode_hash" in plain).toBe(false);
        expect(await registry.linkPasscodeHash(plain.id)).toBeNull();

        // Passcode + noDownload link
        const protectedLink = await createLink(
          { caller, board: board.id, role: "viewer", expiresAt: T0 + 3_600_000, passcode: "board-pin-99", noDownload: true },
          { registry, tenancy, now: () => T0 },
        );
        expect(protectedLink).toMatchObject({
          board: board.id,
          role: "viewer",
          expiresAt: T0 + 3_600_000,
          hasPasscode: true,
          noDownload: true,
        });
        expect("passcodeHash" in protectedLink).toBe(false);
        expect("passcode_hash" in protectedLink).toBe(false);
        expect("passcode" in protectedLink).toBe(false);

        const fetched = await registry.link(protectedLink.id);
        expect(fetched).toEqual(protectedLink);
        const all = await registry.links(board.id);
        expect(all.every(l => !("passcodeHash" in l) && !("passcode_hash" in l))).toBe(true);

        // Hash is accessible only via dedicated linkPasscodeHash() and verified via verifyLinkAccess()
        const storedHash = await registry.linkPasscodeHash(protectedLink.id);
        expect(storedHash).toMatch(/^scrypt\$/);
        expect(await verifyLinkAccess({ link: protectedLink.id }, { registry, now: () => T0 })).toEqual({
          ok: false,
          code: "passcode-required",
        });
        expect(await verifyLinkAccess({ link: protectedLink.id, passcode: "wrong" }, { registry, now: () => T0 })).toEqual({
          ok: false,
          code: "bad-passcode",
        });
        const verified = await verifyLinkAccess({ link: protectedLink.id, passcode: "board-pin-99" }, { registry, now: () => T0 });
        expect(verified).toEqual({
          ok: true,
          board: board.id,
          role: "viewer",
          policy: { noDownload: true, expiresAt: T0 + 3_600_000, hasPasscode: true },
        });
        expect(JSON.stringify(verified)).not.toContain("scrypt$");
        expect(JSON.stringify(verified)).not.toContain("board-pin-99");

        // shareView and audit never leak passcode or hash
        const view = await shareView({ caller, board: board.id }, { registry, tenancy, now: () => T0 });
        expect(JSON.stringify(view)).not.toContain("board-pin-99");
        expect(JSON.stringify(view)).not.toContain("scrypt$");
        expect(view.links.find(l => l.id === protectedLink.id)).toMatchObject({ hasPasscode: true, noDownload: true });

        const audit = await registry.listAudit({ tenant: tenant.id, board: board.id });
        expect(JSON.stringify(audit)).not.toContain("board-pin-99");
        expect(JSON.stringify(audit)).not.toContain("scrypt$");

        // Invalid passcode rejected with AdminError("bad-request")
        await expect(
          createLink({ caller, board: board.id, role: "viewer", passcode: "12" }, { registry, tenancy, now: () => T0 }),
        ).rejects.toMatchObject({ code: "bad-request" });

        // deleteBoard cleans up passcode hash too
        expect(await registry.deleteBoard(board.id)).toBe(true);
        expect(await registry.linkPasscodeHash(protectedLink.id)).toBeNull();
      } finally {
        await registry.close();
      }
    });
  }
});

describe("share-policy: HTTP createLink & redemption wiring (#37)", () => {
  const ORIGIN = "https://plenary.test";
  const httpConfig = {
    cookieKey: "k".repeat(32),
    postLoginUrl: ORIGIN + "/",
    boardUrl: ORIGIN + "/b/{board}",
    publicUrl: ORIGIN,
  };

  async function makeRig({ rateLimiterOpts } = {}) {
    let t = T0;
    const now = () => t;
    const registry = memoryRegistry({ now });
    const sessions = await makeSessions({ key: "s".repeat(32), now });
    const tenancy = makeTenancy({ registry, now });
    const tenant = await registry.createTenant({ domain: "acme.com", admins: ["google:ada"] });
    const space = await registry.createSpace({ tenant: tenant.id, name: "General", owner: "google:ada" });
    const board = await registry.createBoard({ tenant: tenant.id, title: "All-Hands", space: space.id, owner: "google:ada" });
    const ownerId = { user: "google:ada", email: "ada@acme.com", domain: "acme.com", name: "Ada" };
    const guestId = { user: "google:gus", email: "gus@gmail.com", domain: null, name: "Gus" };
    const ownerTok = await sessions.issue(ownerId);
    const guestTok = await sessions.issue(guestId);
    const linkRateLimiter = rateLimiterOpts ? createLinkRateLimiter(rateLimiterOpts) : undefined;
    const routes = httpRoutes({
      registry,
      sessions,
      tenancy,
      now,
      config: httpConfig,
      ...(linkRateLimiter ? { linkRateLimiter } : {}),
    });
    const req = (path, { method = "GET", token = null, body = undefined, headers = {} } = {}) =>
      routes(new Request(ORIGIN + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    return {
      registry,
      tenancy,
      board,
      ownerId,
      guestId,
      ownerTok,
      guestTok,
      req,
      advance: ms => { t += ms; },
    };
  }

  test("POST /boards/:board/links accepts passcode & noDownload and rejects invalid policy with 400", async () => {
    const { board, ownerTok, req } = await makeRig();

    // Invalid passcode (< 4 chars) -> 400
    const badPass = await req(`/boards/${board.id}/links`, {
      method: "POST",
      token: ownerTok,
      body: { role: "viewer", passcode: "123" },
    });
    expect(badPass.status).toBe(400);

    // Invalid noDownload type -> 400
    const badDl = await req(`/boards/${board.id}/links`, {
      method: "POST",
      token: ownerTok,
      body: { role: "viewer", noDownload: "yes" },
    });
    expect(badDl.status).toBe(400);

    // Valid passcode + noDownload -> 201 without leaking plaintext or hash
    const created = await req(`/boards/${board.id}/links`, {
      method: "POST",
      token: ownerTok,
      body: { role: "annotator", passcode: "pin-2026", noDownload: true, expiresAt: T0 + 3_600_000 },
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.link).toMatchObject({
      board: board.id,
      role: "annotator",
      hasPasscode: true,
      noDownload: true,
      expiresAt: T0 + 3_600_000,
    });
    expect(body.url).toBe(`${ORIGIN}/links/${body.link.id}`);
    expect(JSON.stringify(body)).not.toContain("pin-2026");
    expect(JSON.stringify(body)).not.toContain("scrypt$");
  });

  test("open links remain 100% backwards-compatible on GET and POST /links/:id", async () => {
    const { board, ownerTok, guestTok, guestId, tenancy, req } = await makeRig();
    const res = await req(`/boards/${board.id}/links`, {
      method: "POST",
      token: ownerTok,
      body: { role: "viewer" },
    });
    expect(res.status).toBe(201);
    const { link } = await res.json();

    const redeemed = await req(`/links/${link.id}`, { token: guestTok });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ board: board.id, url: `${ORIGIN}/b/${board.id}` });
    expect(await tenancy.role(guestId, board.id)).toBe("viewer");
  });

  test("passcode-protected link enforces 401 passcode-required, 403 bad-passcode, 429 rate-limited, and 200 on valid passcode", async () => {
    const { board, ownerTok, guestTok, guestId, tenancy, req, advance } = await makeRig({
      rateLimiterOpts: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, windowMs: 60_000 },
    });
    const created = await req(`/boards/${board.id}/links`, {
      method: "POST",
      token: ownerTok,
      body: { role: "annotator", passcode: "secret-42", noDownload: true },
    });
    expect(created.status).toBe(201);
    const { link } = await created.json();

    // Direct tenancy.redeemLink without passcode cannot bypass protection (e.g. OAuth callback path)
    expect(await tenancy.redeemLink(guestId, link.id)).toBeNull();
    expect(await tenancy.role(guestId, board.id)).toBeNull();

    // Missing passcode -> 401 passcode-required (both GET and POST)
    const missingGet = await req(`/links/${link.id}`, { token: guestTok });
    expect(missingGet.status).toBe(401);
    expect(await missingGet.json()).toEqual({ error: "passcode-required" });

    const missingPost = await req(`/links/${link.id}`, { method: "POST", token: guestTok, body: {} });
    expect(missingPost.status).toBe(401);
    expect(await missingPost.json()).toEqual({ error: "passcode-required" });

    // 3 wrong passcodes -> 403 bad-passcode each time, then rate-limited
    for (const wrong of ["wrong-1", "wrong-2", "wrong-3"]) {
      const bad = await req(`/links/${link.id}`, { method: "POST", token: guestTok, body: { passcode: wrong } });
      expect(bad.status).toBe(403);
      expect(await bad.json()).toEqual({ error: "bad-passcode" });
    }

    // 4th attempt (even with valid passcode) during backoff -> 429 rate-limited
    const limited = await req(`/links/${link.id}`, { method: "POST", token: guestTok, body: { passcode: "secret-42" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(await limited.json()).toMatchObject({ error: "rate-limited", retryAfter: 1 });
    expect(await tenancy.role(guestId, board.id)).toBeNull();

    // Advance past backoff window -> valid passcode succeeds via POST JSON body
    advance(1_000);
    const okPost = await req(`/links/${link.id}`, { method: "POST", token: guestTok, body: { passcode: "secret-42" } });
    expect(okPost.status).toBe(200);
    expect(await okPost.json()).toEqual({
      board: board.id,
      url: `${ORIGIN}/b/${board.id}`,
      noDownload: true,
    });
    expect(await tenancy.role(guestId, board.id)).toBe("annotator");

    // Also works via x-link-passcode header, and refuses URL query-string passcodes
    const badQuery = await req(`/links/${link.id}?passcode=secret-42`, { token: guestTok });
    expect(badQuery.status).toBe(401);
    const okHeader = await req(`/links/${link.id}`, { token: guestTok, headers: { "x-link-passcode": "secret-42" } });
    expect(okHeader.status).toBe(200);
  });
});

import { test, expect } from "bun:test";
import { devAuth } from "../../server/auth/dev.js";
import { sessions } from "../../server/auth/session.js";
import { authPort } from "../../server/auth/port.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { createBoard } from "./fixtures.js";
import { fakeIdp } from "./fake-idp.js";
import { fakeStore, gatewayHello } from "./fake-store.js";

const KEY = "k".repeat(32);
const ann = { user: "google:ann", name: "Ann", email: "ann@acme.com", domain: "acme.com" };

test("dev tokens are off by default and on only with explicit config", async () => {
  expect(await devAuth().verify("dev-ann")).toBe(null);
  expect(await devAuth({ tokens: { "dev-ann": { name: "ann" } } }).verify("dev-ann")).toBe(null);       // not enabled
  expect(await devAuth({ enabled: true }).verify("dev-ann")).toBe(null);                                // no table
  expect(await devAuth({ enabled: "yes", tokens: { "dev-ann": { name: "ann" } } }).verify("dev-ann")).toBe(null);
  const d = devAuth({ enabled: true, tokens: { "dev-ann": { name: "ann", domain: "Acme.com" } } });
  expect(await d.verify("dev-ann")).toEqual({ user: "dev:ann", name: "ann", email: null, domain: "acme.com" });
  expect(await d.verify("dev-bob")).toBe(null);
  expect(await d.verify("__proto__")).toBe(null);
});

test("session tokens: issue/verify round-trip; tamper, wrong key, expiry refused", async () => {
  let t = Date.UTC(2026, 10, 11);
  const s = await sessions({ key: KEY, ttlSec: 3600, now: () => t });
  const tok = await s.issue(ann);
  expect(tok).toMatch(/^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await s.verify(tok)).toEqual({ ...ann, exp: Math.floor(t / 1000) + 3600 });
  const [, p, m] = tok.split(".");
  expect(await s.verify(`s1.${p}x.${m}`)).toBe(null);
  expect(await s.verify(`s1.${p}.${m.slice(1)}A`)).toBe(null);
  expect(await (await sessions({ key: "z".repeat(32), now: () => t })).verify(tok)).toBe(null);
  t += 3600_000;
  expect(await s.verify(tok)).toBe(null);
  for (const bad of [null, "", "s1.", "s1.a.b.c", "s2." + p + "." + m]) expect(await s.verify(bad)).toBe(null);
  await expect(sessions({ key: "short" })).rejects.toThrow();
  // exp must be an integer: a fractional or non-positive ttl is refused at start, not by every verify later.
  for (const ttlSec of [1.5, 0, -1, NaN, "3600"]) await expect(sessions({ key: KEY, ttlSec })).rejects.toThrow();
});

test("session tokens: a payload whose exp is not an integer is refused, even with a good mac", async () => {
  const t = Date.UTC(2026, 10, 11);
  const raw = new TextEncoder().encode(KEY);
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b64 = b => Buffer.from(b).toString("base64url");
  const s = await sessions({ key: KEY, now: () => t });
  for (const exp of [Math.floor(t / 1000) + 3600.5, String(Math.floor(t / 1000) + 3600), null]) {
    const payload = b64(JSON.stringify({ u: "google:1", n: null, e: null, d: null, iat: Math.floor(t / 1000), exp }));
    const mac = b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("s1." + payload))));
    expect(await s.verify(`s1.${payload}.${mac}`)).toBe(null);
  }
});

test("port: verify takes session or (configured) dev tokens, never a Google ID token; bad input is null", async () => {
  const idp = await fakeIdp(); await idp.addKey("k1");
  const registry = memoryRegistry();
  const s = await sessions({ key: KEY });
  const auth = authPort({ sessions: s, dev: devAuth(), tenancy: tenancy({ registry }) });
  // The Auth port passes the verifier's Session through as is: `exp` reaches the gateway; dev tokens carry none.
  const got = await auth.verify(await s.issue(ann));
  expect(got).toEqual({ ...ann, exp: got.exp });
  expect(Number.isInteger(got.exp) && got.exp > Date.now() / 1000).toBe(true);
  expect(await auth.verify(await idp.mint())).toBe(null);
  const withDev = authPort({ sessions: s, dev: devAuth({ enabled: true, tokens: { "dev-ann": { name: "ann" } } }), tenancy: tenancy({ registry }) });
  const dev = await withDev.verify("dev-ann");
  expect(dev).toEqual({ user: "dev:ann", name: "ann", email: null, domain: null });
  expect("exp" in dev).toBe(false);                     // no expiry = no key (the gateway sets no timer)
  expect(await auth.verify("dev-ann")).toBe(null);
  for (const bad of [undefined, null, 1, {}, ""]) expect(await auth.verify(bad)).toBe(null);
  expect(await auth.role(null, "b-x")).toBe(null);
});

test("gateway hello: verify, board and role are all awaited; unknown board and no role look the same", async () => {
  const registry = memoryRegistry();
  const admin = { user: "google:root", name: "Root", email: null, domain: "acme.com" };
  const acme = await registry.createTenant({ domain: "acme.com", admins: [admin.user] });
  const other = await registry.createTenant({ domain: "globex.com", admins: [] });
  const b = await createBoard({ caller: admin, tenant: acme.id }, { registry });
  const s = await sessions({ key: KEY });
  const auth = authPort({ sessions: s, tenancy: tenancy({ registry }) });
  const store = fakeStore(registry);
  const hello = async (who, board) => gatewayHello({ token: await s.issue(who), board, client: "c1" }, { auth, store });

  expect(await hello(ann, b.id)).toEqual({ user: "google:ann", role: "viewer", client: "c1" });
  expect(await hello(admin, b.id)).toEqual({ user: "google:root", role: "owner", client: "c1" });
  const bob = { user: "google:bob", name: "Bob", email: "bob@globex.com", domain: "globex.com" };
  expect(await hello(bob, b.id)).toEqual({ error: "auth" });
  expect(await hello(bob, "b-nope")).toEqual({ error: "auth" });
  expect(await gatewayHello({ token: "junk", board: b.id, client: "c1" }, { auth, store })).toEqual({ error: "auth" });
  expect(other.id).not.toBe(acme.id);
});

// ---- Fix round (p5-authv) ----

test("M1 end to end: a no-hd Google token with a third-party email can't claim an invite; gmail can", async () => {
  const { jwksCache, verifyIdToken } = await import("../../server/auth/oidc.js");
  const { createInvite } = await import("../../server/admin/boards.js");
  const { CLIENT_ID } = await import("./fake-idp.js");
  const idp = await fakeIdp(); await idp.addKey("k1");
  const keys = jwksCache({ fetch: idp.fetch });
  const registry = memoryRegistry();
  const admin = { user: "google:root", name: "Root", email: null, domain: "acme.com" };
  const acme = await registry.createTenant({ domain: "acme.com", admins: [admin.user] });
  const b = await createBoard({ caller: admin, tenant: acme.id, memberRole: null }, { registry });
  await createInvite({ caller: admin, board: b.id, email: "cfo@partner.example", role: "editor" }, { registry });
  await createInvite({ caller: admin, board: b.id, email: "gus@gmail.com", role: "annotator" }, { registry });
  const s = await sessions({ key: KEY });
  const auth = authPort({ sessions: s, tenancy: tenancy({ registry }) });
  const signIn = async claims => {
    const id = await verifyIdToken(await idp.mint({ hd: undefined, ...claims }), { clientId: CLIENT_ID, nonce: "n-1", keys });
    return auth.verify(await s.issue(id));
  };
  const stale = await signIn({ sub: "777", email: "cfo@partner.example", email_verified: true });
  expect(stale.email).toBe(null);
  expect(await auth.role(stale, b.id)).toBe(null);
  const gus = await signIn({ sub: "778", email: "gus@gmail.com", email_verified: true });
  expect(await auth.role(gus, b.id)).toBe("annotator");
});

test("L3: a session for a huge name still verifies", async () => {
  const s = await sessions({ key: KEY });
  const id = await s.verify(await s.issue({ ...ann, name: "x".repeat(5000) }));
  expect(id.name.length).toBe(200);
});

test("L8: a dev entry without a usable name is refused at config; a Map works", async () => {
  expect(() => devAuth({ enabled: true, tokens: { "dev-a": {} } })).toThrow();
  expect(() => devAuth({ enabled: true, tokens: { "dev-a": { name: "" } } })).toThrow();
  expect(() => devAuth({ enabled: true, tokens: { "dev-a": { name: "a b" } } })).toThrow();
  const d = devAuth({ enabled: true, tokens: new Map([["dev-a", { name: "a" }]]) });
  expect((await d.verify("dev-a")).user).toBe("dev:a");
});

// ---- Fix round (p5-fix) ----

test("p5-fix 1: a Registry outage propagates from role(); refusals stay null", async () => {
  const registry = memoryRegistry();
  const admin = { user: "google:root", name: "Root", email: null, domain: "acme.com" };
  const acme = await registry.createTenant({ domain: "acme.com", admins: [admin.user] });
  const b = await createBoard({ caller: admin, tenant: acme.id }, { registry });
  let down = false;
  const flaky = new Proxy(registry, { get: (r, k) => (typeof r[k] === "function" ? (...a) => { if (down) throw new Error("registry down"); return r[k](...a); } : r[k]) });
  const s = await sessions({ key: KEY });
  const auth = authPort({ sessions: s, tenancy: tenancy({ registry: flaky }) });
  expect(await auth.role(ann, b.id)).toBe("viewer");
  expect(await auth.role(ann, "b-nope")).toBe(null);                       // unknown board: refused
  expect(await auth.role({ ...ann, domain: "globex.com", user: "google:x" }, b.id)).toBe(null);  // no role: refused
  expect(await auth.role(null, b.id)).toBe(null);                          // bad input: refused
  down = true;
  await expect(auth.role(ann, b.id)).rejects.toThrow("registry down");
  // The stand-in gateway turns that into `unavailable`, not `auth`.
  const store = fakeStore(registry);
  expect(await gatewayHello({ token: await s.issue(ann), board: b.id, client: "c1" }, { auth, store })).toEqual({ error: "unavailable" });
});

test("p5-fix 1: verify refuses bad tokens with null but lets a verifier's failure through", async () => {
  const s = await sessions({ key: KEY });
  const broken = { async verify(t) { if (t === "boom") throw new Error("verifier down"); return null; } };
  const auth = authPort({ sessions: s, dev: broken, tenancy: tenancy({ registry: memoryRegistry() }) });
  for (const bad of [undefined, null, 1, {}, "", "junk", "s1.a.b", "s1.!!.??"]) expect(await auth.verify(bad)).toBe(null);
  await expect(auth.verify("boom")).rejects.toThrow("verifier down");
});

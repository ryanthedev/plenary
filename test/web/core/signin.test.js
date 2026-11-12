// The sign-in core (web/core/signin.js) over the fake auth adapter, the virtual clock and the memory store.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { takeSignIn, readStored, signOut, devSignIn, SESSION_KEY, MAX_FRAGMENT, RETRY_MIN_MS, RETRY_SPREAD_MS } from "../../../web/core/signin.js";
import { fakeAuth } from "../../../web/adapters/auth/fake.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";
import { memoryStore } from "../../../web/adapters/storage/memory.js";

const T0 = Date.UTC(2026, 10, 11, 12);
let clock, auth, storage, replaced, calls;

/** An auth port that records every exchange and answers from a script (then from fakeAuth). */
function counting(inner, script = []) {
  return { async exchange(code) { calls.push(code); return script.length ? script.shift() : inner.exchange(code); } };
}
const env = (fragment, over = {}) => ({ fragment, replaceFragment: () => { replaced++; }, storage, auth: counting(auth), clock, ...over });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// Tripwires: core code must reach storage only through the port, never the browser's globals.
const touched = [];
const tripwire = name => new Proxy({}, { get(_t, k) { touched.push(`${name}.${String(k)}`); return () => null; } });
let savedGlobals;
beforeEach(() => {
  clock = virtualClock({ t0: T0, seed: 7 });
  auth = fakeAuth({ now: clock.now });
  storage = memoryStore();
  replaced = 0; calls = []; touched.length = 0;
  savedGlobals = {};
  for (const g of ["localStorage", "sessionStorage"]) {
    savedGlobals[g] = Object.getOwnPropertyDescriptor(globalThis, g);
    Object.defineProperty(globalThis, g, { value: tripwire(g), configurable: true, writable: true });
  }
});
afterEach(() => {
  for (const [g, d] of Object.entries(savedGlobals)) { if (d) Object.defineProperty(globalThis, g, d); else delete globalThis[g]; }
  expect(touched).toEqual([]);           // never localStorage, never sessionStorage directly (the root passes the port)
});

describe("takeSignIn: the code in the fragment", () => {
  test("a valid #code is exchanged once; the session is stored under SESSION_KEY and returned", async () => {
    const code = auth.mint({ token: "s1.tok.sig", user: "google:1", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
    const r = await takeSignIn(env(`#code=${code}`));
    expect(r).toEqual({ token: "s1.tok.sig", identity: { user: "google:1", name: "Ann", email: "ann@acme.com", domain: "acme.com" },
      exp: Math.floor(T0 / 1000) + 3600, outcome: "signed-in", link: null });
    expect(calls).toEqual([code]);
    expect(JSON.parse(storage.get(SESSION_KEY))).toMatchObject({ token: "s1.tok.sig", user: "google:1", exp: r.exp });
  });

  test("name and email may be null (display-only identity)", async () => {
    const r = await takeSignIn(env(`#code=${auth.mint({ name: null, email: null, domain: null })}`));
    expect(r.identity).toEqual({ user: "google:ann", name: null, email: null, domain: null });
  });

  test("replaceFragment runs first, synchronously, before the exchange, whatever the fragment held", async () => {
    const order = [];
    const a = { exchange: async () => { order.push("exchange"); return { error: "invalid-code" }; } };
    const p = takeSignIn(env("#code=abc", { auth: a, replaceFragment: () => order.push("replace") }));
    expect(order[0]).toBe("replace");                     // first, and before takeSignIn even returned its promise
    await p;
    expect(order).toEqual(["replace", "exchange"]);
    for (const f of ["", "#", "#junk", "#" + "x".repeat(MAX_FRAGMENT + 10), "#code=a&code=b"]) {
      replaced = 0;
      await takeSignIn(env(f));
      expect(replaced).toBe(1);
    }
  });

  test("a throwing replaceFragment is survived", async () => {
    const r = await takeSignIn(env(`#code=${auth.mint()}`, { replaceFragment: () => { throw new Error("SecurityError"); } }));
    expect(r.outcome).toBe("signed-in");
  });

  test("the share-link outcome comes through with or without a code", async () => {
    expect((await takeSignIn(env(`#code=${auth.mint()}&link=invalid`))).link).toBe("invalid");
    expect((await takeSignIn(env("#link=unavailable"))).link).toBe("unavailable");
    expect((await takeSignIn(env("#link=other"))).link).toBe(null);
    expect((await takeSignIn(env("#link=invalid&link=invalid"))).link).toBe(null);
  });

  test("a code like the server's (43 base64url chars) and like the fake's both pass the fragment check", async () => {
    const real = "Ab-_".repeat(10) + "xyz";
    const r = await takeSignIn(env(`#code=${real}`));
    expect(calls).toEqual([real]);
    expect(r.outcome).toBe("invalid-code");               // unknown to the fake, but it was sent
  });
});

describe("takeSignIn: hostile fragments are rejected before any request", () => {
  const hostile = [
    ["huge", "#code=" + "A".repeat(MAX_FRAGMENT)],
    ["two code=", "#code=aaa&code=bbb"],
    ["the same code twice", "#code=aaa&code=aaa"],
    ["escaped", "#code=a%20b"],
    ["odd characters", "#code=a<script>"],
    ["a dot", "#code=a.b"],
    ["unicode", "#code=Zoë"],
    ["empty", "#code="],
    ["too long a code", "#code=" + "A".repeat(257)],
    ["a newline", "#code=ab\ncd"],
  ];
  for (const [what, f] of hostile) {
    test(what, async () => {
      const r = await takeSignIn(env(f));
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ token: null, outcome: "bad-fragment" });
    });
  }
  test("a rejected fragment still restores a stored session (it is just not replaced)", async () => {
    const first = await takeSignIn(env(`#code=${auth.mint()}`));
    calls = [];
    const r = await takeSignIn(env("#code=a&code=b"));
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ token: first.token, outcome: "bad-fragment" });
  });
  test("a fragment without code= makes no request", async () => {
    for (const f of ["", "#", "#foo=bar", "#token=s1.a.b"]) await takeSignIn(env(f));
    expect(calls).toEqual([]);
  });
});

describe("takeSignIn: one jittered retry", () => {
  for (const kind of ["unavailable", "network"]) {
    test(`${kind}: one retry after a jittered clock wait (${RETRY_MIN_MS}–${RETRY_MIN_MS + RETRY_SPREAD_MS} ms), then success`, async () => {
      auth.setFail(kind);
      const code = auth.mint();
      let done = null;
      const p = takeSignIn(env(`#code=${code}`)).then(r => { done = r; });
      await flush();
      expect(calls.length).toBe(1);
      expect(clock.pending).toBe(1);                        // the wait is on the injected clock, nothing else
      auth.setFail(null);
      clock.advance(RETRY_MIN_MS - 1);
      await flush();
      expect(calls.length).toBe(1);                         // never sooner than the floor
      clock.advance(RETRY_SPREAD_MS + 1);
      await p;
      expect(calls).toEqual([code, code]);
      expect(done.outcome).toBe("signed-in");
    });
  }

  test("never more than one retry: a second failure is the outcome", async () => {
    auth.setFail("unavailable");
    const p = takeSignIn(env(`#code=${auth.mint()}`));
    await flush(); clock.advance(RETRY_MIN_MS + RETRY_SPREAD_MS); await flush();
    const r = await p;
    expect(calls.length).toBe(2);
    expect(clock.pending).toBe(0);
    expect(r).toMatchObject({ token: null, outcome: "unavailable" });
  });

  for (const kind of ["invalid-code", "bad-origin"]) {
    test(`${kind} is final: no retry, no wait`, async () => {
      const a = { exchange: async c => { calls.push(c); return { error: kind }; } };
      const r = await takeSignIn(env("#code=abc", { auth: a }));
      expect(calls.length).toBe(1);
      expect(clock.pending).toBe(0);
      expect(r).toMatchObject({ token: null, outcome: kind });
    });
  }

  test("the wait is jittered: different random draws give different waits", async () => {
    const waits = new Set();
    for (let seed = 1; seed <= 20; seed++) {
      const c = virtualClock({ seed });
      waits.add(RETRY_MIN_MS + Math.floor(c.random() * RETRY_SPREAD_MS));
    }
    expect(waits.size).toBeGreaterThan(10);
    // and the core really uses clock.random: two seeds, two different retry moments
    const moment = async seed => {
      clock = virtualClock({ t0: T0, seed });
      const a = { n: 0, async exchange() { return this.n++ ? { error: "invalid-code" } : { error: "network" }; } };
      const p = takeSignIn(env("#code=abc", { auth: a }));
      let t = 0;
      await flush();
      while (a.n < 2 && t < 5_000) { clock.advance(1); t++; await flush(); }
      await p;
      return t;
    };
    const x = await moment(1), y = await moment(99);     // one after the other: they share `clock`
    expect(x).toBeGreaterThanOrEqual(RETRY_MIN_MS);
    expect(y).toBeGreaterThanOrEqual(RETRY_MIN_MS);
    expect(x).not.toBe(y);
  });

  test("an adapter error outside AUTH_ERRORS counts as unavailable (and is retried)", async () => {
    const a = { n: 0, async exchange() { this.n++; return this.n === 1 ? { error: "weird" } : { error: "weird" }; } };
    const p = takeSignIn(env("#code=abc", { auth: a }));
    await flush(); clock.advance(RETRY_MIN_MS + RETRY_SPREAD_MS);
    const r = await p;
    expect(a.n).toBe(2);
    expect(r.outcome).toBe("unavailable");
  });

  test("a session-shaped answer with a bad token/user/exp is unavailable and FINAL (the server spent the code)", async () => {
    for (const bad of [{ token: "", user: "x", exp: 9e9 }, { token: "a b", user: "x", name: null, email: null, domain: null, exp: 1_900_000_000 },
      { token: "t", user: "", name: null, email: null, domain: null, exp: 1_900_000_000 }, { token: "t", user: "u", name: null, email: null, domain: null, exp: 1.5 }]) {
      calls = [];
      const r = await takeSignIn(env("#code=abc", { auth: counting(auth, [bad, bad]) }));
      expect(calls.length).toBe(1);
      expect(clock.pending).toBe(0);
      expect(r).toMatchObject({ token: null, outcome: "unavailable" });
    }
  });

  test("display fields never gate sign-in: empty, control-character or over-long name/email/domain become null", async () => {
    const r = await takeSignIn(env(`#code=${auth.mint({ name: "", email: "a\u0000b@x", domain: "d".repeat(600) })}`));
    expect(r.outcome).toBe("signed-in");
    expect(calls.length).toBe(1);
    expect(r.identity).toEqual({ user: "google:ann", name: null, email: null, domain: null });
    expect((await takeSignIn(env(""))).identity).toEqual(r.identity);
  });

  test("on read-back too: a stored session with a bad display field is kept, the field nulled", () => {
    storage.set(SESSION_KEY, JSON.stringify({ token: "s1.t.s", user: "google:1", name: "", email: 5, domain: "\u0007", exp: 1_900_000_000 }));
    expect(readStored({ storage, clock })).toEqual({ token: "s1.t.s", identity: { user: "google:1", name: null, email: null, domain: null }, exp: 1_900_000_000 });
  });

  test("a failed exchange falls back to the stored session (still signed in as before)", async () => {
    const first = await takeSignIn(env(`#code=${auth.mint({ user: "google:old" })}`));
    const r = await takeSignIn(env("#code=spent"));
    expect(r).toMatchObject({ token: first.token, identity: { user: "google:old" }, outcome: "invalid-code" });
  });
});

describe("stored session", () => {
  test("restored on reload without a fragment", async () => {
    const first = await takeSignIn(env(`#code=${auth.mint()}`));
    const r = await takeSignIn(env(""));
    expect(r).toEqual({ ...first, outcome: "restored" });
  });
  test("expired by exp (seconds) → dropped", async () => {
    await takeSignIn(env(`#code=${auth.mint({ exp: Math.floor(T0 / 1000) + 10 })}`));
    clock.advance(9_999);
    expect(readStored({ storage, clock })).not.toBe(null);
    clock.advance(1);
    expect(readStored({ storage, clock })).toBe(null);
    expect(storage.get(SESSION_KEY)).toBe(null);
    expect((await takeSignIn(env(""))).outcome).toBe("none");
  });
  test("a fresh session is trusted even if this browser's clock is past its exp (the server just issued it); a reload drops it", async () => {
    const r = await takeSignIn(env(`#code=${auth.mint({ exp: Math.floor(T0 / 1000) - 1 })}`));
    expect(r.outcome).toBe("signed-in");
    expect(calls.length).toBe(1);
    expect((await takeSignIn(env(""))).outcome).toBe("none");
  });
  test("malformed stored values are dropped", () => {
    for (const v of ["not json", "null", "[]", JSON.stringify({ token: "a b", user: "u", name: null, email: null, domain: null, exp: 9e9 }),
      JSON.stringify({ token: "t", user: "", name: null, email: null, domain: null, exp: 9e9 }),
      JSON.stringify({ token: "t", user: "u", name: null, email: null, domain: null, exp: "9e9" })]) {
      storage.set(SESSION_KEY, v);
      expect(readStored({ storage, clock })).toBe(null);
      expect(storage.get(SESSION_KEY)).toBe(null);
    }
  });
  test("an unavailable store: the exchange still signs in (memory only); a failed read is not 'signed out' and removes nothing", async () => {
    storage = memoryStore({ unavailable: true });
    const r = await takeSignIn(env(`#code=${auth.mint()}`));
    expect(r.outcome).toBe("signed-in");
    expect(typeof r.token).toBe("string");
    expect(readStored({ storage, clock })).toBe(null);
    let removed = 0;
    const s = { get: () => { throw Object.assign(new Error("x"), { code: "storage-unavailable" }); }, set() {}, remove() { removed++; } };
    expect(readStored({ storage: s, clock })).toBe(null);
    expect(removed).toBe(0);
  });
  test("signOut clears it, and never throws", async () => {
    await takeSignIn(env(`#code=${auth.mint()}`));
    signOut(storage);
    expect(storage.get(SESSION_KEY)).toBe(null);
    expect((await takeSignIn(env(""))).outcome).toBe("none");
    signOut(memoryStore({ unavailable: true }));
  });
});

describe("dev path", () => {
  test("?as=<name> → token dev-<name>, identity dev:<name>, nothing stored", () => {
    expect(devSignIn({ query: "?as=ada" })).toEqual({ token: "dev-ada", identity: { user: "dev:ada", name: "ada", email: null, domain: null }, exp: null, outcome: "dev", link: null });
    expect(devSignIn({ query: "x=1&as=bob" })?.token).toBe("dev-bob");
    expect(storage.get(SESSION_KEY)).toBe(null);
  });
  test("absent, twice, odd or not allowed → null", () => {
    for (const q of ["", "?", "?as=", "?as=a&as=b", "?as=a%20b", "?as=<x>", "?as=" + "a".repeat(33), "?asx=ada"]) expect(devSignIn({ query: q })).toBe(null);
    expect(devSignIn({ query: "?as=eve", allowed: ["ada", "bob"] })).toBe(null);
    expect(devSignIn({ query: "?as=bob", allowed: ["ada", "bob"] })?.token).toBe("dev-bob");
  });
});

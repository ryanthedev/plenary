// Auth adapters (web/adapters/auth/*) against the auth contract, plus the fake's own rules
// (docs/m2/contracts/auth-exchange.md: single use, 60 s, one error for all bad codes; 403; 503; no answer).
import { describe, test, expect } from "bun:test";
import { authContract, expectAuthResult } from "../contracts/auth-contract.js";
import { fakeAuth } from "../../../web/adapters/auth/fake.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";

authContract("fake", () => { const a = fakeAuth(); return { auth: a, mint: async f => a.mint(f), force: k => a.setFail(k) }; });

describe("fake auth adapter", () => {
  test("returns the minted session", async () => {
    const a = fakeAuth({ now: () => 5_000_000 });
    const code = a.mint({ token: "s1.x.y", user: "google:bob", name: "Bob", email: "bob@x.io", domain: null, exp: 99 });
    expect(await a.exchange(code)).toEqual({ token: "s1.x.y", user: "google:bob", name: "Bob", email: "bob@x.io", domain: null, exp: 99 });
  });
  test("a code is single use", async () => {
    const a = fakeAuth(), code = a.mint();
    expectAuthResult(await a.exchange(code));
    expect(await a.exchange(code)).toEqual({ error: "invalid-code" });
  });
  test("a code expires after 60 s", async () => {
    const c = virtualClock({ t0: 1_000_000 }), a = fakeAuth({ now: c.now });
    const ok = a.mint(), late = a.mint();
    c.advance(60_000);
    expect("token" in await a.exchange(ok)).toBe(true);
    c.advance(1);
    expect(await a.exchange(late)).toEqual({ error: "invalid-code" });
  });
  test("forced failures: bad-origin, unavailable, network; the code survives them", async () => {
    const a = fakeAuth(), code = a.mint();
    for (const f of ["bad-origin", "unavailable", "network"]) {
      a.setFail(f);
      const r = await a.exchange(code);
      expect(r).toEqual({ error: f });
      expectAuthResult(r);
    }
    a.setFail(null);
    expect("token" in await a.exchange(code)).toBe(true);
  });
});

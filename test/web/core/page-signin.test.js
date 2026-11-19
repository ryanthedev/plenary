// The page's sign-in choice (web/core/signin.js pageSignIn, signInNotice) and how main.js wires it. Replaces
// test/web/ui-token.test.js (web/ui/token.js is gone: the post-login fragment now carries a single-use #code, not the
// token). Each of that file's guarantees is kept here.
import { test, expect, beforeEach } from "bun:test";
import { pageSignIn, signInNotice, SESSION_KEY } from "../../../web/core/signin.js";
import { fakeAuth } from "../../../web/adapters/auth/fake.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";
import { memoryStore } from "../../../web/adapters/storage/memory.js";
import { localRoom } from "../../../web/adapters/transport/local.js";
import { createSession } from "../../../web/core/session.js";
import { DEV_USERS } from "../../../web/core/dev-users.js";

const T0 = Date.UTC(2026, 10, 12, 9);
let clock, auth, storage, replaced, calls;
beforeEach(() => {
  clock = virtualClock({ t0: T0, seed: 3 });
  auth = fakeAuth({ now: clock.now });
  storage = memoryStore();
  replaced = 0; calls = [];
});
const counted = () => ({ exchange: code => { calls.push(code); return auth.exchange(code); } });
const sign = (query, fragment, over = {}) =>
  pageSignIn({ query, fragment, replaceFragment: () => { replaced++; }, storage, auth: counted(), clock, devUsers: DEV_USERS, ...over });
const stored = (token, exp = Math.floor(T0 / 1000) + 3600) => storage.set(SESSION_KEY, JSON.stringify({ token, user: "google:ann", name: "Ann", email: null, domain: null, exp }));

// (ui-token 1, 2) the fragment's code is exchanged, kept in session storage, dropped at once; share-link outcome kept.
test("a #code is exchanged once, the session kept in storage, the fragment dropped; &link= comes back", async () => {
  const code = auth.mint({ token: "s1.tok.sig" });
  const r = await sign("?board=demo", `#code=${code}&link=invalid`);
  expect(r).toMatchObject({ token: "s1.tok.sig", dev: null, outcome: "signed-in", link: "invalid" });
  expect(r.identity).toEqual({ user: "google:ann", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
  expect(replaced).toBe(1);
  expect(calls).toEqual([code]);
  expect(JSON.parse(storage.get(SESSION_KEY)).token).toBe("s1.tok.sig");
  // A reload: no fragment; the stored session comes back, nothing exchanged.
  calls = [];
  const again = await sign("?board=demo", "");
  expect(again).toMatchObject({ token: "s1.tok.sig", outcome: "restored", dev: null });
  expect(calls).toEqual([]);
});

// p6-landv L2: the dev path stores and exchanges nothing, but still drops the fragment.
test("an explicit known ?as= is the dev path: nothing exchanged or stored, the fragment still dropped", async () => {
  const code = auth.mint();
  const r = await sign("?as=bo&board=demo", `#code=${code}&link=unavailable`);
  expect(r).toMatchObject({ token: "dev-bo", dev: "bo", outcome: "dev", link: "unavailable" });
  expect(replaced).toBe(1);
  expect(calls).toEqual([]);
  expect(storage.get(SESSION_KEY)).toBeNull();
});

// (ui-token 8) precedence: dev ?as= wins over a stored session; else the session; else dev ada. Unknown ?as= ignored.
test("who signs in: ?as= (known) wins, else the session, else dev ada", async () => {
  stored("s1.kept.sig");
  expect(await sign("?as=cy", "")).toMatchObject({ token: "dev-cy", dev: "cy" });
  expect(await sign("?as=nobody", "")).toMatchObject({ token: "s1.kept.sig", dev: null });
  expect(await sign("?as=__proto__", "")).toMatchObject({ token: "s1.kept.sig", dev: null });
  expect(await sign("?as=bo&as=cy", "")).toMatchObject({ token: "s1.kept.sig", dev: null });   // twice: neither
  storage.remove(SESSION_KEY);
  expect(await sign("", "")).toMatchObject({ token: "dev-ada", dev: "ada", outcome: "none", identity: null });
});

// (ui-token 3, 4, 9) hostile fragments never come out as a token, and a good stored session survives them.
test("hostile fragments: never exchanged as given, never a token; a stored session survives; dev ada otherwise", async () => {
  const evil = ['#code="><img src=x onerror=alert(1)>', `#code=${"A".repeat(5000)}`, "#code=a&code=b", "#code=%41%42", "#token=s1.x.y", `#${"&x=1".repeat(800)}&code=abc`];
  for (const f of evil) {
    calls = [];
    const r = await sign("", f);
    expect(r.token).toBe("dev-ada");
    expect(calls.every(c => /^[A-Za-z0-9_-]{1,256}$/.test(c))).toBe(true);
  }
  stored("s1.kept.sig");
  for (const f of evil) expect((await sign("", f)).token).toBe("s1.kept.sig");
});

// (ui-token 5) storage that throws: the fragment is still dropped and the token kept in memory.
test("an unavailable store: the exchange still signs in (memory only), the fragment is dropped", async () => {
  storage = memoryStore({ unavailable: true });
  const code = auth.mint({ token: "s1.mem.sig" });
  const r = await sign("", `#code=${code}`);
  expect(r).toMatchObject({ token: "s1.mem.sig", outcome: "signed-in" });
  expect(replaced).toBe(1);
});

// p6-edgev LOW-4 / LOW-5: the notice never blames the user, and says when the tab is still someone else.
test("signInNotice: share links, failures that don't blame, and 'still signed in as'", async () => {
  expect(signInNotice({ outcome: "signed-in", link: null, dev: null, token: "t" })).toBeNull();
  expect(signInNotice({ outcome: "dev", link: "invalid", dev: "bo", token: "dev-bo" })).toMatch(/share link is not valid/);
  const bad = signInNotice({ outcome: "invalid-code", link: null, dev: null, token: "s1.a.b" }, "Ann");
  expect(bad).toMatch(/expired or was already used/);
  expect(bad).toMatch(/Still signed in as Ann\./);
  expect(bad).not.toMatch(/\byou\b.*(wrong|mistake)/i);
  expect(signInNotice({ outcome: "network", link: null, dev: "ada", token: "dev-ada" })).toMatch(/no connection\. Sign in again\./);
  // A failed exchange with a stored session: the tab is still the stored person, and pageSignIn says so via outcome.
  stored("s1.kept.sig");
  auth.setFail("unavailable");
  const pending = sign("", `#code=${auth.mint()}`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  clock.advance(5_000);                                              // past the one jittered retry
  const r = await pending;
  expect(r).toMatchObject({ token: "s1.kept.sig", outcome: "unavailable", dev: null });
  expect(signInNotice(r, "Ann")).toMatch(/Still signed in as Ann/);
});

// (ui-token 8, 9) the hello carries exactly the chosen token (the session over the dev room, every hello recorded).
function hellos(token) {
  const net = localRoom({ board: "b1", users: DEV_USERS, clock: true }), sent = [];
  const join = () => { const t = net.join(); return { ...t, send: m => { if (m.t === "hello") sent.push(m.token); t.send(m); } }; };
  const s = createSession({ join, token, board: "b1", clock: net.clock });
  net.settle();
  return { sent, status: s.status };
}
test("the hello carries exactly the chosen token: a dev token goes live; a session token is refused by the dev room", async () => {
  const dev = hellos((await sign("?as=bo", "#code=zzz")).token);
  expect(dev.status).toBe("live");
  expect(new Set(dev.sent)).toEqual(new Set(["dev-bo"]));
  const code = auth.mint({ token: "s1.real.sig" });
  const real = hellos((await sign("", `#code=${code}`)).token);
  expect(new Set(real.sent)).toEqual(new Set(["s1.real.sig"]));
  expect(real.status).toBe("refused");
  storage.remove(SESSION_KEY);                                      // nothing stored: a hostile fragment gives dev ada
  const evil = hellos((await sign("", '#code="><script>')).token);
  expect(new Set(evil.sent)).toEqual(new Set(["dev-ada"]));
});

// (ui-token 7) the root keeps the token out of localStorage, URLs, logs and globalThis.plenary.
test("both roots (main.js, dev-main.js): sign-in storage is session storage; no token in localStorage, a log, or globalThis.plenary", async () => {
  const code = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const main = code(await Bun.file(new URL("../../../web/main.js", import.meta.url)).text());
  const app = code(await Bun.file(new URL("../../../web/adapters/dom/app.js", import.meta.url)).text());
  const core = code(await Bun.file(new URL("../../../web/core/signin.js", import.meta.url)).text());
  const dev = code(await Bun.file(new URL("../../../web/dev-main.js", import.meta.url)).text());
  expect(main).toMatch(/takeSignIn\(\{[\s\S]*?storage: sessionStore\(\),/);
  expect(dev).toMatch(/pageSignIn\(\{[\s\S]*?storage: sessionStore\(\),/);
  expect(main).not.toMatch(/pageSignIn|devSignIn|DEV_USERS|\?as=/);           // production: no dev path at all
  for (const root of [main, dev]) {
    expect(root).not.toMatch(/localStorage|sessionStorage|console\./);
    expect(root).toMatch(/globalThis\.plenary = app;/);
  }
  expect(core).not.toMatch(/localStorage|sessionStorage|console\.|location|history/);
  expect(app).not.toMatch(/console\.(log|info|warn|error|debug)\([^)]*(token|signIn)/);
  expect(app).not.toMatch(/\bsignIn\b|\.token\b|\btoken:/);           // the chrome never sees the token or the sign-in
  // What globalThis.plenary gets is mountApp's return: no token, no sign-in result in it.
  const exposed = /return \{([^}]*)\};\s*\}\s*$/.exec(app)[1];
  expect(exposed.split(",").map(k => k.trim())).toEqual(["S", "ui", "net", "collab", "port", "setTheme", "openDialog", "setPanel", "startComment"]);
});

// p6-edgev LOW-1: a fragment that ONLY the length cap rejects (its code is well formed) is never exchanged.
test("a fragment over MAX_FRAGMENT with a well-formed code: rejected by the cap alone, no request", async () => {
  const code = auth.mint();
  const r = await sign("", `#${"x=1&".repeat(700)}code=${code}`);
  expect(calls).toEqual([]);
  expect(r).toMatchObject({ outcome: "bad-fragment", dev: "ada" });
  expect(replaced).toBe(1);
  calls = [];
  const fine = await sign("", `#${"x=1&".repeat(10)}code=${code}`);         // the same code, short: exchanged
  expect(calls).toEqual([code]);
  expect(fine.outcome).toBe("signed-in");
});

// Manager decision (p6-hexv, fail closed): a fragment that cannot be dropped from the address bar is never exchanged.
test("replaceFragment throws: the code is not exchanged, outcome url-not-cleared; a stored session still restores", async () => {
  const code = auth.mint({ token: "s1.never.sig" });
  const boom = () => { replaced++; throw new Error("SecurityError"); };
  const r = await sign("", `#code=${code}`, { replaceFragment: boom });
  expect(calls).toEqual([]);
  expect(r).toMatchObject({ outcome: "url-not-cleared", token: "dev-ada", dev: "ada" });
  expect(storage.get(SESSION_KEY)).toBeNull();
  expect(signInNotice(r)).toMatch(/couldn't be removed from the address bar\. Sign in again\./);
  stored("s1.kept.sig");
  const kept = await sign("", `#code=${code}`, { replaceFragment: boom });
  expect(calls).toEqual([]);
  expect(kept).toMatchObject({ outcome: "url-not-cleared", token: "s1.kept.sig", dev: null });
});

// p6-hexv L: the token never reaches a URL write. The core's only URL write is the root's replaceFragment, which it
// calls once, with no arguments, BEFORE any exchange; nothing of the answer can flow into it afterwards.
test("the token never reaches a URL write: replaceFragment is called once, with no arguments, before the exchange", async () => {
  const order = [], args = [];
  const code = auth.mint({ token: "s1.secret.sig" });
  const r = await sign("", `#code=${code}`, {
    replaceFragment: (...a) => { order.push("replace"); args.push(a); },
    auth: { exchange: c => { order.push("exchange"); return auth.exchange(c); } },
  });
  expect(r.token).toBe("s1.secret.sig");
  expect(order).toEqual(["replace", "exchange"]);
  expect(args).toEqual([[]]);
});

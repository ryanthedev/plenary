// The sign-in token on the page (web/ui/token.js): read from `#token=`, kept in memory and sessionStorage,
// the fragment cleared at once; hostile fragments never come out as a token or an identity.
import { test, expect } from "bun:test";
import { takeToken, validToken, tokenIdentity, chooseSignIn, TOKEN_KEY } from "../../web/ui/token.js";
import { localRoom } from "../../web/sync.js";
import { createSession } from "../../web/ui/session.js";
import { DEV_USERS } from "../../web/ui/dev-users.js";

const b64url = s => Buffer.from(s).toString("base64url");
const MAC = "A".repeat(43);
const tok = (payload = { u: "g:123", n: "Ada L", e: "ada@x.io", d: "x.io", iat: 1, exp: 2 }) => `s1.${b64url(JSON.stringify(payload))}.${MAC}`;

function env(hash, { search = "?board=demo", stored = null } = {}) {
  const store = new Map(stored == null ? [] : [[TOKEN_KEY, stored]]), urls = [];
  const location = { hash, pathname: "/web/index.html", search };
  const history = { state: { keep: 1 }, replaceState(s, _t, u) { urls.push({ s, u }); location.hash = ""; } };
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  return { location, history, storage, store, urls };
}

test("the token is read from the fragment, kept in sessionStorage, and the hash is cleared at once (path and query kept)", () => {
  const t = tok(), e = env(`#token=${encodeURIComponent(t)}`);
  const r = takeToken(e);
  expect(r).toEqual({ token: t, link: null, fromHash: true });
  expect(e.urls).toEqual([{ s: { keep: 1 }, u: "/web/index.html?board=demo" }]);
  expect(e.store.get(TOKEN_KEY)).toBe(t);
  // A reload: no fragment, the stored token comes back, nothing is replaced.
  const again = env("", { stored: t });
  expect(takeToken(again)).toEqual({ token: t, link: null, fromHash: false });
  expect(again.urls).toEqual([]);
});

test("a share link's outcome comes with the token; only the two known values", () => {
  const t = tok();
  expect(takeToken(env(`#token=${t}&link=invalid`))).toMatchObject({ token: t, link: "invalid" });
  expect(takeToken(env(`#token=${t}&link=unavailable`))).toMatchObject({ token: t, link: "unavailable" });
  expect(takeToken(env(`#token=${t}&link=<img src=x onerror=alert(1)>`))).toMatchObject({ token: t, link: null });
});

test("hostile fragments: huge, odd characters, token twice, wrong shape. Never a token; the hash is cleared anyway", () => {
  const t = tok();
  const cases = [
    `#token=${"A".repeat(20_000)}`,                                       // huge: not even parsed
    `#token=${t}&pad=${"x".repeat(9000)}`,                                // a valid token inside a huge fragment
    `#token=${encodeURIComponent(`${t}<script>alert(1)</script>`)}`,
    `#token=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`,
    `#token=${t}&token=${tok({ u: "evil" })}`,                            // twice: neither
    `#token=${t.replace("s1.", "s2.")}`,
    `#token=${t}%00`,
    `#token=${t.slice(0, -1)}`,                                           // MAC one short
    `#token=s1..${MAC}`,
    `#token=%E0%A4%A`,                                                    // broken percent-encoding
    `#token=${t.replace(/\./g, "%2E").replace(/A/g, "+")}`,
    `#token`,
    `#=${t}`,
  ];
  for (const hash of cases) {
    const e = env(hash);
    const r = takeToken(e);
    expect(r.token).toBeNull();
    expect(e.urls.length).toBe(1);
    expect(e.location.hash).toBe("");
    expect(e.store.has(TOKEN_KEY)).toBe(false);
  }
});

test("a bad fragment keeps a good stored token; a tampered stored value is thrown away", () => {
  const t = tok();
  expect(takeToken(env("#token=junk", { stored: t })).token).toBe(t);
  const e = env("", { stored: "<script>x</script>" });
  expect(takeToken(e).token).toBeNull();
  expect(e.store.has(TOKEN_KEY)).toBe(false);
});

test("storage that throws (private mode) still clears the hash and keeps the token in memory", () => {
  const t = tok(), e = env(`#token=${t}`);
  e.storage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  expect(takeToken(e).token).toBe(t);
  expect(e.location.hash).toBe("");
});

test("identity for display: only short plain strings from a well-formed token, else null", () => {
  expect(tokenIdentity(tok())).toEqual({ user: "g:123", name: "Ada L" });
  expect(tokenIdentity(tok({ u: "g:1" }))).toEqual({ user: "g:1", name: "g:1" });
  expect(tokenIdentity(tok({ u: { $gt: "" } }))).toBeNull();
  expect(tokenIdentity(tok({ u: "x".repeat(500) }))).toBeNull();
  expect(tokenIdentity(tok({ u: "a\nb" }))).toBeNull();
  expect(tokenIdentity(tok({ u: "g:1", n: "y".repeat(65) }))).toEqual({ user: "g:1", name: "g:1" });
  expect(tokenIdentity(`s1.${b64url("not json")}.${MAC}`)).toBeNull();
  expect(tokenIdentity("dev-ada")).toBeNull();
  expect(validToken("dev-ada")).toBe(false);
});

test("the page never puts the token in localStorage, a URL, a log, or globalThis.plenary", async () => {
  const src = await Bun.file(new URL("../../web/app.js", import.meta.url)).text();
  const code = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");   // comments out
  const tokenSrc = code(await Bun.file(new URL("../../web/ui/token.js", import.meta.url)).text());
  expect(tokenSrc).not.toMatch(/localStorage|console\./);
  expect(src).not.toMatch(/console\.(log|info|warn|error|debug)\([^)]*(token|signIn|real)/);
  const exposed = /globalThis\.plenary = \{([^}]*)\}/.exec(src)[1];
  expect(exposed).not.toMatch(/token|signIn|real/);
  expect(src).toMatch(/takeToken\(\{ location, history, storage: \(\(\) => \{ try \{ return sessionStorage;/);
});

// The hello each choice actually sends (the session over the dev room, every hello recorded).
function hellos(choice) {
  const net = localRoom({ board: "b1", users: DEV_USERS, clock: true }), sent = [];
  const join = () => { const t = net.join(); return { ...t, send: m => { if (m.t === "hello") sent.push(m.token); t.send(m); } }; };
  const s = createSession({ join, token: choice.token, board: "b1", timers: net.timers, now: net.now });
  net.settle();
  return { sent, status: s.status };
}

test("who signs in: ?as= is the dev path, even with a token; else the token; else dev ada. The hello carries exactly that", () => {
  const t = tok();
  const cases = [
    [{ as: "bo", token: t }, { token: "dev-bo", dev: "bo" }],              // explicit dev wins over a stored/fragment token
    [{ as: "cy", token: null }, { token: "dev-cy", dev: "cy" }],
    [{ as: null, token: t }, { token: t, dev: null }],
    [{ as: null, token: null }, { token: "dev-ada", dev: "ada" }],
    [{ as: "nobody", token: t }, { token: t, dev: null }],                 // unknown ?as= is ignored
    [{ as: "__proto__", token: null }, { token: "dev-ada", dev: "ada" }],
  ];
  for (const [input, want] of cases) expect(chooseSignIn({ ...input, devUsers: DEV_USERS })).toEqual(want);
  // The dev path still works end to end: live as bo, and the hello carried dev-bo only.
  const dev = hellos(chooseSignIn({ as: "bo", token: t, devUsers: DEV_USERS }));
  expect(dev.status).toBe("live");
  expect(new Set(dev.sent)).toEqual(new Set(["dev-bo"]));
  // A session token reaches the hello as is (the dev room refuses it: no server transport yet).
  const real = hellos(chooseSignIn({ token: t, devUsers: DEV_USERS }));
  expect(new Set(real.sent)).toEqual(new Set([t]));
  expect(real.status).toBe("refused");
});

test("a hostile fragment never reaches the hello: whatever it held, the hello carries a dev token or a well-formed one", () => {
  const evil = [`#token=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`, `#token=${"A".repeat(20_000)}`, `#token=${tok()}&token=${tok({ u: "evil" })}`, `#token=${encodeURIComponent(tok() + "\n")}`];
  for (const hash of evil) {
    const { sent } = hellos(chooseSignIn({ as: null, token: takeToken(env(hash)).token, devUsers: DEV_USERS }));
    expect(new Set(sent)).toEqual(new Set(["dev-ada"]));
  }
  // chooseSignIn re-checks: a bad token handed to it straight is not used either.
  expect(chooseSignIn({ token: "<script>", devUsers: DEV_USERS }).token).toBe("dev-ada");
});

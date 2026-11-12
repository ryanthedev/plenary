// The dev harness (scripts/dev-google.js) on the sign-in code exchange (p5-codev MEDIUM 2), without Google: the fake
// IdP stands in through the harness's injected fetch, and the /signed-in page's own script runs with stubbed browser
// globals. Port 0; the server is stopped by handle, never by pattern.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startDevGoogle, ORIGIN } from "../../scripts/dev-google.js";
import { LOGIN_COOKIE, EXCHANGE_COOKIE } from "../../server/auth/http.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

let idp, h;
const logs = [];
beforeAll(async () => {
  idp = await fakeIdp();
  await idp.addKey("k1");
  h = await startDevGoogle({ env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "fake-secret" }, port: 0, fetch: idp.fetch, log: r => logs.push(r) });
});
afterAll(() => h?.stop());

const cookieOf = (res, name) => res.headers.getSetCookie().find(s => s.startsWith(name + "="))?.split(";")[0] ?? null;

/** Run the /signed-in page's script as a browser at `href` would; its fetches go to the harness with `cookie`. */
async function runPage(href, cookie) {
  const html = await (await fetch(h.url + "/signed-in")).text();
  const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const who = { textContent: "" };
  const loc = new URL(href);
  const replaced = [], sent = [];
  const location = { hash: loc.hash, pathname: loc.pathname };
  const history = { replaceState: (_s, _t, u) => { replaced.push(u); location.hash = ""; } };
  const pageFetch = async (path, init = {}) => {
    sent.push({ path, init });
    expect(init.credentials).toBe("same-origin");
    // The browser adds the same-origin cookie and the page's Origin (ORIGIN is postLoginUrl's origin).
    const headers = { ...init.headers, origin: ORIGIN, ...(cookie ? { cookie } : {}) };
    return fetch(h.url + path, { ...init, headers });
  };
  let done;
  const settled = new Promise(r => { done = r; });
  const document = { getElementById: () => new Proxy(who, { set: (o, k, v) => { o[k] = v; if (k === "textContent" && v !== "checking…") done(); return true; } }) };
  new Function("location", "history", "document", "fetch", src)(location, history, document, pageFetch);
  if (!/#code=/.test(href)) done();
  await settled;
  return { text: who.textContent, replaced, sent, hashAtFetch: location.hash };
}

test("harness: login → callback → /signed-in trades #code at POST /auth/exchange and shows 'signed in as <email>'", async () => {
  const start = await fetch(h.url + "/auth/login", { redirect: "manual" });
  const g = new URL(start.headers.get("location"));
  idp.codes.set("dev-1", await idp.mint({ sub: "42", email: "ann@acme.com", hd: "acme.com", name: "Ann", nonce: g.searchParams.get("nonce") }));
  const cb = await fetch(`${h.url}/auth/callback?code=dev-1&state=${g.searchParams.get("state")}`,
    { redirect: "manual", headers: { cookie: cookieOf(start, LOGIN_COOKIE) } });
  expect(cb.status).toBe(302);
  const loc = cb.headers.get("location");
  expect(loc.startsWith(ORIGIN + "/signed-in#code=")).toBe(true);
  expect(loc).not.toContain("s1.");

  const page = await runPage(loc, cookieOf(cb, EXCHANGE_COOKIE));
  expect(page.text).toBe("signed in as ann@acme.com");
  expect(page.replaced).toEqual(["/signed-in"]);                        // the fragment left the address bar
  expect(page.hashAtFetch).toBe("");                                    // ...before the exchange
  expect(page.sent.map(s => s.path)).toEqual(["/auth/exchange"]);
  expect(page.sent[0].init.method).toBe("POST");
  // The log line says whether the exchange cookie came back (presence only), never a value.
  const line = logs.find(l => l.path === "/auth/exchange");
  expect(line).toMatchObject({ method: "POST", status: 200, exchangeCookie: true });
  expect(JSON.stringify(logs)).not.toContain(cookieOf(cb, EXCHANGE_COOKIE).split("=")[1]);
});

test("harness page: no #code shows 'not signed in'; a code without its cookie shows the refusal", async () => {
  expect((await runPage(ORIGIN + "/signed-in", null)).text).toBe("not signed in");
  const r = await runPage(ORIGIN + "/signed-in#code=" + "A".repeat(43), null);
  expect(r.text).toBe("sign-in failed (400 invalid-code)");
  expect(r.replaced).toEqual(["/signed-in"]);
});

test("harness page: a consumer account without a Google-verified email still signs in", async () => {
  const start = await fetch(h.url + "/auth/login", { redirect: "manual" });
  const g = new URL(start.headers.get("location"));
  idp.codes.set("dev-2", await idp.mint({ sub: "77", email: "carol@example.org", name: "Carol", nonce: g.searchParams.get("nonce") }));
  const cb = await fetch(`${h.url}/auth/callback?code=dev-2&state=${g.searchParams.get("state")}`,
    { redirect: "manual", headers: { cookie: cookieOf(start, LOGIN_COOKIE) } });
  const page = await runPage(cb.headers.get("location"), cookieOf(cb, EXCHANGE_COOKIE));
  expect(page.text).toBe("signed in as (no Google-verified email; user google:77)");
});

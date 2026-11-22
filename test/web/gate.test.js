// The sign-in gate (web/adapters/dom/gate.js) on a tiny fake document: the Google link and the dev-user buttons.
import { test, expect, afterEach } from "bun:test";
import { showGate, hideGate } from "../../web/adapters/dom/gate.js";

const el = tag => ({ tag, children: [], attrs: {}, className: "", textContent: "", href: "",
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; }, remove() { gone.push(this); } });
const all = (n, out = []) => { out.push(n); n.children.forEach(c => all(c, out)); return out; };
let body, gone;
const install = () => {
  body = el("body"); gone = [];
  globalThis.document = { body, createElement: el, getElementById: id => body.children.find(c => c.id === id) ?? null };
};
afterEach(() => { delete globalThis.document; });

test("a gate with a Google link and dev links shows one button each, in that order; text only through textContent", () => {
  install();
  showGate({ title: "Sign in", detail: "pick <b>one</b>", link: { href: "/auth/login", text: "Sign in with Google" },
    links: [{ href: "?board=b&as=ada", text: "Continue as ada (owner)" }, { href: "?board=b&as=bo", text: "Continue as bo (editor)" }] });
  const a = all(body).filter(n => n.tag === "a");
  expect(a.map(n => [n.href, n.textContent])).toEqual([["/auth/login", "Sign in with Google"], ["?board=b&as=ada", "Continue as ada (owner)"], ["?board=b&as=bo", "Continue as bo (editor)"]]);
  expect(all(body).find(n => n.tag === "p").textContent).toBe("pick <b>one</b>");
});

test("no dev links: no link row; showing again replaces, hideGate removes", () => {
  install();
  showGate({ title: "A", links: [] });
  expect(all(body).some(n => n.className === "gate-links")).toBe(false);
  const first = body.children[0];
  showGate({ title: "B" });
  expect(body.children).toEqual([first]);
  hideGate();
  expect(gone).toEqual([first]);
});

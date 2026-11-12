// p8-one-link (p7-audit C-5): a class-based transport (every member on its prototype, `fail` as well) keeps the
// transport contract through the session's wrapper (web/core/session.js wrapTransport), the object sync.js holds.
// A spread (`{ ...t }`) would copy none of these members: the contract fails at its first send.
import { test, expect } from "bun:test";
import { transportContract } from "./transport-contract.js";
import { referenceTransport } from "./reference-transport.js";
import { wrapTransport } from "../../../web/core/session.js";

/** The reference transport behind a class: nothing is an own property of the instance. */
class ClassTransport {
  #t; #failed = 0;
  constructor(t) { this.#t = t; }
  send(m) { this.#t.send(m); }
  onMessage(fn) { this.#t.onMessage(fn); }
  onDrop(fn) { this.#t.onDrop(fn); }
  reopen() { this.#t.reopen(); }
  close() { this.#t.close(); }
  congested() { return this.#t.congested(); }
  backlogBytes() { return this.#t.backlogBytes(); }
  fail() { this.#failed++; }
  get failed() { return this.#failed; }
}

transportContract("class-based, through the session's wrapper", () => {
  const d = referenceTransport();
  return { ...d, transport: wrapTransport(new ClassTransport(d.transport)) };
});

test("the wrapper keeps every prototype member a spread loses, `fail` included; absent optional members stay absent", () => {
  const c = new ClassTransport(referenceTransport().transport);
  expect(Object.keys({ ...c })).toEqual([]);                 // what C-5 was about
  const w = wrapTransport(c);
  for (const k of ["send", "onMessage", "onDrop", "reopen", "close", "congested", "backlogBytes", "fail"]) expect(typeof w[k]).toBe("function");
  w.fail();
  expect(c.failed).toBe(1);
  const bare = wrapTransport({ send() {}, onMessage() {}, reopen() {}, close() {} });
  expect("onDrop" in bare).toBe(false);
  expect("fail" in bare).toBe(false);
  expect(bare.congested()).toBe(false);
  expect(bare.backlogBytes()).toBe(0);
});

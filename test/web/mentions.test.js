// Comprehensive tests for Issue #13: @mentions in comments, notifications, and unread/resolved filters.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseMentions,
  matchMentionCandidates,
  extractMentionQuery,
  insertMention,
  filterCommentThreads,
  countThreadFilters,
  buildNotifications,
  markThreadRead,
  markAllThreadsRead,
} from "../../web/core/mentions.js";
import {
  createMentionPicker,
  renderThreadFilterPills,
  createNotificationCenter,
} from "../../web/adapters/dom/mentions.js";

// ── Strict XSS-safe fake DOM (every HTML sink throws) ──
class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
  }
  append(...ns) {
    for (const n of ns) {
      const node = n instanceof FakeNode ? n : new FakeText(String(n));
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
  }
  replaceChildren(...ns) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...ns);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren(new FakeText(String(v)));
  }
}

class FakeText extends FakeNode {
  constructor(t) {
    super(3);
    this.data = t;
  }
  get textContent() {
    return this.data;
  }
}

const sinkTrap = name => ({
  get() { throw new Error(`${name} read: HTML sink forbidden`); },
  set() { throw new Error(`${name} set: HTML sink forbidden`); },
});

class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.className = "";
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.focused = false;
    this.classList = {
      contains: c => this.className.split(/\s+/).includes(c),
      add: c => this.classList.toggle(c, true),
      remove: c => this.classList.toggle(c, false),
      toggle: (c, on) => {
        const s = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on ?? !s.has(c)) s.add(c);
        else s.delete(c);
        this.className = [...s].join(" ");
      },
    };
  }
  setAttribute(k, v) {
    if (/^on/i.test(k)) throw new Error(`event attribute forbidden: ${k}`);
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn);
  }
  dispatch(type, ev = {}) {
    const e = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...ev,
    };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(e);
    return e;
  }
  click() {
    if (!this.disabled) this.dispatch("click");
  }
  focus() {
    this.focused = true;
    if (globalThis.document) globalThis.document.activeElement = this;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get children() {
    return this.childNodes.filter(c => c.nodeType === 1);
  }
  all() {
    return [this, ...this.children.flatMap(c => c.all())];
  }
  find(pred) {
    return this.all().find(pred);
  }
  findAll(pred) {
    return this.all().filter(pred);
  }
}

for (const k of ["innerHTML", "outerHTML"]) {
  Object.defineProperty(FakeElement.prototype, k, sinkTrap(k));
}
FakeElement.prototype.insertAdjacentHTML = () => {
  throw new Error("insertAdjacentHTML: HTML sink forbidden");
};

const savedDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
const savedNode = Object.getOwnPropertyDescriptor(globalThis, "Node");

function installFakeDom() {
  const docListeners = {};
  const body = new FakeElement("body");
  const doc = {
    body,
    activeElement: null,
    createElement: tag => new FakeElement(tag),
    createTextNode: t => new FakeText(t),
    addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { docListeners[type] = (docListeners[type] ?? []).filter(f => f !== fn); },
    dispatch(type, ev = {}) {
      const e = { type, target: body, preventDefault() {}, stopPropagation() {}, ...ev };
      for (const fn of [...(docListeners[type] ?? [])]) fn(e);
      return e;
    },
  };
  globalThis.document = doc;
  globalThis.Node = FakeNode;
  return { doc, body };
}

function restoreFakeDom() {
  if (savedDoc) Object.defineProperty(globalThis, "document", savedDoc);
  else delete globalThis.document;
  if (savedNode) Object.defineProperty(globalThis, "Node", savedNode);
  else delete globalThis.Node;
}

// ── 1. Core: parseMentions ──
describe("parseMentions", () => {
  test("extracts unique @handle and @email tokens normalized to lowercase", () => {
    expect(parseMentions("Hey @Alice, cc @bob_2 and @alice and @carol@acme.io!")).toEqual([
      "alice",
      "bob_2",
      "carol@acme.io",
    ]);
  });

  test("handles trailing punctuation and dotted/hyphenated handles cleanly", () => {
    expect(parseMentions("Ping @ada.lovelace, @grace-hopper. (@alan_turing)!")).toEqual([
      "ada.lovelace",
      "grace-hopper",
      "alan_turing",
    ]);
  });

  test("does not misparse plain email addresses or double-at tokens", () => {
    expect(parseMentions("Email support@acme.io or foo.bar@example.com, not @@ghost.")).toEqual([]);
  });

  test("handles empty and non-string input safely", () => {
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions(/** @type {any} */ (null))).toEqual([]);
    expect(parseMentions(/** @type {any} */ (undefined))).toEqual([]);
  });
});

// ── 2. Core: matchMentionCandidates ──
describe("matchMentionCandidates", () => {
  const participants = [
    { user: "al", handle: "al", name: "Al Smith", email: "al@acme.io", role: "editor" },
    { user: "alice", handle: "alice", name: "Alice Chen", email: "alice@acme.io", role: "owner" },
    { user: "bob", handle: "bob", name: "Bob Alvarez", email: "bob@acme.io", role: "commenter" },
    { user: "carol", handle: "carol", name: "Carol Diaz", email: "al.carol@acme.io", role: "viewer" },
    { user: "dan", handle: "dan", name: "Dan Revoked", email: "al.dan@acme.io", revoked: true },
    { user: "eve", handle: "eve", name: "Eve Hidden", email: "al.eve@acme.io", canView: false },
    { user: "frank", handle: "frank", name: "Frank None", email: "al.frank@acme.io", role: "none" },
  ];

  test("ranks exact handle > handle prefix > name prefix > word prefix > email prefix", () => {
    const res = matchMentionCandidates("al", participants);
    expect(res.map(c => c.handle)).toEqual(["al", "alice", "bob", "carol"]);
  });

  test("excludes people who cannot see the board", () => {
    const res = matchMentionCandidates("", participants);
    const handles = res.map(c => c.handle);
    expect(handles).not.toContain("dan");
    expect(handles).not.toContain("eve");
    expect(handles).not.toContain("frank");
    expect(handles).toEqual(["al", "alice", "bob", "carol"]);
  });

  test("caps results to the specified limit and deduplicates handles", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      handle: `user${String(i).padStart(2, "0")}`,
      name: `User ${i}`,
    }));
    many.push({ handle: "user00", name: "Duplicate User 0" });
    expect(matchMentionCandidates("user", many)).toHaveLength(8);
    expect(matchMentionCandidates("user", many, { limit: 3 }).map(c => c.handle)).toEqual([
      "user00",
      "user01",
      "user02",
    ]);
  });
});

// ── 3. Core: extractMentionQuery & insertMention ──
describe("extractMentionQuery & insertMention", () => {
  test("detects active @query at start, mid-sentence, after newline, and with @email", () => {
    expect(extractMentionQuery("@al", 3)).toEqual({ query: "al", start: 0, end: 3 });
    expect(extractMentionQuery("Hello @", 7)).toEqual({ query: "", start: 6, end: 7 });
    expect(extractMentionQuery("Line 1\n@bob_2 next", 13)).toEqual({ query: "bob_2", start: 7, end: 13 });
    expect(extractMentionQuery("Ping @ada@acme", 14)).toEqual({ query: "ada@acme", start: 5, end: 14 });
  });

  test("returns null when not in a mention token", () => {
    expect(extractMentionQuery("hello world", 11)).toBeNull();
    expect(extractMentionQuery("foo@bar", 7)).toBeNull();
    expect(extractMentionQuery("Hi @alice world", 15)).toBeNull();
  });

  test("replaces active @query with @handle and trailing space, returning updated cursor", () => {
    expect(insertMention("Hi @al", 6, { handle: "alice" })).toEqual({
      text: "Hi @alice ",
      cursor: 10,
    });
    // Preserves following text without doubling an existing space
    expect(insertMention("Hi @al please review", 6, { handle: "alice" })).toEqual({
      text: "Hi @alice please review",
      cursor: 10,
    });
    // Inserts space before punctuation when needed
    expect(insertMention("(@al)", 4, { handle: "alice" })).toEqual({
      text: "(@alice )",
      cursor: 8,
    });
  });
});

// ── 4. Core: filterCommentThreads & buildNotifications ──
describe("filterCommentThreads & buildNotifications", () => {
  const me = { user: "alice", handle: "alice", email: "alice@acme.io" };
  const threads = [
    {
      id: "t1",
      by: "bob",
      at: 100,
      resolved: null,
      comments: [
        { id: "c1", by: "bob", name: "Bob", at: 100, text: "Hey @alice check this" },
      ],
    },
    {
      id: "t2",
      by: "alice",
      at: 200,
      resolved: null,
      comments: [
        { id: "c2", by: "alice", name: "Alice", at: 200, text: "Started this thread" },
        { id: "c3", by: "carol", name: "Carol", at: 250, text: "Looks good to me!" },
      ],
    },
    {
      id: "t3",
      by: "carol",
      at: 300,
      resolved: null,
      comments: [
        { id: "c4", by: "carol", name: "Carol", at: 300, text: "Unrelated thread for @bob" },
      ],
    },
    {
      id: "t4",
      by: "bob",
      at: 400,
      resolved: { by: "alice", name: "Alice", at: 450 },
      comments: [
        { id: "c5", by: "bob", name: "Bob", at: 400, text: "Fixed @alice" },
        { id: "c6", by: "bob", name: "Bob", at: 410, text: "Deleted @alice", deleted: true },
      ],
    },
  ];

  test("filters by all, mentions, unread, and resolved", () => {
    const readAtByThread = { t3: 500, t4: 500 };
    expect(filterCommentThreads(threads, { filter: "all", me, readAtByThread }).map(t => t.id)).toEqual([
      "t1", "t2", "t3", "t4",
    ]);
    expect(filterCommentThreads(threads, { filter: "mentions", me, readAtByThread }).map(t => t.id)).toEqual([
      "t1", "t4",
    ]);
    expect(filterCommentThreads(threads, { filter: "unread", me, readAtByThread }).map(t => t.id)).toEqual([
      "t1", "t2",
    ]);
    expect(filterCommentThreads(threads, { filter: "resolved", me, readAtByThread }).map(t => t.id)).toEqual([
      "t4",
    ]);

    expect(countThreadFilters(threads, { me, readAtByThread })).toEqual({
      all: 4,
      mentions: 2,
      unread: 2,
      resolved: 1,
    });
  });

  test("builds unread mention & reply notifications and supports mark-read", () => {
    const readAt = { t4: 500 };
    const { items, unreadCount } = buildNotifications(threads, { me, readAtByThread: readAt });
    expect(unreadCount).toBe(2);
    expect(items.map(i => ({ threadId: i.threadId, kind: i.kind }))).toEqual([
      { threadId: "t2", kind: "reply" },   // at: 250 (newest)
      { threadId: "t1", kind: "mention" }, // at: 100
    ]);

    // Mark t2 read -> only t1 remains
    const afterOne = markThreadRead(readAt, "t2", 250);
    const res2 = buildNotifications(threads, { me, readAtByThread: afterOne });
    expect(res2.unreadCount).toBe(1);
    expect(res2.items[0].threadId).toBe("t1");

    // Mark all read -> 0 unread
    const afterAll = markAllThreadsRead(afterOne, threads, 600);
    const res3 = buildNotifications(threads, { me, readAtByThread: afterAll });
    expect(res3.unreadCount).toBe(0);
    expect(res3.items).toEqual([]);
  });

  test("never notifies a user for their own comments or unrelated threads", () => {
    const selfOnly = [
      {
        id: "t-self",
        by: "alice",
        comments: [{ id: "c1", by: "alice", at: 10, text: "Note to @alice" }],
      },
      {
        id: "t-other",
        by: "bob",
        comments: [{ id: "c2", by: "carol", at: 20, text: "Just chatting" }],
      },
    ];
    expect(buildNotifications(selfOnly, { me })).toEqual({ items: [], unreadCount: 0 });
  });
});

// ── 5. DOM Adapters + Keyboard Navigation + XSS Safety ──
describe("DOM adapters (mentions, filter pills, notification center)", () => {
  /** @type {{ doc: any, body: FakeElement }} */
  let env;

  beforeEach(() => {
    env = installFakeDom();
  });

  afterEach(() => {
    restoreFakeDom();
  });

  test("createMentionPicker supports ArrowDown/ArrowUp/Enter/Tab/Escape keyboard navigation", () => {
    const textarea = /** @type {any} */ (document.createElement("textarea"));
    env.body.append(textarea);

    const participants = [
      { handle: "alice", name: "Alice Chen", email: "alice@acme.io" },
      { handle: "alberto", name: "Alberto Ruiz", email: "alberto@acme.io" },
      { handle: "bob", name: "Bob Lee", email: "bob@acme.io" },
    ];
    /** @type {any[]} */
    const selected = [];
    const picker = createMentionPicker({
      textarea,
      getParticipants: () => participants,
      onSelect: (c, res) => selected.push({ handle: c.handle, res }),
    });

    // Type "@al"
    textarea.value = "Ping @al";
    textarea.setSelectionRange(8, 8);
    textarea.dispatch("input");

    expect(picker.isOpen()).toBe(true);
    expect(picker.candidates().map(c => c.handle)).toEqual(["alice", "alberto"]);
    expect(picker.activeIndex()).toBe(0);
    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    // ArrowDown -> index 1
    const down = textarea.dispatch("keydown", { key: "ArrowDown" });
    expect(down.defaultPrevented).toBe(true);
    expect(picker.activeIndex()).toBe(1);

    // ArrowUp -> index 0
    textarea.dispatch("keydown", { key: "ArrowUp" });
    expect(picker.activeIndex()).toBe(0);

    // ArrowUp wraps to last item (index 1)
    textarea.dispatch("keydown", { key: "ArrowUp" });
    expect(picker.activeIndex()).toBe(1);

    // Enter selects "alberto"
    const enter = textarea.dispatch("keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(picker.isOpen()).toBe(false);
    expect(textarea.value).toBe("Ping @alberto ");
    expect(textarea.selectionStart).toBe(14);
    expect(selected).toEqual([{ handle: "alberto", res: { text: "Ping @alberto ", cursor: 14 } }]);

    // Re-open with "@b" and select with Tab
    textarea.value = "Ping @alberto @b";
    textarea.setSelectionRange(16, 16);
    textarea.dispatch("input");
    expect(picker.isOpen()).toBe(true);
    textarea.dispatch("keydown", { key: "Tab" });
    expect(textarea.value).toBe("Ping @alberto @bob ");
    expect(picker.isOpen()).toBe(false);

    // Re-open and close with Escape
    textarea.value = "@a";
    textarea.setSelectionRange(2, 2);
    textarea.dispatch("input");
    expect(picker.isOpen()).toBe(true);
    const esc = textarea.dispatch("keydown", { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(picker.isOpen()).toBe(false);

    picker.destroy();
  });

  test("renderThreadFilterPills renders accessible role=tablist with badges and keyboard nav", () => {
    /** @type {string[]} */
    const changes = [];
    const bar = /** @type {any} */ (renderThreadFilterPills({
      active: "mentions",
      counts: { all: 12, mentions: 3, unread: 120, resolved: 0 },
      onChange: f => changes.push(f),
    }));

    expect(bar.getAttribute("role")).toBe("tablist");
    const tabs = bar.findAll(e => e.getAttribute("role") === "tab");
    expect(tabs).toHaveLength(4);
    expect(tabs.map(t => t.getAttribute("data-filter"))).toEqual(["all", "mentions", "unread", "resolved"]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("tabindex")).toBe("0");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs[0].getAttribute("tabindex")).toBe("-1");

    // Unread badge caps display at 99+ and resolved (0) renders no badge
    expect(tabs[2].textContent).toContain("99+");
    expect(tabs[3].findAll(e => e.classList.contains("thread-filter-badge"))).toHaveLength(0);

    // Click and ArrowRight navigation
    tabs[2].click();
    tabs[1].dispatch("keydown", { key: "ArrowRight" });
    tabs[1].dispatch("keydown", { key: "End" });
    expect(changes).toEqual(["unread", "unread", "resolved"]);
  });

  test("createNotificationCenter renders bell badge, opens dropdown, opens thread, and marks all read", () => {
    let items = [
      {
        id: "t1:c1",
        threadId: "t1",
        commentId: "c1",
        kind: /** @type {"mention"} */ ("mention"),
        by: "bob",
        authorName: "Bob",
        text: "Hey @alice look here",
        at: 100,
        unread: true,
        resolved: false,
      },
    ];
    /** @type {string[]} */
    const opened = [];
    let markedAll = 0;

    const nc = createNotificationCenter({
      getNotifications: () => ({ items, unreadCount: items.length }),
      onOpenThread: threadId => opened.push(threadId),
      onMarkAllRead: () => {
        markedAll++;
        items = [];
      },
    });
    env.body.append(nc.el);

    expect(nc.button.getAttribute("aria-expanded")).toBe("false");
    expect(nc.button.textContent).toContain("1");
    expect(nc.isOpen()).toBe(false);

    // Open dropdown
    nc.button.click();
    expect(nc.isOpen()).toBe(true);
    expect(nc.button.getAttribute("aria-expanded")).toBe("true");

    // Click notification item -> opens thread & closes dropdown
    const row = /** @type {any} */ (nc.dropdown).find(e => e.getAttribute("data-thread-id") === "t1");
    expect(row).toBeTruthy();
    row.click();
    expect(opened).toEqual(["t1"]);
    expect(nc.isOpen()).toBe(false);

    // Re-open & click Mark all read
    nc.open();
    const markBtn = /** @type {any} */ (nc.dropdown).find(e => e.classList.contains("notification-mark-all"));
    markBtn.click();
    expect(markedAll).toBe(1);
    expect(nc.dropdown.textContent).toContain("No unread notifications");
    expect(nc.button.getAttribute("aria-label")).toBe("Notifications");

    // Escape closes dropdown
    /** @type {any} */ (nc.el).dispatch("keydown", { key: "Escape" });
    expect(nc.isOpen()).toBe(false);
    nc.destroy();
  });

  test("XSS payloads in names, handles, and comments never touch HTML sinks and render as literal text", () => {
    const xss = '<img src=x onerror=alert("xss")><script>evil()</script>';
    const textarea = /** @type {any} */ (document.createElement("textarea"));
    env.body.append(textarea);

    const picker = createMentionPicker({
      textarea,
      getParticipants: () => [{ handle: "mallory", name: xss, email: "mallory@evil.test" }],
    });
    textarea.value = "@mal";
    textarea.setSelectionRange(4, 4);
    textarea.dispatch("input");

    expect(picker.isOpen()).toBe(true);
    expect(picker.el.textContent).toContain(xss);
    picker.destroy();

    const nc = createNotificationCenter({
      getNotifications: () => ({
        items: [{
          id: "tx:cx",
          threadId: "tx",
          commentId: "cx",
          kind: "mention",
          by: "mallory",
          authorName: xss,
          text: `Check ${xss}`,
          at: 1,
          unread: true,
          resolved: false,
        }],
        unreadCount: 1,
      }),
    });
    nc.open();
    expect(nc.dropdown.textContent).toContain(xss);
    // No <img> or <script> element was created — only safe text nodes
    const tags = /** @type {any} */ (nc.dropdown).all().map(e => e.tagName);
    expect(tags).not.toContain("IMG");
    expect(tags).not.toContain("SCRIPT");
    nc.destroy();
  });
});

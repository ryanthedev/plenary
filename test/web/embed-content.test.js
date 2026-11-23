// Issue #24: Expanded content embeds (Figma, docs, PDF pages) + tenant embed allow-list tests.
import { describe, test, expect } from "bun:test";
import {
  parseEmbedUrl,
  parsePdfPage,
  isEmbedAllowed,
  checkEmbedPolicy,
  buildEmbedElement,
  parseEmbedFromElement,
  FIGMA_EMBED_ORIGIN,
  EMBED_SANDBOX,
} from "../../packages/core/embed.js";
import { createEmbedOverlay } from "../../web/adapters/dom/embed-overlay.js";
import { opProblem } from "../../packages/protocol/envelope.js";

function makeFakeDom() {
  const listeners = new Map();
  const makeEl = tag => {
    const elListeners = new Map();
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      style: {},
      children: [],
      parentNode: null,
      textContent: "",
      type: "",
      src: "",
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(ev, fn) {
        if (!elListeners.has(ev)) elListeners.set(ev, new Set());
        elListeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) { elListeners.get(ev)?.delete(fn); },
      dispatchEvent(ev, payload = {}) {
        for (const fn of [...(elListeners.get(ev) ?? [])]) fn(payload);
      },
    };
    return el;
  };
  const doc = {
    hidden: false,
    visibilityState: "visible",
    createElement: makeEl,
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) { listeners.get(ev)?.delete(fn); },
  };
  const win = { addEventListener() {}, removeEventListener() {} };
  const root = makeEl("div");
  return { root, doc, win };
}

describe("Issue #24 — Figma, Document, and PDF embed parsing", () => {
  test("parses Figma file, design, board, and proto URLs into safe figma.com/embed descriptors", () => {
    const cases = [
      ["https://www.figma.com/file/AbCd1234EfGh/Mobile-App", "file", "AbCd1234EfGh", "Mobile App"],
      ["https://figma.com/design/XyZ987654321/Design-System", "design", "XyZ987654321", "Design System"],
      ["https://www.figma.com/board/JamBoard9999/Sprint-Retro", "board", "JamBoard9999", "Sprint Retro"],
      ["https://www.figma.com/proto/ProtoKey4242/Checkout-Flow?node-id=1-2", "proto", "ProtoKey4242", "Checkout Flow"],
    ];
    for (const [url, kind, fileKey, title] of cases) {
      const parsed = parseEmbedUrl(url);
      expect(parsed).not.toBeNull();
      expect(parsed.provider).toBe("figma");
      expect(parsed.providerName).toBe("Figma");
      expect(parsed.figmaKind).toBe(kind);
      expect(parsed.fileKey).toBe(fileKey);
      expect(parsed.title).toBe(title);
      expect(parsed.sandbox).toBe(EMBED_SANDBOX.figma);
      expect(parsed.embedUrl.startsWith(`${FIGMA_EMBED_ORIGIN}/embed?embed_host=plenary&url=`)).toBe(true);
      expect(decodeURIComponent(parsed.embedUrl.split("url=")[1])).toBe(parsed.url);
    }

    // Reject invalid Figma URLs
    expect(parseEmbedUrl("https://www.figma.com/")).toBeNull();
    expect(parseEmbedUrl("https://www.figma.com/file/ab")).toBeNull();
    expect(parseEmbedUrl("https://www.figma.com/community/plugin/123456")).toBeNull();
    expect(parseEmbedUrl("http://www.figma.com/design/AbCd1234EfGh/Test")).toBeNull();
  });

  test("parses Google Docs/Sheets/Slides and Notion public embeds", () => {
    const gdoc = parseEmbedUrl("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#heading=h.1");
    expect(gdoc).toMatchObject({
      provider: "doc",
      docKind: "google-docs",
      embedUrl: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview",
      host: "docs.google.com",
      sandbox: EMBED_SANDBOX.doc,
    });

    const gsheet = parseEmbedUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit");
    expect(gsheet).toMatchObject({
      provider: "doc",
      docKind: "google-sheets",
      embedUrl: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview",
    });

    const gslides = parseEmbedUrl("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit");
    expect(gslides).toMatchObject({
      provider: "doc",
      docKind: "google-slides",
      embedUrl: "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/embed",
    });

    const notion = parseEmbedUrl("https://acme.notion.site/Product-Roadmap-0123456789abcdef0123456789abcdef");
    expect(notion).toMatchObject({
      provider: "doc",
      docKind: "notion",
      host: "acme.notion.site",
      title: "Product Roadmap",
      embedUrl: "https://acme.notion.site/Product-Roadmap-0123456789abcdef0123456789abcdef",
    });

    // Generic HTTPS doc URL is rejected without allow-list, accepted when allow-listed
    const genericUrl = "https://wiki.acme.internal/specs/rfc-42";
    expect(parseEmbedUrl(genericUrl)).toBeNull();
    const allowedGeneric = parseEmbedUrl(genericUrl, {
      policy: { allowDomains: ["wiki.acme.internal"] },
      enforcePolicy: true,
    });
    expect(allowedGeneric).toMatchObject({
      provider: "doc",
      docKind: "generic",
      host: "wiki.acme.internal",
      embedUrl: genericUrl,
    });
  });

  test("parses .pdf URLs and signed /blobs/... PDF refs with #page=N support", () => {
    expect(parsePdfPage("#page=5")).toBe(5);
    expect(parsePdfPage("#zoom=125&page=14")).toBe(14);
    expect(parsePdfPage("#page=0")).toBeUndefined();
    expect(parsePdfPage("#page=-2")).toBeUndefined();
    expect(parsePdfPage("#page=abc")).toBeUndefined();

    const httpsPdf = parseEmbedUrl("https://cdn.example.com/specs/architecture.pdf#page=7");
    expect(httpsPdf).toMatchObject({
      provider: "pdf",
      providerName: "PDF",
      host: "cdn.example.com",
      page: 7,
      embedUrl: "https://cdn.example.com/specs/architecture.pdf#page=7",
      sandbox: EMBED_SANDBOX.pdf,
    });

    const blobPdf = parseEmbedUrl("/blobs/eyJ0ZW5hbnQiOiJ0MSJ9.abcDEF_123-456#page=3");
    expect(blobPdf).toMatchObject({
      provider: "pdf",
      providerName: "PDF",
      host: "self",
      isBlobRef: true,
      page: 3,
      embedUrl: "/blobs/eyJ0ZW5hbnQiOiJ0MSJ9.abcDEF_123-456#page=3",
      sandbox: EMBED_SANDBOX.pdf,
    });

    // Path traversal or unsafe blob ref rejected
    expect(parseEmbedUrl("/blobs/../etc/passwd")).toBeNull();
    expect(parseEmbedUrl("/blobs/a/b")).toBeNull();
    expect(parseEmbedUrl("/blobs/abc<script>")).toBeNull();
  });
});

describe("Issue #24 — Tenant embed allow-list policy (isEmbedAllowed & insert-time enforcement)", () => {
  test("enforces defaultDeny, allowDomains (exact & wildcard), allowProviders, and deny rules", () => {
    const figmaUrl = "https://www.figma.com/design/AbCd1234EfGh/UI";
    const ytUrl = "https://youtu.be/dQw4w9WgXcQ";
    const acmeDoc = "https://docs.acme.com/handbook";
    const spoofDoc = "https://evilacme.com/handbook";

    // No policy => allowed
    expect(isEmbedAllowed(figmaUrl, null)).toBe(true);
    expect(isEmbedAllowed(ytUrl, undefined)).toBe(true);

    // defaultDeny with empty allow lists => denies everything
    expect(isEmbedAllowed(figmaUrl, { defaultDeny: true })).toBe(false);
    expect(checkEmbedPolicy(figmaUrl, { defaultDeny: true }).reason).toBe("default-deny");

    // allowProviders restricts to listed providers
    const figmaPdfOnly = { defaultDeny: true, allowProviders: ["figma", "pdf"] };
    expect(isEmbedAllowed(figmaUrl, figmaPdfOnly)).toBe(true);
    expect(isEmbedAllowed("https://cdn.example.com/spec.pdf#page=2", figmaPdfOnly)).toBe(true);
    expect(isEmbedAllowed(ytUrl, figmaPdfOnly)).toBe(false);

    // allowDomains supports exact + subdomain and wildcard *.acme.com without suffix-spoofing
    const domainPolicy = { defaultDeny: true, allowDomains: ["*.acme.com", "figma.com"] };
    expect(isEmbedAllowed(acmeDoc, domainPolicy)).toBe(true);
    expect(isEmbedAllowed("https://acme.com/root", domainPolicy)).toBe(false); // *.acme.com requires subdomain
    expect(isEmbedAllowed(spoofDoc, domainPolicy)).toBe(false);
    expect(isEmbedAllowed(figmaUrl, domainPolicy)).toBe(true);
    expect(isEmbedAllowed(ytUrl, domainPolicy)).toBe(false);

    // Explicit deny overrides allow
    expect(isEmbedAllowed(figmaUrl, { allowProviders: ["figma"], denyDomains: ["figma.com"] })).toBe(false);
    expect(isEmbedAllowed(figmaUrl, { allowDomains: ["figma.com"], denyProviders: ["figma"] })).toBe(false);

    // Invalid URLs are always denied
    expect(isEmbedAllowed("javascript:alert(1)", null)).toBe(false);
    expect(isEmbedAllowed("http://figma.com/design/AbCd1234EfGh/UI", { allowDomains: ["figma.com"] })).toBe(false);
  });

  test("buildEmbedElement enforces tenant policy at insert time and produces Protocol v1.1-valid elements", () => {
    const policy = { defaultDeny: true, allowProviders: ["figma", "pdf"] };

    const figmaEl = buildEmbedElement("https://www.figma.com/design/AbCd1234EfGh/Spec", { id: "fig1", policy });
    expect(figmaEl).not.toBeNull();
    expect(figmaEl.customData.embed.provider).toBe("figma");
    expect(opProblem({ t: "op", stream: "board", id: "c1:1", sentAt: 0, op: { elements: [figmaEl] } })).toBeNull();

    const pdfEl = buildEmbedElement("https://cdn.example.com/guide.pdf#page=4", { id: "pdf1", policy });
    expect(pdfEl).not.toBeNull();
    expect(pdfEl.customData.embed.page).toBe(4);
    expect(opProblem({ t: "op", stream: "board", id: "c1:2", sentAt: 0, op: { elements: [pdfEl] } })).toBeNull();

    // Disallowed provider blocked at insert time
    const blockedYt = buildEmbedElement("https://youtu.be/dQw4w9WgXcQ", { id: "yt1", policy });
    expect(blockedYt).toBeNull();
  });
});

describe("Issue #24 — Embed overlay render-time sandboxing & policy enforcement", () => {
  test("renders click-to-activate sandboxed iframes for Figma, Docs, and PDF pages", () => {
    const env = makeFakeDom();
    const ov = createEmbedOverlay(env);
    const fig = buildEmbedElement("https://www.figma.com/design/AbCd1234EfGh/Mock", { id: "f1", x: 0, y: 0 });
    const doc = buildEmbedElement("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit", { id: "d1", x: 600, y: 0 });
    const pdf = buildEmbedElement("/blobs/tok123.sig456#page=9", { id: "p1", x: 0, y: 500 });

    ov.sync({ elements: [fig, doc, pdf], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 2000, h: 1500 } });
    expect(ov.mountedIds()).toEqual(["f1", "d1", "p1"]);
    // Zero iframes before click
    expect(ov.getEntry("f1").media).toBeNull();
    expect(ov.getEntry("d1").media).toBeNull();
    expect(ov.getEntry("p1").media).toBeNull();

    // Activate Figma
    expect(ov.activate("f1")).toBe(true);
    const fNode = ov.getEntry("f1").media;
    expect(fNode.tagName).toBe("IFRAME");
    expect(fNode.getAttribute("sandbox")).toBe(EMBED_SANDBOX.figma);
    expect(fNode.src.startsWith(`${FIGMA_EMBED_ORIGIN}/embed?embed_host=plenary&url=`)).toBe(true);

    // Activate Google Doc
    expect(ov.activate("d1")).toBe(true);
    const dNode = ov.getEntry("d1").media;
    expect(dNode.tagName).toBe("IFRAME");
    expect(dNode.getAttribute("sandbox")).toBe(EMBED_SANDBOX.doc);
    expect(dNode.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(dNode.src).toBe("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview");

    // Activate PDF page
    expect(ov.activate("p1")).toBe(true);
    const pNode = ov.getEntry("p1").media;
    expect(pNode.tagName).toBe("IFRAME");
    expect(pNode.getAttribute("sandbox")).toBe(EMBED_SANDBOX.pdf);
    expect(pNode.getAttribute("data-pdf-page")).toBe("9");
    expect(pNode.src).toBe("/blobs/tok123.sig456#page=9");

    ov.destroy();
  });

  test("shows clear blocked notice and refuses activation when disallowed by tenant policy (including live policy tightening)", () => {
    const env = makeFakeDom();
    const policy = { defaultDeny: true, allowProviders: ["figma"] };
    const ov = createEmbedOverlay({ ...env, policy });

    const fig = buildEmbedElement("https://www.figma.com/design/AbCd1234EfGh/Mock", { id: "f1", x: 0, y: 0 });
    const yt = buildEmbedElement("https://youtu.be/dQw4w9WgXcQ", { id: "y1", x: 600, y: 0 });
    expect(parseEmbedFromElement(yt)).not.toBeNull();

    ov.sync({ elements: [fig, yt], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 2000, h: 1500 } });

    const ytEntry = ov.getEntry("y1");
    expect(ytEntry.blocked).toBe(true);
    expect(ytEntry.wrap.getAttribute("data-embed-blocked")).toBe("true");
    expect(ytEntry.blockedNotice.style.display).toBe("flex");
    expect(ytEntry.blockedNotice.textContent).toContain("blocked by tenant policy");
    expect(ytEntry.playBtn.style.display).toBe("none");
    expect(ov.activate("y1")).toBe(false);
    expect(ytEntry.media).toBeNull();

    // Figma is allowed and activates
    expect(ov.activate("f1")).toBe(true);
    expect(ov.getEntry("f1").media?.tagName).toBe("IFRAME");

    // Live policy tightening to deny everything immediately tears down active Figma iframe
    ov.setPolicy({ defaultDeny: true });
    const figEntry = ov.getEntry("f1");
    expect(figEntry.blocked).toBe(true);
    expect(figEntry.media).toBeNull();
    expect(ov.activeIds()).toEqual([]);
    expect(figEntry.blockedNotice.style.display).toBe("flex");

    ov.destroy();
  });
});

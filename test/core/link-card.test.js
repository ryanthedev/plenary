// Rich link cards (Issue #30): pure URL parsing, security rejection, protocol v1.1
// validation, display-list rendering, and Editor paste / click-to-open behavior.
import { describe, test, expect } from "bun:test";
import {
  parseLinkCardUrl,
  safeLinkCardUrl,
  buildLinkCard,
  parseLinkCardFromElement,
  isLinkCard,
  linkCardOpenBadgeRect,
  isPointInLinkCardOpenAction,
  MAX_LINK_CARD_URL_LENGTH,
  LINK_CARD_WIDTH,
  LINK_CARD_HEIGHT,
} from "../../packages/core/link-card.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { Room } from "../../packages/protocol/room.js";
import { MemoryLog } from "../../packages/protocol/ports.js";
import { Doc } from "../../packages/core/doc.js";
import { Editor } from "../../packages/core/editor.js";
import { paintScene } from "../../packages/core/render.js";
import { LIGHT, DARK } from "../../packages/core/export.js";
import { makeElement } from "../../packages/core/model.js";

describe("parseLinkCardUrl — GitHub", () => {
  test("parses issue, PR, and discussion URLs", () => {
    const issue = parseLinkCardUrl("https://github.com/acme/plenary/issues/30");
    expect(issue).toMatchObject({
      provider: "github",
      providerName: "GitHub",
      kind: "Issue",
      key: "acme/plenary#30",
      shortKey: "#30",
      subtitle: "acme/plenary",
      url: "https://github.com/acme/plenary/issues/30",
    });

    const pr = parseLinkCardUrl("https://github.com/acme/plenary/pull/128");
    expect(pr).toMatchObject({
      provider: "github",
      kind: "PR",
      key: "acme/plenary#128",
      shortKey: "#128",
      subtitle: "acme/plenary",
    });

    const disc = parseLinkCardUrl("https://github.com/acme/plenary/discussions/9");
    expect(disc).toMatchObject({
      provider: "github",
      kind: "Discussion",
      key: "acme/plenary#9",
      shortKey: "#9",
    });
  });

  test("handles query params, hashes, trailing slashes, PR subpaths, and www host", () => {
    const withNoise = parseLinkCardUrl("  https://www.github.com/org-1/my.repo_2/pull/42/files?w=1#diff-abc  ");
    expect(withNoise).not.toBeNull();
    expect(withNoise.provider).toBe("github");
    expect(withNoise.kind).toBe("PR");
    expect(withNoise.key).toBe("org-1/my.repo_2#42");
    expect(withNoise.url).toBe("https://github.com/org-1/my.repo_2/pull/42/files?w=1#diff-abc");

    const trailing = parseLinkCardUrl("https://github.com/acme/plenary/issues/7/");
    expect(trailing?.key).toBe("acme/plenary#7");
  });
});

describe("parseLinkCardUrl — Linear", () => {
  test("parses issue URL with slug into a clean display title", () => {
    const res = parseLinkCardUrl("https://linear.app/plenary/issue/ENG-412/add-rich-link-cards-on-paste");
    expect(res).toMatchObject({
      provider: "linear",
      providerName: "Linear",
      kind: "Issue",
      key: "ENG-412",
      shortKey: "ENG-412",
      subtitle: "plenary",
      title: "Add rich link cards on paste",
      url: "https://linear.app/plenary/issue/ENG-412/add-rich-link-cards-on-paste",
    });
  });

  test("parses issue URL without slug and normalizes key case", () => {
    const res = parseLinkCardUrl("https://linear.app/acme/issue/ops-99/?view=detail#comments");
    expect(res).toMatchObject({
      provider: "linear",
      kind: "Issue",
      key: "OPS-99",
      subtitle: "acme",
      title: "acme / OPS-99",
    });
  });

  test("sanitizes XSS-like payloads in Linear slugs", () => {
    const res = parseLinkCardUrl("https://linear.app/acme/issue/SEC-7/%3Cscript%3Ealert(1)%3C%2Fscript%3E-fix-xss");
    expect(res).not.toBeNull();
    expect(res.title).not.toContain("<");
    expect(res.title).not.toContain(">");
    expect(res.title).not.toContain("<script>");
    expect(res.title.toLowerCase()).toContain("fix xss");
  });
});

describe("parseLinkCardUrl — Jira", () => {
  test("parses /browse/<KEY> URLs", () => {
    const res = parseLinkCardUrl("https://acme-corp.atlassian.net/browse/PLAT-2048");
    expect(res).toMatchObject({
      provider: "jira",
      providerName: "Jira",
      kind: "Issue",
      key: "PLAT-2048",
      shortKey: "PLAT-2048",
      subtitle: "acme-corp.atlassian.net",
      url: "https://acme-corp.atlassian.net/browse/PLAT-2048",
    });
  });

  test("parses /jira/... selectedIssue query param and path segment URLs", () => {
    const q = parseLinkCardUrl("https://team.atlassian.net/jira/software/projects/WEB/boards/4?selectedIssue=web-88&sprint=2");
    expect(q).toMatchObject({
      provider: "jira",
      kind: "Issue",
      key: "WEB-88",
      subtitle: "team.atlassian.net",
    });

    const seg = parseLinkCardUrl("https://team.atlassian.net/jira/software/c/projects/ENG/boards/1/selectedIssue=ENG-305");
    expect(seg).toMatchObject({
      provider: "jira",
      kind: "Issue",
      key: "ENG-305",
      subtitle: "team.atlassian.net",
    });
  });
});

describe("parseLinkCardUrl — security & malformed rejection", () => {
  const rejected = [
    "",
    "   ",
    null,
    undefined,
    123,
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "http://github.com/acme/plenary/issues/30",
    "http://linear.app/acme/issue/ENG-1",
    "http://acme.atlassian.net/browse/PROJ-1",
    "//github.com/acme/plenary/issues/30",
    "https://user:pass@github.com/acme/plenary/issues/30",
    "https://token@linear.app/acme/issue/ENG-1",
    "https://github.com:8443/acme/plenary/issues/30",
    "https://github.com/acme/plenary/issues/30\nhttps://github.com/acme/plenary/issues/31",
    "https://github.com/acme/plenary/issues/30 extra text",
    "https://github.com/acme/plenary/issues/30%0d%0aSet-Cookie:a=b",
    "https://github.com\\acme\\plenary\\issues\\30",
    "https://atlassian.net/browse/PROJ-1",
    "https://evil-github.com/acme/plenary/issues/30",
    "https://github.com.evil.test/acme/plenary/issues/30",
    "https://github.com/acme/plenary",
    "https://github.com/acme/plenary/issues/0",
    "https://github.com/acme/plenary/issues/abc",
    "https://example.com/some/page",
    `https://linear.app/acme/issue/ENG-1/${"a".repeat(MAX_LINK_CARD_URL_LENGTH)}`,
  ];

  test("rejects every unsafe, malformed, or unsupported URL", () => {
    for (const input of rejected) {
      expect(parseLinkCardUrl(input)).toBeNull();
      expect(safeLinkCardUrl(input)).toBeNull();
    }
  });

  test("parseLinkCardFromElement rejects tampered customData when el.link is unsafe", () => {
    const evil = makeElement("rectangle", {
      width: 300,
      height: 100,
      link: "javascript:alert(1)",
      customData: { linkCard: { version: 1, provider: "github", kind: "PR", key: "a/b#1", title: "Spoof" } },
    });
    expect(parseLinkCardFromElement(evil)).toBeNull();
    expect(isLinkCard(evil)).toBe(false);
  });
});

describe("buildLinkCard & protocol v1.1 validation", () => {
  test("generated cards for GitHub, Linear, and Jira pass protocol v1.1 opProblem & Room sync", () => {
    const urls = [
      "https://github.com/acme/plenary/pull/30",
      "https://linear.app/plenary/issue/ENG-42/rich-link-cards",
      "https://plenary.atlassian.net/browse/DEV-101",
    ];
    const cards = urls.map((u, i) => buildLinkCard(u, { x: i * 380, y: 40 }));
    for (const el of cards) {
      expect(el).not.toBeNull();
      expect(el.type).toBe("rectangle");
      expect(el.width).toBe(LINK_CARD_WIDTH);
      expect(el.height).toBe(LINK_CARD_HEIGHT);
      expect(isLinkCard(el)).toBe(true);
    }

    const msg = {
      t: "op",
      stream: "board",
      id: "c1:1",
      sentAt: 0,
      op: { elements: cards },
    };
    expect(opProblem(msg)).toBeNull();

    // Sync through a real protocol Room to verify full acceptance & state round-trip
    const log = new MemoryLog();
    const room = new Room({ board: "b1", tenant: "t1", log });
    const conn = { id: "conn1", user: "ada", role: "owner", client: "c1", send() {} };
    room.hello(conn, { t: "hello", v: 1, board: "b1", since: 0, client: "c1", user: "ada", role: "owner" });
    room.op(conn, msg);
    const live = room.streams.board.live();
    expect(live.length).toBe(3);
    for (const el of live) {
      expect(isLinkCard(el)).toBe(true);
    }
  });
});

describe("render.js rich link card display list", () => {
  test("renders crisp vector primitives and text in light/dark themes and with rotation", () => {
    const cards = [
      buildLinkCard("https://github.com/acme/plenary/pull/30", { x: 0, y: 0 }),
      buildLinkCard("https://linear.app/plenary/issue/ENG-42/ship-link-cards", { x: 400, y: 0 }),
      buildLinkCard("https://plenary.atlassian.net/browse/DEV-7", { x: 800, y: 0 }),
    ];
    cards[1].angle = 0.25;
    cards[2].opacity = 70;
    const doc = new Doc({ elements: cards });

    for (const theme of [LIGHT, DARK]) {
      const items = paintScene(doc, { x: 20, y: 20, scale: 1 }, theme);
      const paths = items.filter(it => it.t === "path");
      const texts = items.filter(it => it.t === "text");
      expect(paths.length).toBeGreaterThanOrEqual(24);
      expect(texts.length).toBeGreaterThanOrEqual(9);
      expect(texts.map(t => t.text)).toEqual(expect.arrayContaining([
        "PR #30",
        "ENG-42",
        "Ship link cards",
        "DEV-7",
      ]));
      // Ensure rotated card text carries its rotation angle
      const rotatedText = texts.find(t => t.text === "Ship link cards");
      expect(rotatedText.angle).toBeCloseTo(0.25, 5);
    }
  });

  test("tiny resized cards (10x10 and 2x2) keep all rendered primitives and badge hit-testing strictly inside card bounds", () => {
    for (const [w, h] of [[10, 10], [2, 2], [28, 20]]) {
      const card = buildLinkCard("https://github.com/acme/plenary/pull/30", { x: 100, y: 200, width: w, height: h });
      const doc = new Doc({ elements: [card] });
      const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT, { allText: true });
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) {
        if (it.t === "path") {
          for (const c of it.cmds) {
            for (let i = 1; i + 1 < c.length; i += 2) {
              expect(c[i]).toBeGreaterThanOrEqual(100 - 1e-6);
              expect(c[i]).toBeLessThanOrEqual(100 + w + 1e-6);
              expect(c[i + 1]).toBeGreaterThanOrEqual(200 - 1e-6);
              expect(c[i + 1]).toBeLessThanOrEqual(200 + h + 1e-6);
            }
          }
        } else if (it.t === "text") {
          expect(it.x).toBeGreaterThanOrEqual(100 - 1e-6);
          expect(it.x).toBeLessThanOrEqual(100 + w + 1e-6);
          expect(it.y).toBeGreaterThanOrEqual(200 - 1e-6);
          expect(it.y).toBeLessThanOrEqual(200 + h + 1e-6);
        }
      }
      // Badge hit-test is disabled on tiny cards so it never overflows outside card bounds
      expect(linkCardOpenBadgeRect(card)).toBeNull();
      expect(isPointInLinkCardOpenAction(card, { x: 100 + w / 2, y: 200 + h / 2 })).toBe(false);
      expect(isPointInLinkCardOpenAction(card, { x: 95, y: 195 })).toBe(false);
    }

    // For a card just large enough to show the badge, badge rect and hit-test stay strictly within bounds
    const small = buildLinkCard("https://linear.app/plenary/issue/ENG-1/small", { x: 50, y: 60, width: 48, height: 32 });
    const badge = linkCardOpenBadgeRect(small);
    expect(badge).not.toBeNull();
    expect(badge.x).toBeGreaterThanOrEqual(50);
    expect(badge.x + badge.w).toBeLessThanOrEqual(50 + 48);
    expect(badge.y).toBeGreaterThanOrEqual(60);
    expect(badge.y + badge.h).toBeLessThanOrEqual(60 + 32);
    expect(isPointInLinkCardOpenAction(small, { x: badge.x + badge.w / 2, y: badge.y + badge.h / 2 })).toBe(true);
    // Point outside the card's right edge must not trigger even with hit padding
    expect(isPointInLinkCardOpenAction(small, { x: 50 + 48 + 2, y: badge.y + badge.h / 2 })).toBe(false);
  });
});

describe("Editor paste, cursor & click-to-open", () => {
  test("pasting a supported URL creates & selects a rich link card with flash message and undo support", () => {
    const ed = new Editor();
    ed.setSize(800, 600);
    ed.paste("https://github.com/acme/plenary/pull/30");
    expect(ed.flash).toBe("Added GitHub PR card");
    const live = ed.doc.live();
    expect(live.length).toBe(1);
    expect(ed.sel.has(live[0].id)).toBe(true);
    expect(parseLinkCardFromElement(live[0])?.key).toBe("acme/plenary#30");

    ed.undo();
    expect(ed.doc.live().length).toBe(0);
    ed.redo();
    expect(ed.doc.live().length).toBe(1);
  });

  test("pasting a plain non-card URL still falls back to normal text element", () => {
    const ed = new Editor();
    ed.paste("https://example.com/docs");
    const live = ed.doc.live();
    expect(live.length).toBe(1);
    expect(live[0].type).toBe("text");
  });

  test("hovering the open badge shows pointer cursor and clicking badge or Cmd+Click triggers onOpenLink", () => {
    const opened = [];
    const ed = new Editor({ onOpenLink: url => opened.push(url) });
    ed.setSize(800, 600);
    ed.paste("https://linear.app/plenary/issue/ENG-77/click-to-open");
    const el = ed.doc.live()[0];
    const badge = linkCardOpenBadgeRect(el);
    const badgeWorld = { x: badge.x + badge.w / 2, y: badge.y + badge.h / 2 };
    const badgeScreen = ed.toScreen(badgeWorld);
    expect(isPointInLinkCardOpenAction(el, badgeWorld)).toBe(true);

    ed.pointerMove(badgeScreen);
    expect(ed.cursor()).toBe("pointer");

    // Click on badge opens link
    ed.pointerDown(badgeScreen, { button: "left" });
    expect(opened).toEqual(["https://linear.app/plenary/issue/ENG-77/click-to-open"]);

    // Cmd+Click on card center opens link
    const centerScreen = ed.toScreen({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
    ed.pointerDown(centerScreen, { button: "left", cmd: true });
    expect(opened.length).toBe(2);

    // Read-only viewer can also click the open badge
    ed.readOnly = true;
    ed.pointerDown(badgeScreen, { button: "left" });
    expect(opened.length).toBe(3);
  });
});

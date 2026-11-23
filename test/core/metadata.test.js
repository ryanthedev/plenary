// Shape metadata (owner, service, runbook URL, tier, tags) & Table builder (#6):
// normalization, strict https:-only URL validation, Protocol v1.1 table grid generation,
// and strictly-clipped metadata badge rendering + planBatches compatibility.
import { describe, test, expect } from "bun:test";
import {
  normalizeShapeMeta,
  validateRunbookUrl,
  metaOf,
  formatMetaBadgeText,
  buildTableElements,
  MAX_META_OWNER_LENGTH,
  MAX_META_SERVICE_LENGTH,
  MAX_META_TIER_LENGTH,
  MAX_META_TAG_LENGTH,
  MAX_META_TAGS,
  MAX_RUNBOOK_URL_LENGTH,
  MAX_TABLE_ROWS,
  MAX_TABLE_COLS,
} from "../../packages/core/metadata.js";
import { makeElement } from "../../packages/core/model.js";
import { Doc } from "../../packages/core/doc.js";
import { paintScene, planBatches } from "../../packages/core/render.js";
import { LIGHT, DARK } from "../../packages/core/export.js";
import { buildLinkCard } from "../../packages/core/link-card.js";
import { buildEmbedElement } from "../../packages/core/embed.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { Room } from "../../packages/protocol/room.js";
import { MemoryLog } from "../../packages/protocol/ports.js";

describe("validateRunbookUrl & normalizeShapeMeta", () => {
  test("normalizes, trims, and caps owner, service, tier, tags, and valid https runbookUrl", () => {
    const raw = {
      owner: "  " + "o".repeat(80) + "  ",
      service: "  payments\t\n  api  " + "s".repeat(70),
      tier: "  " + "t".repeat(50),
      runbookUrl: "  HTTPS://Runbooks.Example.COM:8443/ops/payments?env=prod#alerts  ",
      tags: [
        "  critical  ",
        "pci",
        "critical", // duplicate
        "",
        "   ",
        123,
        "a".repeat(45),
        "tag4",
        "tag5",
        "tag6",
        "tag7",
        "tag8",
        "tag9-overflow",
        "tag10-overflow",
      ],
    };

    const meta = normalizeShapeMeta(raw);
    expect(meta).not.toBeNull();
    expect(meta.owner.length).toBe(MAX_META_OWNER_LENGTH);
    expect(meta.service.length).toBeLessThanOrEqual(MAX_META_SERVICE_LENGTH);
    expect(meta.service.startsWith("payments api ")).toBe(true);
    expect(meta.tier.length).toBe(MAX_META_TIER_LENGTH);
    expect(meta.runbookUrl).toBe("https://runbooks.example.com:8443/ops/payments?env=prod#alerts");
    expect(meta.tags.length).toBe(MAX_META_TAGS);
    expect(meta.tags[0]).toBe("critical");
    expect(meta.tags[1]).toBe("pci");
    expect(meta.tags[2].length).toBe(MAX_META_TAG_LENGTH);
    expect(meta.tags).not.toContain("tag9-overflow");
  });

  test("rejects every unsafe or malformed runbookUrl (strict https:-only)", () => {
    const badUrls = [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://runbooks.example.com/ops",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "//runbooks.example.com/ops",
      'https://runbooks.example.com/ops"onclick=alert(1)',
      "https://runbooks.example.com/ops<script>",
      "https://runbooks.example.com/ops>bad",
      "https://user:pass@runbooks.example.com/ops",
      "https://token@runbooks.example.com/ops",
      "https://runbooks.example.com\\ops",
      "https://runbooks.example.com/ops extra",
      "https://runbooks.example.com/ops\nnext",
      "\nhttps://runbooks.example.com/ops",
      "\thttps://runbooks.example.com/ops",
      "https://runbooks.example.com/ops\r",
      "\u0085https://runbooks.example.com/ops",
      "https://runbooks.example.com/ops%0d%0aSet-Cookie:a=b",
      "https://runbooks.example.com:0/ops",
      "https://runbooks.example.com:70000/ops",
      "https://runbooks.example.com:abc/ops",
      "https://localhost/ops",
      "https://bad..host.example.com/ops",
      `https://runbooks.example.com/${"a".repeat(MAX_RUNBOOK_URL_LENGTH)}`,
    ];

    for (const u of badUrls) {
      expect(validateRunbookUrl(u)).toBeNull();
      expect(normalizeShapeMeta({ runbookUrl: u })).toBeNull();
      expect(normalizeShapeMeta({ service: "payments", owner: "sre", runbookUrl: u })).toBeNull();
    }
    expect(normalizeShapeMeta({ service: "payments", runbookUrl: 12345 })).toBeNull();
  });

  test("returns null for empty, non-object, or all-blank metadata", () => {
    for (const empty of [null, undefined, "", 42, [], {}, { owner: "   " }, { tags: ["", "  "] }, { runbookUrl: "   " }]) {
      expect(normalizeShapeMeta(empty)).toBeNull();
    }
    // Blank runbookUrl with other valid fields is treated as unset
    expect(normalizeShapeMeta({ service: "auth", runbookUrl: "   " })).toEqual({ service: "auth" });
    // Control-char-only runbookUrl is rejected
    expect(normalizeShapeMeta({ service: "auth", runbookUrl: "\n\t" })).toBeNull();
  });

  test("metaOf reads normalized metadata from element customData and returns null when empty", () => {
    const plain = makeElement("rectangle", { width: 160, height: 80 });
    expect(metaOf(plain)).toBeNull();
    expect(metaOf(null)).toBeNull();

    const withMeta = makeElement("rectangle", {
      width: 160,
      height: 80,
      customData: {
        meta: {
          service: "  checkout ",
          owner: " @payments-sre ",
          runbookUrl: "https://wiki.acme.com/runbooks/checkout",
          tier: "tier-0",
          tags: ["prod", "payments"],
        },
      },
    });
    expect(metaOf(withMeta)).toEqual({
      service: "checkout",
      owner: "@payments-sre",
      runbookUrl: "https://wiki.acme.com/runbooks/checkout",
      tier: "tier-0",
      tags: ["prod", "payments"],
    });
    expect(formatMetaBadgeText(metaOf(withMeta))).toBe("checkout · @payments-sre ↗");
  });
});

describe("buildTableElements", () => {
  test("generates a grouped 3x3 rectangle + bound text grid by default with styled header row", () => {
    const els = buildTableElements();
    expect(els.length).toBe(3 * 3 * 2);

    const rects = els.filter(e => e.type === "rectangle");
    const texts = els.filter(e => e.type === "text");
    expect(rects.length).toBe(9);
    expect(texts.length).toBe(9);

    // Every element shares one groupId
    const groupId = rects[0].groupIds[0];
    expect(typeof groupId).toBe("string");
    expect(groupId.length).toBeGreaterThan(0);
    for (const el of els) {
      expect(el.groupIds).toEqual([groupId]);
    }

    // Every rectangle binds to its text label and vice versa
    const byId = new Map(els.map(e => [e.id, e]));
    for (const rect of rects) {
      expect(Array.isArray(rect.boundElements)).toBe(true);
      expect(rect.boundElements.length).toBe(1);
      const label = byId.get(rect.boundElements[0].id);
      expect(label).toBeDefined();
      expect(label.containerId).toBe(rect.id);
      expect(label.customData.z).toBeGreaterThan(rect.customData.z);
    }

    // Header row styling differs from data rows
    const headerRects = rects.filter(r => r.customData.table.header);
    const bodyRects = rects.filter(r => !r.customData.table.header);
    expect(headerRects.length).toBe(3);
    expect(bodyRects.length).toBe(6);
    expect(headerRects[0].backgroundColor).not.toBe(bodyRects[0].backgroundColor);
    expect(byId.get(headerRects[0].boundElements[0].id).text).toBe("Col 1");
  });

  test("populates custom headers, cells, position, layer, and z", () => {
    const els = buildTableElements({
      rows: 3,
      cols: 2,
      x: 100,
      y: 200,
      cellWidth: 160,
      cellHeight: 50,
      headers: ["Service", "Owner"],
      cells: [
        ["auth-api", "@identity"],
        ["billing", "@finops"],
      ],
      layer: "arch",
      z: 10,
    });
    const rects = els.filter(e => e.type === "rectangle");
    const texts = els.filter(e => e.type === "text");
    expect(rects[0].x).toBe(100);
    expect(rects[0].y).toBe(200);
    expect(rects[0].width).toBe(160);
    expect(rects[0].height).toBe(50);
    expect(rects[0].customData.layer).toBe("arch");
    expect(rects[0].customData.z).toBe(10);
    expect(rects[3].x).toBe(260);
    expect(rects[3].y).toBe(250);
    expect(texts.map(t => t.text)).toEqual(["Service", "Owner", "auth-api", "@identity", "billing", "@finops"]);
  });

  test("clamps rows to 1..20 and cols to 1..12 and passes Protocol v1.1 opProblem & Room sync", () => {
    const minTable = buildTableElements({ rows: 0, cols: -5 });
    expect(minTable.length).toBe(1 * 1 * 2);

    const maxTable = buildTableElements({ rows: 99, cols: 50 });
    expect(maxTable.length).toBe(MAX_TABLE_ROWS * MAX_TABLE_COLS * 2);

    const msg = {
      t: "op",
      stream: "board",
      id: "c1:1",
      sentAt: 0,
      op: { elements: maxTable },
    };
    expect(opProblem(msg)).toBeNull();

    const log = new MemoryLog();
    const room = new Room({ board: "b1", tenant: "t1", log });
    const conn = { id: "conn1", user: "ada", role: "owner", client: "c1", send() {} };
    room.hello(conn, { t: "hello", v: 1, board: "b1", since: 0, client: "c1", user: "ada", role: "owner" });
    room.op(conn, msg);
    expect(room.streams.board.live().length).toBe(MAX_TABLE_ROWS * MAX_TABLE_COLS * 2);
  });
});

describe("render.js metadata badge & table rendering", () => {
  const styleKey = it => `${it.fill ?? ""}|${it.stroke ?? ""}|${it.width ?? 0}|${it.dash?.join(",") ?? ""}|${it.opacity ?? 1}`;

  test("renders subtle metadata pill on shapes with customData.meta and leaves normal/card/embed shapes clean", () => {
    const normal = makeElement("rectangle", { x: 0, y: 0, width: 180, height: 90, backgroundColor: "#ffffff" });
    const metaRect = makeElement("rectangle", {
      x: 220,
      y: 0,
      width: 200,
      height: 100,
      backgroundColor: "#e7f5ff",
      customData: {
        meta: {
          service: "payments",
          owner: "@sre",
          runbookUrl: "https://runbooks.example.com/payments",
        },
      },
    });
    const metaDiamond = makeElement("diamond", {
      x: 460,
      y: 0,
      width: 180,
      height: 120,
      angle: 0.2,
      customData: { meta: { service: "router", owner: "netops" } },
    });
    const linkCard = buildLinkCard("https://github.com/acme/plenary/pull/6", { x: 0, y: 160 });
    linkCard.customData.meta = { service: "ignored-on-card", owner: "nope" };
    const embedCard = buildEmbedElement("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { x: 400, y: 160 });
    embedCard.customData.meta = { service: "ignored-on-embed", owner: "nope" };

    const doc = new Doc({ elements: [normal, metaRect, metaDiamond, linkCard, embedCard] });
    for (const theme of [LIGHT, DARK]) {
      const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, theme);

      // Normal shape has no meta badge items
      expect(items.some(it => it.id?.startsWith(normal.id + ":meta"))).toBe(false);

      // Link card and embed card do not get shape meta badges
      expect(items.some(it => it.id?.startsWith(linkCard.id + ":meta"))).toBe(false);
      expect(items.some(it => it.id?.startsWith(embedCard.id + ":meta"))).toBe(false);

      // Meta shapes emit pill bg, border, and text
      const rectText = items.find(it => it.id === metaRect.id + ":meta:text");
      expect(rectText).toBeDefined();
      expect(rectText.text).toBe("payments · @sre ↗");

      const diamondText = items.find(it => it.id === metaDiamond.id + ":meta:text");
      expect(diamondText).toBeDefined();
      expect(diamondText.text).toBe("router · netops");
      expect(diamondText.angle).toBeCloseTo(0.2, 5);

      // Compatible with planBatches
      const batched = planBatches(items, styleKey);
      expect(batched.layers.length).toBeGreaterThan(0);
      expect(batched.texts.some(t => t.id === metaRect.id + ":meta:text")).toBe(true);
    }
  });

  test("metadata badge stays strictly inside shape bounds and skips tiny shapes", () => {
    const small = makeElement("rectangle", {
      x: 50,
      y: 60,
      width: 60,
      height: 36,
      customData: {
        meta: {
          service: "very-long-service-name-that-must-truncate",
          owner: "@very-long-owner-team",
          runbookUrl: "https://runbooks.example.com/long",
        },
      },
    });
    const tiny = makeElement("rectangle", {
      x: 200,
      y: 200,
      width: 20,
      height: 16,
      customData: { meta: { service: "svc", owner: "own" } },
    });

    const doc = new Doc({ elements: [small, tiny] });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT, { allText: true });

    // Tiny shape omits badge completely
    expect(items.some(it => it.id?.startsWith(tiny.id + ":meta"))).toBe(false);

    // Small shape's badge primitives stay strictly within [50..110] x [60..96]
    const metaItems = items.filter(it => it.id?.startsWith(small.id + ":meta"));
    expect(metaItems.length).toBe(3);
    for (const it of metaItems) {
      if (it.t === "path") {
        for (const c of it.cmds) {
          for (let i = 1; i + 1 < c.length; i += 2) {
            expect(c[i]).toBeGreaterThanOrEqual(50 - 1e-6);
            expect(c[i]).toBeLessThanOrEqual(110 + 1e-6);
            expect(c[i + 1]).toBeGreaterThanOrEqual(60 - 1e-6);
            expect(c[i + 1]).toBeLessThanOrEqual(96 + 1e-6);
          }
        }
      } else if (it.t === "text") {
        expect(it.x).toBeGreaterThanOrEqual(50 - 1e-6);
        expect(it.x + it.box.w).toBeLessThanOrEqual(110 + 1e-6);
        expect(it.y).toBeGreaterThanOrEqual(60 - 1e-6);
        expect(it.y + it.box.h).toBeLessThanOrEqual(96 + 1e-6);
        expect(it.text.endsWith("↗")).toBe(true);
      }
    }
  });

  test("table elements render cleanly through paintScene and planBatches", () => {
    const els = buildTableElements({
      rows: 2,
      cols: 2,
      headers: ["Component", "Owner"],
      cells: [["Gateway", "Platform"]],
    });
    const doc = new Doc({ elements: els });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    const batched = planBatches(items, styleKey);
    expect(batched.layers.length).toBeGreaterThan(0);
    expect(batched.texts.map(t => t.text)).toEqual(expect.arrayContaining(["Component", "Owner", "Gateway", "Platform"]));
  });

  test("metadata badges stay strictly inside ellipse and diamond silhouettes and render on frames", () => {
    const ellipse = makeElement("ellipse", {
      x: 0,
      y: 0,
      width: 220,
      height: 120,
      customData: { meta: { service: "edge-proxy-service", owner: "@infra-team", runbookUrl: "https://runbooks.example.com/edge" } },
    });
    const diamond = makeElement("diamond", {
      x: 300,
      y: 0,
      width: 220,
      height: 140,
      customData: { meta: { service: "decision-router-long-name", owner: "@core-sre", runbookUrl: "https://runbooks.example.com/router" } },
    });
    const frame = makeElement("frame", {
      x: 600,
      y: 0,
      width: 300,
      height: 200,
      name: "Checkout",
      customData: { meta: { service: "checkout-domain", owner: "@payments" } },
    });

    const doc = new Doc({ elements: [ellipse, diamond, frame] });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT, { allText: true });

    // Every ellipse badge path point satisfies ((x - cx)/rx)^2 + ((y - cy)/ry)^2 <= 1
    const ellipsePaths = items.filter(it => it.t === "path" && it.id?.startsWith(ellipse.id + ":meta"));
    expect(ellipsePaths.length).toBe(2);
    for (const it of ellipsePaths) {
      for (const c of it.cmds) {
        for (let i = 1; i + 1 < c.length; i += 2) {
          const nx = (c[i] - 110) / 110;
          const ny = (c[i + 1] - 60) / 60;
          expect(nx * nx + ny * ny).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }

    // Every diamond badge path point satisfies |x - cx|/rx + |y - cy|/ry <= 1
    const diamondPaths = items.filter(it => it.t === "path" && it.id?.startsWith(diamond.id + ":meta"));
    expect(diamondPaths.length).toBe(2);
    for (const it of diamondPaths) {
      for (const c of it.cmds) {
        for (let i = 1; i + 1 < c.length; i += 2) {
          const nx = Math.abs(c[i] - 410) / 110;
          const ny = Math.abs(c[i + 1] - 70) / 70;
          expect(nx + ny).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }

    // Frame with metadata renders its badge pill
    const frameText = items.find(it => it.id === frame.id + ":meta:text");
    expect(frameText).toBeDefined();
    expect(frameText.text).toBe("checkout-domain · @payments");
  });
});

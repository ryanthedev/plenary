// @ts-check
// Tests for Issue #4: Diagram-as-Code (Mermaid extended, D2, PlantUML, two-way code-sync).

import { describe, test, expect } from "bun:test";
import {
  detectDiagramLang,
  importDiagramCode,
  reconcileDiagramCode,
  MAX_DIAGRAM_SOURCE_BYTES,
} from "../../packages/core/diagram-code.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";

function assertValidProtocol(elements) {
  expect(Array.isArray(elements)).toBe(true);
  if (elements.length === 0) return;
  const problem = opProblem({
    t: "op",
    stream: "board",
    id: "c1:1",
    sentAt: 0,
    op: { elements },
  });
  expect(problem).toBeNull();
}

describe("packages/core/diagram-code.js — language detection", () => {
  test("detects mermaid, d2, and plantuml", () => {
    expect(detectDiagramLang("flowchart LR\n  A --> B")).toBe("mermaid");
    expect(detectDiagramLang("sequenceDiagram\n  Alice->>Bob: Hi")).toBe("mermaid");
    expect(detectDiagramLang("erDiagram\n  USER ||--o{ ORDER : places")).toBe("mermaid");
    expect(detectDiagramLang("classDiagram\n  Animal <|-- Dog")).toBe("mermaid");
    expect(detectDiagramLang("stateDiagram-v2\n  [*] --> Idle")).toBe("mermaid");
    expect(detectDiagramLang("a -> b: hello")).toBe("d2");
    expect(detectDiagramLang("direction: right\napi -> db")).toBe("d2");
    expect(detectDiagramLang("@startuml\nAlice -> Bob: Hi\n@enduml")).toBe("plantuml");
    expect(detectDiagramLang("")).toBeNull();
    expect(detectDiagramLang(null)).toBeNull();
  });
});

describe("packages/core/diagram-code.js — Mermaid diagrams", () => {
  test("delegates flowchart to existing mermaid importer and stamps diagramCode metadata", () => {
    const src = `flowchart LR
      subgraph Backend
        A[API] -->|auth| B{Valid?}
      end
      B -->|yes| C((DB))`;
    const res = importDiagramCode(src, { lang: "mermaid", origin: { x: 100, y: 50 }, blockId: "blk-flow" });
    expect(res.ok).toBe(true);
    expect(res.lang).toBe("mermaid");
    expect(res.diagramType).toBe("mermaid:flowchart");
    expect(res.blockId).toBe("blk-flow");
    assertValidProtocol(res.elements);

    const root = res.elements[0];
    expect(root.type).toBe("frame");
    expect(root.customData.diagramCode).toEqual({
      lang: "mermaid",
      source: src.trim(),
      blockId: "blk-flow",
      version: 1,
    });
    for (const el of res.elements) {
      expect(el.customData.diagramBlockId).toBe("blk-flow");
    }
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(1);
    expect(res.elements.filter(e => e.type === "diamond").length).toBe(1);
    expect(res.elements.filter(e => e.type === "ellipse").length).toBe(1);
    expect(res.elements.filter(e => e.type === "arrow").length).toBe(2);
  });

  test("imports Mermaid sequenceDiagram with participants, actors, lifelines, messages, notes, and blocks", () => {
    const src = `sequenceDiagram
      actor U as User
      participant A as API
      participant DB as Database
      U->>A: POST /login
      alt valid creds
        A->>DB: SELECT user
        DB-->>A: row
        Note right of A: issue JWT
        A->>A: sign token
      end
      A-->>U: 200 OK`;
    const res = importDiagramCode(src, { blockId: "blk-seq" });
    expect(res.ok).toBe(true);
    expect(res.diagramType).toBe("mermaid:sequence");
    assertValidProtocol(res.elements);

    // 1 actor (ellipse) + 2 participants (rect) + 1 note (rect)
    expect(res.elements.filter(e => e.type === "ellipse").length).toBe(1);
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(3);
    // 3 vertical dashed lifelines
    const lifelines = res.elements.filter(e => e.type === "line" && e.strokeStyle === "dashed");
    expect(lifelines.length).toBe(3);
    // 5 message arrows (including self-message with 4 points)
    const arrows = res.elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(5);
    expect(arrows.some(a => a.points.length === 4)).toBe(true);
    expect(arrows.some(a => a.strokeStyle === "dashed")).toBe(true);
    // Root frame + `alt` block frame
    const frames = res.elements.filter(e => e.type === "frame");
    expect(frames.length).toBe(2);
    expect(frames.some(f => f.name?.includes("alt: valid creds"))).toBe(true);
  });

  test("imports Mermaid erDiagram with attributes and crowfoot arrowheads", () => {
    const src = `erDiagram
      CUSTOMER {
        int id PK
        string email
      }
      ORDER {
        int id PK
        int customer_id FK
      }
      CUSTOMER ||--o{ ORDER : places
      ORDER }|..|| LINE_ITEM : contains`;
    const res = importDiagramCode(src, { blockId: "blk-er" });
    expect(res.ok).toBe(true);
    expect(res.diagramType).toBe("mermaid:er");
    assertValidProtocol(res.elements);

    const rects = res.elements.filter(e => e.type === "rectangle");
    expect(rects.length).toBe(3);
    const texts = res.elements.filter(e => e.type === "text").map(t => t.text);
    expect(texts.some(t => t.includes("CUSTOMER") && t.includes("email"))).toBe(true);
    expect(texts.some(t => t === "places")).toBe(true);

    const arrows = res.elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);
    expect(arrows[0].startArrowhead).toBe("crowfoot_one");
    expect(arrows[0].endArrowhead).toBe("crowfoot_many");
    expect(arrows[1].strokeStyle).toBe("dashed");
    expect(arrows[1].startArrowhead).toBe("crowfoot_one_or_many");
    expect(arrows[1].endArrowhead).toBe("crowfoot_one");
  });

  test("imports Mermaid classDiagram with members, namespaces, and UML relationships", () => {
    const src = `classDiagram
      namespace Core {
        class Animal {
          +String name
          +eat()
        }
        class Dog {
          +bark()
        }
      }
      Animal <|-- Dog : extends
      Dog ..> Toy : playsWith`;
    const res = importDiagramCode(src, { blockId: "blk-cls" });
    expect(res.ok).toBe(true);
    expect(res.diagramType).toBe("mermaid:class");
    assertValidProtocol(res.elements);

    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(3);
    const frames = res.elements.filter(e => e.type === "frame");
    expect(frames.length).toBe(2); // root + Core namespace
    expect(frames.some(f => f.name === "Core")).toBe(true);

    const arrows = res.elements.filter(e => e.type === "arrow");
    expect(arrows.length).toBe(2);
    expect(arrows.some(a => a.startArrowhead === "triangle")).toBe(true);
    expect(arrows.some(a => a.strokeStyle === "dashed" && a.endArrowhead === "arrow")).toBe(true);
  });

  test("imports Mermaid stateDiagram-v2 with start/end pseudo-states and composite state frames", () => {
    const src = `stateDiagram-v2
      [*] --> Idle
      state Active {
        Running --> Paused : pause
        Paused --> Running : resume
      }
      Idle --> Running : start
      Running --> [*] : stop`;
    const res = importDiagramCode(src, { blockId: "blk-state" });
    expect(res.ok).toBe(true);
    expect(res.diagramType).toBe("mermaid:state");
    assertValidProtocol(res.elements);

    // [*] start and [*] end are ellipses
    expect(res.elements.filter(e => e.type === "ellipse").length).toBe(2);
    // Idle, Running, Paused
    expect(res.elements.filter(e => e.type === "rectangle").length).toBe(3);
    // Root frame + Active composite frame
    const frames = res.elements.filter(e => e.type === "frame");
    expect(frames.length).toBe(2);
    expect(frames.some(f => f.name === "Active")).toBe(true);
    expect(res.elements.filter(e => e.type === "arrow").length).toBe(5);
  });
});

describe("packages/core/diagram-code.js — D2 & PlantUML", () => {
  test("imports D2 with containers, shapes, styles, and edge chains", () => {
    const src = `direction: right
      # System overview
      client: Web Client
      client.shape: oval
      client.style.fill: #e7f5ff
      client.style.stroke: #1971c2

      cloud: Production {
        api: API Gateway
        db: Postgres
        db.shape: cylinder
        api -> db: SQL
      }

      client -> cloud.api: HTTPS`;
    const res = importDiagramCode(src, { lang: "d2", blockId: "blk-d2" });
    expect(res.ok).toBe(true);
    expect(res.lang).toBe("d2");
    assertValidProtocol(res.elements);

    const ellipses = res.elements.filter(e => e.type === "ellipse");
    expect(ellipses.length).toBe(2); // client (oval) + db (cylinder)
    const clientEl = ellipses.find(e => e.backgroundColor === "#e7f5ff");
    expect(clientEl).toBeTruthy();
    expect(clientEl.strokeColor).toBe("#1971c2");

    const frames = res.elements.filter(e => e.type === "frame");
    expect(frames.length).toBe(2); // root + Production container
    expect(frames.some(f => f.name === "Production")).toBe(true);
    expect(res.elements.filter(e => e.type === "arrow").length).toBe(2);
  });

  test("imports PlantUML sequence, class/component, and state diagrams", () => {
    const seq = `@startuml
      actor Alice
      participant Bob
      Alice -> Bob: Hello
      Bob --> Alice: Hi back
      @enduml`;
    const rSeq = importDiagramCode(seq, { lang: "plantuml", blockId: "puml-seq" });
    expect(rSeq.ok).toBe(true);
    expect(rSeq.diagramType).toBe("plantuml:sequence");
    assertValidProtocol(rSeq.elements);
    expect(rSeq.elements.filter(e => e.type === "arrow").length).toBe(2);

    const cls = `@startuml
      package "Services" {
        interface AuthPort {
          +verify(token)
        }
        class OidcAuth {
          +verify(token)
        }
      }
      database "Users DB" as DB
      AuthPort <|.. OidcAuth
      OidcAuth --> DB : queries
      @enduml`;
    const rCls = importDiagramCode(cls, { lang: "plantuml", blockId: "puml-cls" });
    expect(rCls.ok).toBe(true);
    expect(rCls.diagramType).toBe("plantuml:class-component");
    assertValidProtocol(rCls.elements);
    expect(rCls.elements.filter(e => e.type === "frame").length).toBe(2);
    expect(rCls.elements.filter(e => e.type === "ellipse").length).toBe(1); // database
    expect(rCls.elements.filter(e => e.type === "arrow").length).toBe(2);

    const st = `@startuml
      [*] --> Draft
      Draft --> Published : publish
      Published --> [*]
      @enduml`;
    const rSt = importDiagramCode(st, { lang: "plantuml", blockId: "puml-st" });
    expect(rSt.ok).toBe(true);
    expect(rSt.diagramType).toBe("plantuml:state");
    assertValidProtocol(rSt.elements);
    expect(rSt.elements.filter(e => e.type === "ellipse").length).toBe(2);
  });
});

describe("packages/core/diagram-code.js — two-way code-sync reconciliation", () => {
  test("reconcileDiagramCode replaces only target block, preserves unrelated elements and user layout offsets", () => {
    const unrelatedNote = makeElement("rectangle", {
      id: "user-sticky-1",
      x: 900, y: 800, width: 150, height: 100,
      version: 3,
      customData: { layer: "base", z: 1 },
    });

    const v1 = importDiagramCode(`a: Service A\nb: Service B\na -> b: calls`, {
      lang: "d2",
      origin: { x: 50, y: 50 },
      blockId: "sync-1",
    });
    expect(v1.ok).toBe(true);

    // Simulate user dragging node `a` by (+140, +75) on the canvas.
    const nodeA = v1.elements.find(e => e.customData?.diagramKey === "node:a");
    expect(nodeA).toBeTruthy();
    const prevNodeAId = nodeA.id;
    nodeA.x += 140;
    nodeA.y += 75;
    const expectedLayoutA = v1.elements.find(e => e.id === prevNodeAId).customData.diagramLayout;

    const sceneBefore = [unrelatedNote, ...v1.elements];

    // Update code: keep `a` and `b`, add `c`, add edge `b -> c`.
    const v2 = reconcileDiagramCode(sceneBefore, `a: Service A v2\nb: Service B\nc: Cache\na -> b: calls\nb -> c: reads`, {
      blockId: "sync-1",
    });
    expect(v2.ok).toBe(true);
    expect(v2.version).toBe(2);
    assertValidProtocol(v2.elements);

    // Unrelated element is untouched.
    const keptUnrelated = v2.elements.find(e => e.id === "user-sticky-1");
    expect(keptUnrelated).toBeTruthy();
    expect(keptUnrelated.x).toBe(900);
    expect(keptUnrelated.y).toBe(800);

    // Root frame updated with version 2 and new source.
    const rootFrame = v2.elements.find(e => e.type === "frame" && e.customData?.diagramCode?.blockId === "sync-1");
    expect(rootFrame).toBeTruthy();
    expect(rootFrame.customData.diagramCode.version).toBe(2);
    expect(rootFrame.customData.diagramCode.source).toContain("Cache");

    // Node `a` preserved its ID, bumped its version, and kept the (+140, +75) user offset!
    const nextNodeA = v2.elements.find(e => e.customData?.diagramKey === "node:a");
    expect(nextNodeA).toBeTruthy();
    expect(nextNodeA.id).toBe(prevNodeAId);
    expect(nextNodeA.version).toBe(1);
    const nextLayoutA = nextNodeA.customData.diagramLayout;
    expect(Math.round(nextNodeA.x - nextLayoutA.x)).toBe(140);
    expect(Math.round(nextNodeA.y - nextLayoutA.y)).toBe(75);
    expect(expectedLayoutA).toBeTruthy();

    // New node `c` was added.
    const nodeC = v2.elements.find(e => e.customData?.diagramKey === "node:c");
    expect(nodeC).toBeTruthy();
    expect(v2.addedIds.length).toBeGreaterThan(0);
    expect(v2.updatedIds).toContain(prevNodeAId);
  });
});

describe("packages/core/diagram-code.js — malformed & hostile input safety", () => {
  test("never throws on empty, non-string, oversize, or invalid syntax", () => {
    expect(importDiagramCode(null).ok).toBe(false);
    expect(importDiagramCode(123).ok).toBe(false);
    expect(importDiagramCode("   ").ok).toBe(false);
    expect(importDiagramCode("not a diagram at all!!!").ok).toBe(false);
    const huge = "a -> b\n".repeat(Math.ceil(MAX_DIAGRAM_SOURCE_BYTES / 6) + 10);
    const resHuge = importDiagramCode(huge, { lang: "d2" });
    expect(resHuge.ok).toBe(false);
    expect(resHuge.error).toMatch(/maximum size/i);
  });
});

// Issue #112: Pure YouTube & direct media URL embeds — parser, security rejections,
// Protocol v1.1 validation, explicit customData.embed detection, and poster card rendering.
import { describe, test, expect } from "bun:test";
import {
  parseEmbedUrl,
  parseYouTubeTime,
  safeEmbedUrl,
  buildEmbedElement,
  parseEmbedFromElement,
  isEmbedElement,
  embedPlayButtonRect,
  MAX_EMBED_URL_LENGTH,
  YOUTUBE_EMBED_ORIGIN,
} from "../../packages/core/embed.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { Doc } from "../../packages/core/doc.js";
import { paintScene } from "../../packages/core/render.js";
import { LIGHT, DARK } from "../../packages/core/export.js";
import { makeElement } from "../../packages/core/model.js";

describe("parseEmbedUrl — YouTube", () => {
  test("parses watch, youtu.be, shorts, and nocookie embed URLs with optional start time", () => {
    const watch = parseEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(watch).toMatchObject({
      provider: "youtube",
      providerName: "YouTube",
      videoId: "dQw4w9WgXcQ",
      embedUrl: `${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0`,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      host: "youtube.com",
    });
    expect(watch.startSec).toBeUndefined();

    const shortLink = parseEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=1m30s");
    expect(shortLink).toMatchObject({
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      startSec: 90,
      embedUrl: `${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0&start=90`,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90",
    });

    const shorts = parseEmbedUrl("https://youtube.com/shorts/AbCdEf0123_?t=45");
    expect(shorts).toMatchObject({
      provider: "youtube",
      videoId: "AbCdEf0123_",
      startSec: 45,
      embedUrl: `${YOUTUBE_EMBED_ORIGIN}/embed/AbCdEf0123_?rel=0&start=45`,
    });

    const mobile = parseEmbedUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s");
    expect(mobile?.startSec).toBe(3723);
    expect(mobile?.embedUrl).toBe(`${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0&start=3723`);

    const nocookie = parseEmbedUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=12");
    expect(nocookie?.videoId).toBe("dQw4w9WgXcQ");
    expect(nocookie?.startSec).toBe(12);
  });

  test("parseYouTubeTime handles seconds, composite h/m/s, and rejects invalid/zero", () => {
    expect(parseYouTubeTime("90")).toBe(90);
    expect(parseYouTubeTime("90s")).toBe(90);
    expect(parseYouTubeTime("1m30s")).toBe(90);
    expect(parseYouTubeTime("1h2m30s")).toBe(3750);
    expect(parseYouTubeTime("0")).toBeUndefined();
    expect(parseYouTubeTime("-5")).toBeUndefined();
    expect(parseYouTubeTime("abc")).toBeUndefined();
    expect(parseYouTubeTime("")).toBeUndefined();
  });
});

describe("parseEmbedUrl — Direct Video & Image URLs", () => {
  test("parses direct .mp4, .webm, .mov video URLs", () => {
    for (const ext of ["mp4", "webm", "mov", "MP4"]) {
      const res = parseEmbedUrl(`https://cdn.example.com/clips/demo_clip.${ext}?token=abc`);
      expect(res).toMatchObject({
        provider: "video",
        providerName: "Video",
        host: "cdn.example.com",
        url: `https://cdn.example.com/clips/demo_clip.${ext}?token=abc`,
        embedUrl: `https://cdn.example.com/clips/demo_clip.${ext}?token=abc`,
      });
    }
  });

  test("parses direct .png, .jpg, .jpeg, .webp, .gif image URLs", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif", "WEBP"]) {
      const res = parseEmbedUrl(`https://assets.example.org/diagrams/arch.${ext}`);
      expect(res).toMatchObject({
        provider: "image",
        providerName: "Image",
        host: "assets.example.org",
        url: `https://assets.example.org/diagrams/arch.${ext}`,
        embedUrl: `https://assets.example.org/diagrams/arch.${ext}`,
      });
    }
  });
});

describe("parseEmbedUrl — Strict Security Rejections", () => {
  test("rejects non-https, unsafe chars, userinfo, ports, IPv4, bad YouTube IDs, and unsupported URLs", () => {
    const bad = [
      "",
      "   ",
      null,
      123,
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "http://cdn.example.com/video.mp4",
      "javascript:alert(1)//.mp4",
      "data:video/mp4;base64,AAAA",
      "blob:https://example.com/video.mp4",
      "file:///etc/passwd.png",
      'https://cdn.example.com/a"b.mp4',
      "https://cdn.example.com/a<script>.png",
      "https://cdn.example.com/a>b.png",
      "https://cdn.example.com/a'b.png",
      "https://cdn.example.com/a`b.png",
      "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://user@cdn.example.com/a.mp4",
      "https://www.youtube.com:443/watch?v=dQw4w9WgXcQ",
      "https://cdn.example.com:8443/a.mp4",
      "https://127.0.0.1/a.mp4",
      "https://127.1/a.mp4",
      "https://0x7f.0.0.1/a.mp4",
      "https://0177.0.0.1/a.mp4",
      "https://10.1/a.png",
      "https://localhost/a.mp4",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=waytoolongvideoid123",
      "https://www.youtube.com/watch?v=bad!char@id",
      "https://youtu.be/dQw4w9WgXcQ/extra",
      "https://example.com/page.html",
      "https://example.com/.mp4",
      "https://cdn.example.com/a.svg",
      "https://cdn.example.com/a%00.png",
      "https://cdn.example.com/a\\" + "b.png",
      "https://cdn.example.com/" + "a".repeat(MAX_EMBED_URL_LENGTH) + ".png",
    ];
    for (const u of bad) {
      expect([u, parseEmbedUrl(/** @type {any} */ (u))]).toEqual([u, null]);
    }
    expect(safeEmbedUrl("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(safeEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("buildEmbedElement, Protocol v1.1 validation, and parseEmbedFromElement", () => {
  test("creates a Protocol v1.1-valid rectangle element with link and customData.embed", () => {
    const el = buildEmbedElement("https://youtu.be/dQw4w9WgXcQ?t=1m30s", {
      x: 100,
      y: 200,
      title: "Architecture Walkthrough",
      z: 5,
    });
    expect(el).not.toBeNull();
    expect(el.type).toBe("rectangle");
    expect(el.link).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90");
    expect(el.customData.embed).toMatchObject({
      provider: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90",
      embedUrl: `${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0&start=90`,
      videoId: "dQw4w9WgXcQ",
      title: "Architecture Walkthrough",
      startSec: 90,
    });
    expect(el.customData.z).toBe(5);

    // Protocol v1.1 op validation
    expect(opProblem({ t: "op", stream: "board", id: "c1:1", sentAt: 0, op: { elements: [el] } })).toBeNull();
  });

  test("parseEmbedFromElement only activates when customData.embed is explicitly present and always re-validates", () => {
    // Plain rectangle with a YouTube link but NO customData.embed must NOT be hijacked
    const plain = makeElement("rectangle", { link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", width: 300, height: 200 });
    expect(parseEmbedFromElement(plain)).toBeNull();
    expect(isEmbedElement(plain)).toBe(false);

    // Explicit embed element parses cleanly
    const embedEl = buildEmbedElement("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(isEmbedElement(embedEl)).toBe(true);
    expect(parseEmbedFromElement(embedEl)?.embedUrl).toBe(`${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0`);

    // Tampered customData.embed.embedUrl or provider cannot override re-parsed canonical values
    const tampered = {
      ...embedEl,
      customData: {
        ...embedEl.customData,
        embed: {
          provider: "video",
          url: "javascript:alert(1)",
          embedUrl: "https://evil.example/phish",
          title: "<script>alert(1)</script>Demo",
        },
      },
    };
    const parsed = parseEmbedFromElement(tampered);
    expect(parsed?.provider).toBe("youtube");
    expect(parsed?.embedUrl).toBe(`${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0`);
    expect(parsed?.title).not.toContain("<script>");
    expect(parsed?.title).toContain("Demo");

    // Tampered link to unsafe scheme rejects completely
    const badLink = { ...embedEl, link: "javascript:alert(1)" };
    expect(parseEmbedFromElement(badLink)).toBeNull();
  });
});

describe("paintScene — Embed Media Poster Card Rendering", () => {
  test("renders dark cinema surface, provider badge, play-triangle medallion, and title/host footer", () => {
    const yt = buildEmbedElement("https://youtu.be/dQw4w9WgXcQ?t=90", { x: 40, y: 60, title: "System Design" });
    const vid = buildEmbedElement("https://cdn.example.com/clip.mp4", { x: 600, y: 60 });
    const img = buildEmbedElement("https://cdn.example.com/diagram.png", { x: 40, y: 400 });
    const doc = new Doc({ elements: [yt, vid, img] });

    for (const theme of [LIGHT, DARK]) {
      const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, theme, { allText: true });
      // YouTube card items
      expect(items.some(it => it.id === yt.id + ":medallion")).toBe(true);
      expect(items.some(it => it.id === yt.id + ":play")).toBe(true);
      expect(items.some(it => it.id === yt.id + ":provider" && it.text === "YouTube")).toBe(true);
      expect(items.some(it => it.id === yt.id + ":title" && it.text === "System Design")).toBe(true);
      expect(items.some(it => it.id === yt.id + ":host" && it.text === "youtube.com · 1:30")).toBe(true);

      // Video & Image provider badges
      expect(items.some(it => it.id === vid.id + ":provider" && it.text === "Video")).toBe(true);
      expect(items.some(it => it.id === img.id + ":provider" && it.text === "Image")).toBe(true);
    }

    expect(embedPlayButtonRect(yt)).not.toBeNull();
    expect(embedPlayButtonRect({ x: 0, y: 0, width: 20, height: 20 })).toBeNull();
  });
});

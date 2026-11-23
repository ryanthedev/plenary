// @ts-check
import { describe, test, expect } from "bun:test";
import {
  verifySlackSignature,
  buildSlackUnfurl,
  buildSlackNotification,
  parseSlashCommand,
} from "../../server/core/slack.js";
import { slackRoutes, extractBoardIdFromUrl } from "../../server/adapters/driving/slack-http.js";

/**
 * Helper to compute a valid Slack `v0=` signature in tests using WebCrypto.
 * @param {string} secret
 * @param {number} tsSec
 * @param {string} rawBody
 */
async function signSlack(secret, tsSec, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${tsSec}:${rawBody}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

describe("core/slack: signature verification", () => {
  const secret = "slack_signing_secret_test_12345";
  const body = '{"type":"url_verification","challenge":"abc123"}';

  test("verifies valid v0 HMAC-SHA256 signatures within 5-minute window", async () => {
    const tsSec = 1_700_000_000;
    const sig = await signSlack(secret, tsSec, body);
    expect(await verifySlackSignature(secret, String(tsSec), body, sig, { nowMs: tsSec * 1000 + 60_000 })).toBe(true);
    expect(await verifySlackSignature(secret, tsSec, body, sig, { nowMs: tsSec * 1000 + 300_000 })).toBe(true);
  });

  test("rejects tampered body, wrong secret, malformed header, and expired timestamps", async () => {
    const tsSec = 1_700_000_000;
    const sig = await signSlack(secret, tsSec, body);
    expect(await verifySlackSignature(secret, tsSec, body + "x", sig, { nowMs: tsSec * 1000 })).toBe(false);
    expect(await verifySlackSignature("wrong-secret", tsSec, body, sig, { nowMs: tsSec * 1000 })).toBe(false);
    expect(await verifySlackSignature(secret, tsSec, body, "v1=" + sig.slice(3), { nowMs: tsSec * 1000 })).toBe(false);
    expect(await verifySlackSignature(secret, tsSec, body, sig, { nowMs: tsSec * 1000 + 300_001 })).toBe(false);
    expect(await verifySlackSignature(secret, tsSec, body, sig, { nowMs: tsSec * 1000 - 300_001 })).toBe(false);
  });
});

describe("core/slack: unfurls, notifications & slash command parser", () => {
  test("buildSlackUnfurl produces Slack link_shared attachment with metadata", () => {
    const unfurl = buildSlackUnfurl(
      {
        id: "b-arch",
        title: "Payments <v2> & Ledger",
        spaceName: "Platform",
        owner: "Alice",
        elementCount: 42,
        updatedAt: 1_700_000_000_000,
        previewUrl: "https://cdn.example.com/b-arch.png",
      },
      "https://plenary.example/?board=b-arch",
    );
    expect(unfurl.title).toBe("Payments <v2> & Ledger");
    expect(unfurl.title_link).toBe("https://plenary.example/?board=b-arch");
    expect(unfurl.text).toContain("Payments &lt;v2&gt; &amp; Ledger");
    expect(unfurl.fields).toHaveLength(3);
    expect(unfurl.ts).toBe(1_700_000_000);
    expect(unfurl.image_url).toBe("https://cdn.example.com/b-arch.png");
  });

  test("buildSlackNotification formats board.changed, comment.added, and role.changed Block Kit messages", () => {
    const boardUrl = "https://plenary.example/?board=b-1";

    const changed = buildSlackNotification(
      { type: "board.changed", boardId: "b-1", boardTitle: "Q4 Plan", actor: "Alice", summary: "Added 3 nodes", timestamp: 1_700_000_000_000 },
      boardUrl,
    );
    expect(changed.text).toContain("Q4 Plan");
    expect(changed.blocks[0].text.text).toContain("updated");
    expect(changed.blocks[0].text.text).toContain("Added 3 nodes");
    expect(changed.blocks[1].elements[0].url).toBe(boardUrl);
    expect(changed.blocks[2].type).toBe("context");

    const comment = buildSlackNotification(
      { type: "comment.added", boardId: "b-1", boardTitle: "Q4 Plan", actor: "Bob", commentText: "Looks good <@U123>" },
      boardUrl,
    );
    expect(comment.blocks[0].text.text).toContain("commented on");
    expect(comment.blocks[0].text.text).toContain("&lt;@U123&gt;");

    const role = buildSlackNotification(
      { type: "role.changed", boardId: "b-1", boardTitle: "Q4 Plan", actor: "Alice", targetUser: "Carol", role: "editor" },
      boardUrl,
    );
    expect(role.blocks[0].text.text).toContain("Carol");
    expect(role.blocks[0].text.text).toContain("`editor`");
  });

  test("parseSlashCommand handles new, help, missing title, and unknown subcommands", () => {
    const created = parseSlashCommand(
      "command=%2Fplenary&text=new+Architecture+Review&user_id=U1&user_name=alice&channel_id=C1&channel_name=eng&team_id=T1",
    );
    expect(created).toMatchObject({
      action: "new",
      title: "Architecture Review",
      userId: "U1",
      userName: "alice",
      channelId: "C1",
      teamId: "T1",
    });

    expect(parseSlashCommand("command=%2Fplenary&text=help")).toMatchObject({ action: "help" });
    expect(parseSlashCommand("command=%2Fplenary&text=")).toMatchObject({ action: "help" });
    expect(parseSlashCommand("command=%2Fplenary&text=new")).toMatchObject({ action: "error", error: "missing-title" });
    expect(parseSlashCommand("command=%2Fplenary&text=delete+foo")).toMatchObject({ action: "error", error: "unknown-subcommand" });
  });
});

describe("adapters/driving/slack-http: events & slash commands", () => {
  const signingSecret = "slack_secret_for_http_tests";
  const nowSec = 1_700_000_000;

  function setup() {
    /** @type {Array<{ channel: string, ts: string, unfurls: Record<string, any>, teamId: string }>} */
    const unfurlCalls = [];
    /** @type {Array<{ title: string, slackUserId: string, channelId: string }>} */
    const createdBoards = [];

    const boards = new Map([
      ["b-123", { id: "b-123", title: "Design System", spaceName: "Design", elementCount: 18 }],
    ]);

    const slack = slackRoutes({
      signingSecret,
      publicUrl: "https://plenary.example",
      now: () => nowSec * 1000,
      getBoard: id => boards.get(id) ?? null,
      createBoard: input => {
        createdBoards.push({ title: input.title, slackUserId: input.slackUserId, channelId: input.channelId });
        return { id: "b-new-1", title: input.title };
      },
      unfurlLinks: payload => {
        unfurlCalls.push(payload);
      },
    });

    /**
     * @param {string} path
     * @param {string} rawBody
     * @param {{ ts?: number, sig?: string, contentType?: string, method?: string }} [opts]
     */
    async function send(path, rawBody, { ts = nowSec, sig, contentType = "application/json", method = "POST" } = {}) {
      const signature = sig ?? (await signSlack(signingSecret, ts, rawBody));
      return slack.handle(
        new Request(`https://plenary.example${path}`, {
          method,
          headers: {
            "content-type": contentType,
            "x-slack-request-timestamp": String(ts),
            "x-slack-signature": signature,
          },
          body: method === "POST" ? rawBody : undefined,
        }),
      );
    }

    return { slack, send, unfurlCalls, createdBoards };
  }

  test("extractBoardIdFromUrl matches query and path board URLs on the configured origin", () => {
    expect(extractBoardIdFromUrl("https://plenary.example/?board=b-123", "https://plenary.example")).toBe("b-123");
    expect(extractBoardIdFromUrl("https://plenary.example/boards/b-123", "https://plenary.example")).toBe("b-123");
    expect(extractBoardIdFromUrl("https://evil.example/?board=b-123", "https://plenary.example")).toBeNull();
  });

  test("returns undefined for unrelated routes and rejects invalid signatures", async () => {
    const { slack, send } = setup();
    expect(await slack.handle(new Request("https://plenary.example/api/v1/boards"))).toBeUndefined();

    const badSig = await send("/integrations/slack/events", '{"type":"url_verification","challenge":"x"}', {
      sig: "v0=" + "a".repeat(64),
    });
    expect(badSig?.status).toBe(401);

    const expired = await send("/integrations/slack/events", '{"type":"url_verification","challenge":"x"}', {
      ts: nowSec - 600,
    });
    expect(expired?.status).toBe(401);
  });

  test("handles Slack url_verification challenge", async () => {
    const { send } = setup();
    const res = await send(
      "/integrations/slack/events",
      JSON.stringify({ type: "url_verification", challenge: "chal-999" }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ challenge: "chal-999" });
  });

  test("dispatches link_shared unfurls for matching Plenary board URLs", async () => {
    const { send, unfurlCalls } = setup();
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "link_shared",
        channel: "C456",
        user: "U789",
        message_ts: "1700000000.000100",
        links: [
          { url: "https://plenary.example/?board=b-123" },
          { url: "https://other.example/?board=b-123" },
          { url: "https://plenary.example/?board=missing" },
        ],
      },
    };
    const res = await send("/integrations/slack/events", JSON.stringify(payload));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, unfurled: 1 });
    expect(unfurlCalls).toHaveLength(1);
    expect(unfurlCalls[0].channel).toBe("C456");
    expect(unfurlCalls[0].ts).toBe("1700000000.000100");
    expect(unfurlCalls[0].unfurls["https://plenary.example/?board=b-123"].title).toBe("Design System");
  });

  test("handles /plenary new <title> and /plenary help slash commands", async () => {
    const { send, createdBoards } = setup();

    const newRes = await send(
      "/integrations/slack/commands",
      "command=%2Fplenary&text=new+Sprint+Retro&user_id=U42&user_name=bob&channel_id=C99&team_id=T1",
      { contentType: "application/x-www-form-urlencoded" },
    );
    expect(newRes?.status).toBe(200);
    const body = await newRes?.json();
    expect(body.response_type).toBe("in_channel");
    expect(body.text).toContain("Sprint Retro");
    expect(body.text).toContain("https://plenary.example/?board=b-new-1");
    expect(createdBoards).toEqual([{ title: "Sprint Retro", slackUserId: "U42", channelId: "C99" }]);

    const helpRes = await send(
      "/integrations/slack/commands",
      "command=%2Fplenary&text=help&user_id=U42",
      { contentType: "application/x-www-form-urlencoded" },
    );
    expect(helpRes?.status).toBe(200);
    expect((await helpRes?.json()).response_type).toBe("ephemeral");

    const errRes = await send(
      "/integrations/slack/commands",
      "command=%2Fplenary&text=new&user_id=U42",
      { contentType: "application/x-www-form-urlencoded" },
    );
    expect(errRes?.status).toBe(200);
    expect((await errRes?.json()).response_type).toBe("ephemeral");
  });
});

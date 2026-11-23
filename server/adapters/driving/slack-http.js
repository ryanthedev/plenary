// @ts-check
// Driving HTTP adapter for the Slack integration (#29):
//   POST /integrations/slack/events    — url_verification challenge + link_shared unfurl dispatch
//   POST /integrations/slack/commands  — /plenary new <title> & /plenary help
//
// Verifies every inbound request with Slack's v0 HMAC-SHA256 signature and 5-minute replay window.

import {
  SLACK_REPLAY_WINDOW_MS,
  buildSlackUnfurl,
  parseSlashCommand,
  verifySlackSignature,
} from "../../core/slack.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * Extract a Plenary board ID from a shared URL matching `publicOrigin`.
 * Supports `/?board=<id>` and `/boards/<id>`.
 * @param {string} rawUrl
 * @param {string} publicOrigin
 * @returns {string | null}
 */
export function extractBoardIdFromUrl(rawUrl, publicOrigin) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (publicOrigin && parsed.origin !== publicOrigin) return null;
  const fromQuery = parsed.searchParams.get("board");
  if (fromQuery && BOARD_ID_RE.test(fromQuery)) return fromQuery;
  const m = /^\/boards\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(parsed.pathname);
  return m ? m[1] : null;
}

/**
 * Build the driving HTTP route handler for `/integrations/slack/*`.
 *
 * @param {{
 *   signingSecret: string,
 *   publicUrl: string,
 *   getBoard: (boardId: string, ctx: { teamId: string, channelId: string, userId: string }) => Promise<import("../../core/slack.js").SlackBoardSummary | null> | import("../../core/slack.js").SlackBoardSummary | null,
 *   createBoard: (input: { title: string, slackUserId: string, slackUserName: string, channelId: string, teamId: string }) => Promise<{ id: string, title: string, url?: string }> | { id: string, title: string, url?: string },
 *   unfurlLinks?: (payload: { channel: string, ts: string, unfurls: Record<string, any>, teamId: string }) => Promise<void> | void,
 *   boardUrlFor?: (boardId: string) => string,
 *   now?: () => number,
 *   toleranceMs?: number,
 *   maxBodyBytes?: number,
 * }} opts
 */
export function slackRoutes({
  signingSecret,
  publicUrl,
  getBoard,
  createBoard,
  unfurlLinks,
  boardUrlFor,
  now = () => Date.now(),
  toleranceMs = SLACK_REPLAY_WINDOW_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  const origin = (() => {
    try {
      return new URL(publicUrl).origin;
    } catch {
      return String(publicUrl ?? "").replace(/\/+$/, "");
    }
  })();

  const toBoardUrl = boardUrlFor ?? (id => `${origin}/?board=${encodeURIComponent(id)}`);

  /**
   * Read raw request body with a hard byte cap and verify Slack's HMAC signature.
   * @param {Request} req
   * @returns {Promise<{ ok: boolean, rawBody?: string, response?: Response }>}
   */
  async function readAndVerify(req) {
    const lenHeader = req.headers.get("content-length");
    if (lenHeader && /^\d+$/.test(lenHeader) && Number(lenHeader) > maxBodyBytes) {
      return {
        ok: false,
        response: json(413, { error: { code: "payload-too-large", message: "Slack payload exceeds size cap" } }),
      };
    }
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > maxBodyBytes) {
      return {
        ok: false,
        response: json(413, { error: { code: "payload-too-large", message: "Slack payload exceeds size cap" } }),
      };
    }

    const ts = req.headers.get("x-slack-request-timestamp") ?? "";
    const sig = req.headers.get("x-slack-signature") ?? "";
    const valid = await verifySlackSignature(signingSecret, ts, rawBody, sig, {
      nowMs: now(),
      toleranceMs,
    });
    if (!valid) {
      return {
        ok: false,
        response: json(401, { error: { code: "invalid-signature", message: "invalid or expired Slack signature" } }),
      };
    }
    return { ok: true, rawBody };
  }

  /**
   * Handle `/integrations/slack/events` and `/integrations/slack/commands`,
   * returning `undefined` for all other paths.
   *
   * @param {Request} req
   * @param {URL} [parsedUrl]
   * @returns {Promise<Response | undefined>}
   */
  async function handle(req, parsedUrl) {
    const url = parsedUrl ?? new URL(req.url);
    const path = url.pathname;
    if (path !== "/integrations/slack/events" && path !== "/integrations/slack/commands") {
      return undefined;
    }

    if (req.method !== "POST") {
      return json(405, { error: { code: "method-not-allowed", message: "POST required" } }, { allow: "POST" });
    }

    const verified = await readAndVerify(req);
    if (!verified.ok) return verified.response;

    if (path === "/integrations/slack/events") {
      let payload;
      try {
        payload = JSON.parse(verified.rawBody);
      } catch {
        return json(400, { error: { code: "bad-json", message: "invalid JSON payload" } });
      }

      if (payload?.type === "url_verification") {
        if (typeof payload.challenge !== "string" || !payload.challenge) {
          return json(400, { error: { code: "bad-challenge", message: "missing challenge string" } });
        }
        return json(200, { challenge: payload.challenge });
      }

      if (payload?.type === "event_callback" && payload.event?.type === "link_shared") {
        const ev = payload.event;
        const teamId = typeof payload.team_id === "string" ? payload.team_id : "";
        const channelId = typeof ev.channel === "string" ? ev.channel : "";
        const userId = typeof ev.user === "string" ? ev.user : "";
        const messageTs = typeof ev.message_ts === "string" ? ev.message_ts : "";
        const links = Array.isArray(ev.links) ? ev.links : [];

        /** @type {Record<string, any>} */
        const unfurls = {};
        for (const link of links) {
          if (!link || typeof link.url !== "string") continue;
          const boardId = extractBoardIdFromUrl(link.url, origin);
          if (!boardId) continue;
          const board = await getBoard(boardId, { teamId, channelId, userId });
          if (!board) continue;
          unfurls[link.url] = buildSlackUnfurl(board, link.url);
        }

        const count = Object.keys(unfurls).length;
        if (count > 0 && unfurlLinks) {
          await unfurlLinks({ channel: channelId, ts: messageTs, unfurls, teamId });
        }
        return json(200, { ok: true, unfurled: count });
      }

      return json(200, { ok: true, ignored: true });
    }

    // ---- /integrations/slack/commands ----
    const parsed = parseSlashCommand(verified.rawBody);

    if (parsed.action === "help") {
      return json(200, {
        response_type: "ephemeral",
        text: "Plenary Slack commands:\n• `/plenary new <title>` — Create a new Plenary board and share it in this channel\n• `/plenary help` — Show this help message",
      });
    }

    if (parsed.action === "error") {
      return json(200, {
        response_type: "ephemeral",
        text: parsed.usage,
      });
    }

    const created = await createBoard({
      title: parsed.title,
      slackUserId: parsed.userId,
      slackUserName: parsed.userName,
      channelId: parsed.channelId,
      teamId: parsed.teamId,
    });
    const boardUrl = created.url || toBoardUrl(created.id);

    return json(200, {
      response_type: "in_channel",
      text: `Created board *${created.title}*: ${boardUrl}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Created new Plenary board *${created.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}*`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open Board", emoji: false },
              url: boardUrl,
            },
          ],
        },
      ],
    });
  }

  return { handle };
}

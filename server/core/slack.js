// @ts-check
// Pure Slack integration core (#29):
// - Request signature verification (v0= HMAC-SHA256, 5-minute replay window)
// - link_shared unfurl attachment builder
// - Block Kit notification builder for board/comment/role events
// - /plenary slash command parser
//
// Zero bare package imports — uses global WebCrypto.

import { constantTimeEqual } from "./webhooks.js";

export const SLACK_SIGNATURE_VERSION = "v0";
export const SLACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MAX_BOARD_TITLE_LENGTH = 120;
const enc = new TextEncoder();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Escape Slack mrkdwn control characters (`&`, `<`, `>`).
 * @param {unknown} value
 * @returns {string}
 */
function escapeMrkdwn(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Verify a Slack request signature (`X-Slack-Signature: v0=<hex>`) using
 * WebCrypto HMAC-SHA256 and constant-time comparison, rejecting timestamps
 * outside the 5-minute replay window.
 *
 * @param {string} signingSecret
 * @param {string | number} timestamp `X-Slack-Request-Timestamp` (unix seconds)
 * @param {string} rawBody Exact raw request body
 * @param {string} sigHeader `X-Slack-Signature` header value
 * @param {{ nowMs?: number, toleranceMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function verifySlackSignature(
  signingSecret,
  timestamp,
  rawBody,
  sigHeader,
  { nowMs = Date.now(), toleranceMs = SLACK_REPLAY_WINDOW_MS } = {},
) {
  if (typeof signingSecret !== "string" || !signingSecret) return false;
  if (typeof rawBody !== "string") return false;
  if (typeof sigHeader !== "string" || !sigHeader.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) return false;

  const tsStr = typeof timestamp === "number" ? String(Math.floor(timestamp)) : String(timestamp ?? "").trim();
  if (!/^\d+$/.test(tsStr)) return false;
  const tsSec = Number(tsStr);
  if (!Number.isSafeInteger(tsSec)) return false;

  if (Math.abs(nowMs - tsSec * 1000) > toleranceMs) return false;

  const baseString = `${SLACK_SIGNATURE_VERSION}:${tsStr}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(baseString));
  const expected = `${SLACK_SIGNATURE_VERSION}=${bytesToHex(new Uint8Array(sigBytes))}`;
  return constantTimeEqual(expected, sigHeader.toLowerCase());
}

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   spaceName?: string,
 *   owner?: string,
 *   elementCount?: number,
 *   updatedAt?: number | string,
 *   previewUrl?: string,
 * }} SlackBoardSummary
 */

/**
 * Build a Slack `link_shared` unfurl attachment payload for a Plenary board.
 *
 * @param {SlackBoardSummary} board
 * @param {string} boardUrl
 * @returns {Record<string, any>}
 */
export function buildSlackUnfurl(board, boardUrl) {
  const title = (typeof board?.title === "string" && board.title.trim()) ? board.title.trim() : "Untitled Board";
  const safeTitle = escapeMrkdwn(title);
  const fields = [];
  if (typeof board?.spaceName === "string" && board.spaceName.trim()) {
    fields.push({ title: "Space", value: escapeMrkdwn(board.spaceName.trim()), short: true });
  }
  if (typeof board?.owner === "string" && board.owner.trim()) {
    fields.push({ title: "Owner", value: escapeMrkdwn(board.owner.trim()), short: true });
  }
  if (typeof board?.elementCount === "number" && Number.isFinite(board.elementCount)) {
    fields.push({ title: "Elements", value: String(board.elementCount), short: true });
  }

  /** @type {number | undefined} */
  let ts;
  if (typeof board?.updatedAt === "number" && Number.isFinite(board.updatedAt)) {
    ts = board.updatedAt > 1e12 ? Math.floor(board.updatedAt / 1000) : Math.floor(board.updatedAt);
  } else if (typeof board?.updatedAt === "string") {
    const parsed = Date.parse(board.updatedAt);
    if (Number.isFinite(parsed)) ts = Math.floor(parsed / 1000);
  }

  /** @type {Record<string, any>} */
  const attachment = {
    fallback: `${title} — ${boardUrl}`,
    color: "#3b82f6",
    title,
    title_link: boardUrl,
    text: `Live Plenary board <${boardUrl}|${safeTitle}>`,
    fields,
    footer: "Plenary",
    ...(ts !== undefined ? { ts } : {}),
    ...(typeof board?.previewUrl === "string" && board.previewUrl.startsWith("https://")
      ? { image_url: board.previewUrl }
      : {}),
  };
  return attachment;
}

/**
 * @typedef {{
 *   type: "board.changed" | "comment.added" | "role.changed" | string,
 *   boardId: string,
 *   boardTitle?: string,
 *   actor?: string,
 *   summary?: string,
 *   commentText?: string,
 *   targetUser?: string,
 *   role?: string,
 *   timestamp?: number,
 * }} SlackNotificationEvent
 */

/**
 * Build a Slack Block Kit message for board, comment, or role events.
 *
 * @param {SlackNotificationEvent} event
 * @param {string} boardUrl
 * @returns {{ text: string, blocks: Array<Record<string, any>> }}
 */
export function buildSlackNotification(event, boardUrl) {
  const boardTitle = (typeof event?.boardTitle === "string" && event.boardTitle.trim())
    ? event.boardTitle.trim()
    : event?.boardId || "Untitled Board";
  const actor = (typeof event?.actor === "string" && event.actor.trim()) ? event.actor.trim() : "Someone";
  const safeTitle = escapeMrkdwn(boardTitle);
  const safeActor = escapeMrkdwn(actor);

  let headline;
  let detail = "";
  switch (event?.type) {
    case "comment.added": {
      headline = `*${safeActor}* commented on *${safeTitle}*`;
      const body = typeof event.commentText === "string" ? event.commentText.trim() : "";
      if (body) detail = `> ${escapeMrkdwn(body.slice(0, 500))}`;
      break;
    }
    case "role.changed": {
      const target = escapeMrkdwn(event.targetUser || "a member");
      const role = escapeMrkdwn(event.role || "updated");
      headline = `*${safeActor}* changed *${target}*'s role to \`${role}\` on *${safeTitle}*`;
      break;
    }
    case "board.changed":
    default: {
      headline = `*${safeActor}* updated *${safeTitle}*`;
      if (typeof event?.summary === "string" && event.summary.trim()) {
        detail = escapeMrkdwn(event.summary.trim().slice(0, 500));
      }
      break;
    }
  }

  const fallbackText = `${actor} — ${event?.type || "update"} on ${boardTitle}: ${boardUrl}`;
  /** @type {Array<Record<string, any>>} */
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: detail ? `${headline}\n${detail}` : headline,
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
  ];

  if (typeof event?.timestamp === "number" && Number.isFinite(event.timestamp)) {
    const tsSec = event.timestamp > 1e12 ? Math.floor(event.timestamp / 1000) : Math.floor(event.timestamp);
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Plenary • <!date^${tsSec}^{date_short_pretty} at {time}|${new Date(tsSec * 1000).toISOString()}>`,
        },
      ],
    });
  }

  return { text: fallbackText, blocks };
}

/**
 * @typedef {{
 *   action: "new",
 *   title: string,
 *   command: string,
 *   userId: string,
 *   userName: string,
 *   channelId: string,
 *   channelName: string,
 *   teamId: string,
 *   responseUrl: string,
 * } | {
 *   action: "help",
 *   command: string,
 *   userId: string,
 *   userName: string,
 *   channelId: string,
 *   channelName: string,
 *   teamId: string,
 *   responseUrl: string,
 * } | {
 *   action: "error",
 *   error: string,
 *   usage: string,
 *   command: string,
 *   userId: string,
 *   userName: string,
 *   channelId: string,
 *   channelName: string,
 *   teamId: string,
 *   responseUrl: string,
 * }} ParsedSlashCommand
 */

export const SLASH_COMMAND_USAGE = "Usage: `/plenary new <title>` to create a board, or `/plenary help` for help.";

/**
 * Parse a Slack slash command `application/x-www-form-urlencoded` body
 * (or `URLSearchParams` / plain key-value record) for `/plenary new <title>`
 * and `/plenary help`.
 *
 * @param {string | URLSearchParams | Record<string, string | undefined>} formBody
 * @returns {ParsedSlashCommand}
 */
export function parseSlashCommand(formBody) {
  /** @type {(k: string) => string} */
  let get;
  if (typeof formBody === "string") {
    const params = new URLSearchParams(formBody);
    get = k => params.get(k) ?? "";
  } else if (formBody instanceof URLSearchParams) {
    get = k => formBody.get(k) ?? "";
  } else if (formBody && typeof formBody === "object") {
    get = k => (typeof formBody[k] === "string" ? formBody[k] : "");
  } else {
    get = () => "";
  }

  const meta = {
    command: get("command").trim() || "/plenary",
    userId: get("user_id").trim(),
    userName: get("user_name").trim(),
    channelId: get("channel_id").trim(),
    channelName: get("channel_name").trim(),
    teamId: get("team_id").trim(),
    responseUrl: get("response_url").trim(),
  };

  const rawText = get("text").trim();
  if (!rawText || rawText.toLowerCase() === "help") {
    return { action: "help", ...meta };
  }

  const firstSpace = rawText.search(/\s/);
  const sub = (firstSpace < 0 ? rawText : rawText.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? "" : rawText.slice(firstSpace).trim();

  if (sub === "new" || sub === "create") {
    if (!rest) {
      return {
        action: "error",
        error: "missing-title",
        usage: SLASH_COMMAND_USAGE,
        ...meta,
      };
    }
    return {
      action: "new",
      title: rest.slice(0, MAX_BOARD_TITLE_LENGTH),
      ...meta,
    };
  }

  return {
    action: "error",
    error: "unknown-subcommand",
    usage: SLASH_COMMAND_USAGE,
    ...meta,
  };
}

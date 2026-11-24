#!/usr/bin/env bun
// @ts-check
// Plenary Agent CLI v3: interact with a Plenary server's HTTP Admin API and Protocol v1.1 WebSocket rooms.
//
// Auth: PLENARY_URL and PLENARY_TOKEN env vars, or --url / --token flags.
// Output: JSON to stdout by default; errors to stderr. Exit 0 = ok, 2 = usage error, 1 = runtime/API error.

import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createPlenaryClient,
  DEFAULT_PLENARY_URL,
  normalizeBaseUrl,
  PlenaryError,
  readCredentials,
  removeServerCredentials,
  resolveCredentials,
  saveServerCredentials,
} from "./plenary-client.js";

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const USAGE = `Usage: bun scripts/plenary-cli.js <command> [options]

Global options:
  --url <url>             Plenary server base URL (default: $PLENARY_URL)
  --token <token>         Bearer / WS auth token (default: $PLENARY_TOKEN)
  --json                  Output JSON (default)
  --help, -h              Show this help

Commands:
  login                   [--url <url>] [--provider <google|microsoft|oidc>] [--no-open]
  logout                  [--url <url>] [--all]
  whoami                  [--url <url>]
  list-boards
  create-board            [--title <title>] [--member-role <editor|annotator|commenter|viewer|null>] [--space <id>]
  create-share-link       --board <id> [--role <editor|annotator|viewer>] [--expires-at <ms>] [--passcode <4..128 chars>] [--no-download]
  get-audit               [--board <id>] [--scope <board|tenant>] [--limit <n>] [--before <cursor>]
  read-board              --board <id>
  add-elements            --board <id> (--elements <json> | --file <path>) [--stream <board|notes>]
  update-elements         --board <id> (--updates <json> | --file <path>) [--stream <board|notes>]
  delete-elements         --board <id> (--ids <id1,id2|json> | --file <path>) [--base-versions <json>] [--stream <board|notes>]
  set-animation           --board <id> --ids <id1,id2|json> (--preset <name> [--start <ms>] [--duration <ms>] [--easing <name>] [--loop] | --anim <json> | --clear) [--base-versions <json>] [--stream <board|notes>]
  manage-layers           --board <id> --action <list|create|rename|toggle_visible|toggle_locked|reorder> [--id <id>] [--name <name>] [--visible <true|false>] [--locked <true|false>] [--opacity <0-100>] [--order <id1,id2|json>]
  add-link-card           --board <id> (--link <url> | --card-url <url>) [--title <title>] [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--layer <id>] [--id <id>]
  list-frames             --board <id>
  manage-views            --board <id> --action <list|create|delete> [--id <id>] [--name <name>] [--frame-id <id>] [--visible-layers <id1,id2|json>]
  add-mermaid             --board <id> (--source <mermaid> | --file <path>) [--x <n>] [--y <n>] [--layer <id>] [--elbow]
  add-note                --board <id> --text <text> [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--color <hex>]
  add-comment             --board <id> --text <text> [--x <n>] [--y <n>] [--thread <id>] [--element <id>] [--stream <board|notes>]
  set-moderation          --board <id> [--locked <true|false>] [--muted-users <u1,u2|json>]
  manage-versions         --board <id> --action <list|create|get|delete> [--label <label>] [--version-id <id>]
  manage-spaces           --action <list_home|create_area|create_space|trash_board|restore_board> [--name <name>] [--group <id>] [--general <editor|annotator|commenter|viewer|null>] [--board <id>] [--from <spaceId>]
  manage-org              --action <list_members|add_member|remove_member|list_roles> [--tenant-id <id>] [--email <email>]
  export-compliance-data  [--scope <board|tenant>] [--board <id>] [--tenant-id <id>]
  gdpr-erase-user         --user-id <id> --confirm [--tenant-id <id>]

Aliases: snake_case command names (e.g. list_boards, read_board, set_moderation) are also accepted.`;

const COMMAND_ALIASES = {
  "login": "login",
  "logout": "logout",
  "whoami": "whoami",
  "list-boards": "list_boards",
  "list_boards": "list_boards",
  "create-board": "create_board",
  "create_board": "create_board",
  "create-share-link": "create_share_link",
  "create_share_link": "create_share_link",
  "get-audit": "get_audit",
  "get_audit": "get_audit",
  "read-board": "read_board",
  "read_board": "read_board",
  "add-elements": "add_elements",
  "add_elements": "add_elements",
  "update-elements": "update_elements",
  "update_elements": "update_elements",
  "delete-elements": "delete_elements",
  "delete_elements": "delete_elements",
  "set-animation": "set_animation",
  "set_animation": "set_animation",
  "manage-layers": "manage_layers",
  "manage_layers": "manage_layers",
  "add-link-card": "add_link_card",
  "add_link_card": "add_link_card",
  "list-frames": "list_frames",
  "list_frames": "list_frames",
  "manage-views": "manage_views",
  "manage_views": "manage_views",
  "add-mermaid": "add_mermaid",
  "add_mermaid": "add_mermaid",
  "add-note": "add_note",
  "add_note": "add_note",
  "add-comment": "add_comment",
  "add_comment": "add_comment",
  "set-moderation": "set_moderation",
  "set_moderation": "set_moderation",
  "manage-versions": "manage_versions",
  "manage_versions": "manage_versions",
  "manage-spaces": "manage_spaces",
  "manage_spaces": "manage_spaces",
  "manage-org": "manage_org",
  "manage_org": "manage_org",
  "export-compliance-data": "export_compliance_data",
  "export_compliance_data": "export_compliance_data",
  "gdpr-erase-user": "gdpr_erase_user",
  "gdpr_erase_user": "gdpr_erase_user",
};

const BOOL_FLAGS = new Set(["--help", "-h", "--json", "--elbow", "--tenant", "--loop", "--clear", "--no-download", "--confirm", "--no-open", "--all"]);

/**
 * Parse CLI argv into `{ help, command, flags, positional }`.
 * Supports `--key value` and `--key=value`.
 */
export function parseCliArgs(argv) {
  let command = null;
  let help = false;
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const rawFlag = eq >= 0 ? a.slice(0, eq) : a;
      const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
      if (BOOL_FLAGS.has(rawFlag)) {
        if (inline !== undefined && inline !== "true" && inline !== "false") {
          throw new CliUsageError(`${rawFlag} takes no value`);
        }
        flags[rawFlag.slice(2)] = inline === "false" ? false : true;
        continue;
      }
      let val;
      if (inline !== undefined) {
        val = inline;
      } else {
        if (i + 1 >= argv.length) throw new CliUsageError(`${rawFlag} requires a value`);
        val = argv[++i];
      }
      flags[rawFlag.slice(2)] = val;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      throw new CliUsageError(`unknown flag: ${a}`);
    }
    if (!command) command = a;
    else positional.push(a);
  }

  if (help) return { help: true, command, flags, positional };
  if (!command) throw new CliUsageError("a command is required (run with --help)");
  const canonical = COMMAND_ALIASES[command];
  if (!canonical) throw new CliUsageError(`unknown command: ${command}`);
  return { help: false, command: canonical, flags, positional };
}

function parseNumber(val, name) {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new CliUsageError(`${name} must be a finite number`);
  return n;
}

function parseIntOpt(val, name) {
  const n = Number(val);
  if (!Number.isInteger(n)) throw new CliUsageError(`${name} must be an integer`);
  return n;
}

function parseBoolOpt(val, name) {
  if (val === "true" || val === true) return true;
  if (val === "false" || val === false) return false;
  throw new CliUsageError(`${name} must be 'true' or 'false'`);
}

function parseJsonOpt(raw, name) {
  try { return JSON.parse(raw); }
  catch { throw new CliUsageError(`${name} must be valid JSON`); }
}

/** Parse either a JSON array (`["a","b"]` or `[{"id":"a"}]`) or a comma-separated list (`a,b`). */
function parseListOrJson(raw, name) {
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("[")) {
    const parsed = parseJsonOpt(trimmed, name);
    if (!Array.isArray(parsed)) throw new CliUsageError(`${name} must be a JSON array or comma-separated list`);
    return parsed;
  }
  const items = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  if (items.length === 0) throw new CliUsageError(`${name} must not be empty`);
  return items;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function openSystemBrowser(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const href = parsed.href;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", href] : [href];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch { /* user still has the URL printed on stderr */ }
}

function constantTimeEq(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const LOGIN_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signed in to Plenary</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:400px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#94a3b8;margin:0}</style>
</head>
<body><main class="card"><h1>Signed in to Plenary</h1><p>Signed in to Plenary — you can close this tab.</p></main></body>
</html>`;

const LOGIN_ERROR_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body><h1>Sign-in failed</h1><p>You can close this tab.</p></body>
</html>`;

/**
 * Execute the PKCE loopback browser SSO login flow.
 * @param {{ url?: string, provider?: string, noOpen?: boolean, env?: Record<string, string | undefined>, err?: (s: string) => void, openBrowser?: (url: string) => void, timeoutMs?: number }} opts
 */
export async function runLoginFlow({
  url,
  provider,
  noOpen = false,
  env = process.env,
  err = s => process.stderr.write(s + "\n"),
  openBrowser = openSystemBrowser,
  timeoutMs = 120_000,
} = {}) {
  const creds = readCredentials({ env });
  const baseUrl = normalizeBaseUrl(url ?? env.PLENARY_URL ?? creds.defaultUrl ?? DEFAULT_PLENARY_URL);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let settled = false;
  let handling = false;
  /** @type {"ok" | "error" | null} */
  let outcome = null;
  let resolveFlow, rejectFlow;
  const done = new Promise((res, rej) => { resolveFlow = res; rejectFlow = rej; });
  const timer = setTimeout(() => {
    if (!settled) {
      outcome = "error";
      settled = true;
      rejectFlow(new PlenaryError("login timed out waiting for browser callback", { code: "timeout" }));
    }
  }, timeoutMs);
  timer.unref?.();

  const onSignal = sig => {
    if (!settled) {
      outcome = "error";
      settled = true;
      rejectFlow(new PlenaryError(`login cancelled (${sig})`, { code: "cancelled" }));
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const htmlResp = (status, html) => new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { "cache-control": "no-store", allow: "GET" },
        });
      }
      const u = new URL(req.url);
      if (u.pathname !== "/callback") {
        return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      if (settled) {
        return outcome === "ok" ? htmlResp(200, LOGIN_SUCCESS_HTML) : htmlResp(400, LOGIN_ERROR_HTML);
      }
      if (handling) {
        return htmlResp(409, `<!doctype html><html><body><h1>Sign-in in progress</h1><p>Already completing sign-in.</p></body></html>`);
      }

      const gotState = u.searchParams.get("state") ?? "";
      if (!constantTimeEq(gotState, state)) {
        return htmlResp(400, `<!doctype html><html><body><h1>Invalid callback</h1><p>State mismatch.</p></body></html>`);
      }

      const errParam = u.searchParams.get("error");
      if (errParam) {
        outcome = "error";
        settled = true;
        rejectFlow(new PlenaryError(`login failed: ${errParam}`, { code: "auth" }));
        return htmlResp(400, LOGIN_ERROR_HTML);
      }

      const code = u.searchParams.get("code") ?? "";
      if (!code) {
        return htmlResp(400, `<!doctype html><html><body><h1>Invalid callback</h1><p>Missing code.</p></body></html>`);
      }

      handling = true;
      try {
        const exRes = await fetch(`${baseUrl}/auth/cli-exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, verifier }),
          signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
        });
        const text = await exRes.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!exRes.ok || !data?.token) {
          outcome = "error";
          settled = true;
          const codeStr = typeof data?.error === "string" ? data.error : `http-${exRes.status}`;
          rejectFlow(new PlenaryError(`CLI token exchange failed (${codeStr})`, { code: codeStr, status: exRes.status }));
          return htmlResp(400, `<!doctype html><html><body><h1>Sign-in failed</h1><p>Token exchange failed (${escapeHtml(codeStr)}).</p></body></html>`);
        }
        saveServerCredentials({
          url: baseUrl,
          token: data.token,
          expiresAt: data.expiresAt ?? null,
          user: data.user ?? null,
          setDefault: true,
        }, { env });
        outcome = "ok";
        settled = true;
        resolveFlow({
          ok: true,
          url: baseUrl,
          user: data.user ?? null,
          expiresAt: data.expiresAt ?? null,
        });
        return htmlResp(200, LOGIN_SUCCESS_HTML);
      } catch (e) {
        outcome = "error";
        settled = true;
        rejectFlow(e instanceof PlenaryError ? e : new PlenaryError(`CLI token exchange failed: ${e?.message ?? e}`, { code: "network-error" }));
        return htmlResp(500, `<!doctype html><html><body><h1>Sign-in error</h1><p>Could not complete token exchange.</p></body></html>`);
      } finally {
        handling = false;
      }
    },
  });

  try {
    const loginUrl = new URL(`${baseUrl}/auth/login`);
    loginUrl.searchParams.set("cli_port", String(server.port));
    loginUrl.searchParams.set("cli_state", state);
    loginUrl.searchParams.set("cli_challenge", challenge);
    if (provider && String(provider).trim()) {
      loginUrl.searchParams.set("provider", String(provider).trim().toLowerCase());
    }
    err(`Open this URL in your browser to sign in:\n${loginUrl.href}`);
    if (!noOpen) openBrowser(loginUrl.href);
    return await done;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await new Promise(r => setTimeout(r, 25));
    try { server.stop(true); } catch { /* already stopped */ }
  }
}

/**
 * Execute the Plenary CLI with explicit argv, env, and IO streams (easy to test).
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, clientFactory?: (o: { url?: string, token?: string }) => any, openBrowser?: (url: string) => void, loginTimeoutMs?: number }} [io]
 * @returns {Promise<number>} process exit code
 */
export async function runCli(
  argv,
  env = process.env,
  {
    out = s => process.stdout.write(s + "\n"),
    err = s => process.stderr.write(s + "\n"),
    clientFactory,
    openBrowser,
    loginTimeoutMs,
  } = {},
) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.help) {
    out(USAGE);
    return 0;
  }

  const { command, flags, positional } = parsed;
  const board = flags.board ?? positional[0];

  try {
    if (command === "login") {
      const result = await runLoginFlow({
        url: flags.url,
        provider: flags.provider,
        noOpen: Boolean(flags["no-open"]),
        env,
        err,
        ...(openBrowser ? { openBrowser } : {}),
        ...(loginTimeoutMs !== undefined ? { timeoutMs: loginTimeoutMs } : {}),
      });
      out(JSON.stringify(result, null, 2));
      return 0;
    }

    if (command === "logout") {
      const res = removeServerCredentials({ url: flags.url ?? null, all: Boolean(flags.all) }, { env });
      out(JSON.stringify({ ok: true, url: res.url, ...(res.all ? { all: true } : {}) }, null, 2));
      return 0;
    }

    if (command === "whoami") {
      const resolved = resolveCredentials({ url: flags.url ?? null, token: flags.token ?? null, env });
      out(JSON.stringify({
        url: resolved.url,
        source: resolved.source,
        user: resolved.user,
        expiresAt: resolved.expiresAt,
        ...(resolved.expired ? { expired: true } : {}),
      }, null, 2));
      return 0;
    }

    const resolved = resolveCredentials({ url: flags.url ?? null, token: flags.token ?? null, env });
    if (!clientFactory) {
      if (resolved.expired) {
        throw new PlenaryError("Credentials expired — run 'plenary login' to re-authenticate.", { code: "auth-expired" });
      }
      if (!resolved.token) {
        throw new PlenaryError("Not authenticated — run 'plenary login' (or set PLENARY_URL and PLENARY_TOKEN).", { code: "config-error" });
      }
    }
    const client = clientFactory
      ? clientFactory({ url: resolved.url ?? undefined, token: resolved.token ?? undefined })
      : createPlenaryClient({
          url: resolved.url ?? undefined,
          token: resolved.token ?? undefined,
          clientName: "plenary-cli",
        });

    let result;
    switch (command) {
      case "list_boards": {
        result = await client.listBoards();
        break;
      }
      case "create_board": {
        const opts = {};
        if (flags.title !== undefined) opts.title = flags.title;
        if (flags["member-role"] !== undefined) {
          opts.memberRole = flags["member-role"] === "null" ? null : flags["member-role"];
        }
        if (flags.space !== undefined) opts.space = flags.space;
        if (flags["tenant-id"] !== undefined) opts.tenant = flags["tenant-id"];
        result = await client.createBoard(opts);
        break;
      }
      case "create_share_link": {
        if (!board) throw new CliUsageError("create-share-link requires --board <id>");
        const opts = { board, role: flags.role ?? "viewer" };
        if (flags["expires-at"] !== undefined) opts.expiresAt = parseIntOpt(flags["expires-at"], "--expires-at");
        if (flags.passcode !== undefined) opts.passcode = flags.passcode;
        if (flags["no-download"] !== undefined) opts.noDownload = Boolean(flags["no-download"]);
        result = await client.createShareLink(opts);
        break;
      }
      case "get_audit": {
        const opts = {};
        if (board) opts.board = board;
        if (flags.scope) opts.scope = flags.scope;
        if (flags.tenant) opts.scope = "tenant";
        if (flags.limit !== undefined) opts.limit = parseIntOpt(flags.limit, "--limit");
        if (flags.before !== undefined) opts.before = flags.before;
        result = await client.getAudit(opts);
        break;
      }
      case "read_board": {
        if (!board) throw new CliUsageError("read-board requires --board <id>");
        result = await client.readBoard({ board });
        break;
      }
      case "add_elements": {
        if (!board) throw new CliUsageError("add-elements requires --board <id>");
        const rawJson = flags.file !== undefined ? readFileSync(flags.file, "utf8") : flags.elements;
        if (!rawJson) throw new CliUsageError("add-elements requires --elements <json> or --file <path>");
        const elements = parseJsonOpt(rawJson, "--elements");
        result = await client.addElements({ board, elements, stream: flags.stream ?? "board" });
        break;
      }
      case "update_elements": {
        if (!board) throw new CliUsageError("update-elements requires --board <id>");
        const rawJson = flags.file !== undefined ? readFileSync(flags.file, "utf8") : flags.updates;
        if (!rawJson) throw new CliUsageError("update-elements requires --updates <json> or --file <path>");
        const updates = parseJsonOpt(rawJson, "--updates");
        result = await client.updateElements({ board, updates, stream: flags.stream ?? "board" });
        break;
      }
      case "delete_elements": {
        if (!board) throw new CliUsageError("delete-elements requires --board <id>");
        const rawIds = flags.file !== undefined ? readFileSync(flags.file, "utf8") : flags.ids;
        if (!rawIds) throw new CliUsageError("delete-elements requires --ids <id1,id2|json> or --file <path>");
        const ids = parseListOrJson(rawIds, "--ids");
        const opts = { board, ids, stream: flags.stream ?? "board" };
        if (flags["base-versions"] !== undefined) {
          opts.baseVersions = parseJsonOpt(flags["base-versions"], "--base-versions");
        }
        result = await client.deleteElements(opts);
        break;
      }
      case "set_animation": {
        if (!board) throw new CliUsageError("set-animation requires --board <id>");
        if (!flags.ids) throw new CliUsageError("set-animation requires --ids <id1,id2|json>");
        const ids = parseListOrJson(flags.ids, "--ids");
        let anim;
        if (flags.clear) {
          anim = null;
        } else if (flags.anim !== undefined) {
          anim = parseJsonOpt(flags.anim, "--anim");
        } else if (flags.preset !== undefined) {
          anim = { preset: flags.preset };
          if (flags.start !== undefined) anim.start = parseNumber(flags.start, "--start");
          if (flags.duration !== undefined) anim.duration = parseNumber(flags.duration, "--duration");
          if (flags.easing !== undefined) anim.easing = flags.easing;
          if (flags.loop !== undefined) anim.loop = Boolean(flags.loop);
        } else {
          throw new CliUsageError("set-animation requires --preset <name>, --anim <json>, or --clear");
        }
        const opts = { board, ids, anim, stream: flags.stream ?? "board" };
        if (flags["base-versions"] !== undefined) {
          opts.baseVersions = parseJsonOpt(flags["base-versions"], "--base-versions");
        }
        result = await client.setAnimation(opts);
        break;
      }
      case "manage_layers": {
        if (!board) throw new CliUsageError("manage-layers requires --board <id>");
        const action = flags.action ?? (flags.board ? positional[0] : positional[1]);
        if (!action) throw new CliUsageError("manage-layers requires --action <list|create|rename|toggle_visible|toggle_locked|reorder>");
        const opts = { board, action };
        if (flags.id !== undefined) opts.id = flags.id;
        if (flags.name !== undefined) opts.name = flags.name;
        if (flags.visible !== undefined) opts.visible = parseBoolOpt(flags.visible, "--visible");
        if (flags.locked !== undefined) opts.locked = parseBoolOpt(flags.locked, "--locked");
        if (flags.opacity !== undefined) opts.opacity = parseNumber(flags.opacity, "--opacity");
        if (flags.order !== undefined) opts.order = parseListOrJson(flags.order, "--order");
        result = await client.manageLayers(opts);
        break;
      }
      case "add_link_card": {
        if (!board) throw new CliUsageError("add-link-card requires --board <id>");
        const cardUrl = flags.link ?? flags["card-url"];
        if (!cardUrl) throw new CliUsageError("add-link-card requires --link <url> (or --card-url <url>)");
        const opts = { board, url: cardUrl };
        if (flags.title !== undefined) opts.title = flags.title;
        if (flags.x !== undefined) opts.x = parseNumber(flags.x, "--x");
        if (flags.y !== undefined) opts.y = parseNumber(flags.y, "--y");
        if (flags.width !== undefined) opts.width = parseNumber(flags.width, "--width");
        if (flags.height !== undefined) opts.height = parseNumber(flags.height, "--height");
        if (flags.layer !== undefined) opts.layer = flags.layer;
        if (flags.id !== undefined) opts.id = flags.id;
        result = await client.addLinkCard(opts);
        break;
      }
      case "list_frames": {
        if (!board) throw new CliUsageError("list-frames requires --board <id>");
        result = await client.listFrames({ board });
        break;
      }
      case "manage_views": {
        if (!board) throw new CliUsageError("manage-views requires --board <id>");
        const action = flags.action ?? (flags.board ? positional[0] : positional[1]);
        if (!action) throw new CliUsageError("manage-views requires --action <list|create|delete>");
        const opts = { board, action };
        if (flags.id !== undefined) opts.id = flags.id;
        if (flags.name !== undefined) opts.name = flags.name;
        if (flags["frame-id"] !== undefined) {
          opts.frameId = flags["frame-id"] === "null" ? null : flags["frame-id"];
        }
        if (flags["visible-layers"] !== undefined) {
          opts.visibleLayers = parseListOrJson(flags["visible-layers"], "--visible-layers");
        }
        result = await client.manageViews(opts);
        break;
      }
      case "add_mermaid": {
        if (!board) throw new CliUsageError("add-mermaid requires --board <id>");
        const source = flags.file !== undefined ? readFileSync(flags.file, "utf8") : flags.source;
        if (!source) throw new CliUsageError("add-mermaid requires --source <mermaid> or --file <path>");
        const opts = { board, source, elbow: Boolean(flags.elbow) };
        if (flags.x !== undefined || flags.y !== undefined) {
          opts.origin = {
            x: flags.x !== undefined ? parseNumber(flags.x, "--x") : 0,
            y: flags.y !== undefined ? parseNumber(flags.y, "--y") : 0,
          };
        }
        if (flags.layer !== undefined) opts.layer = flags.layer;
        result = await client.addMermaid(opts);
        break;
      }
      case "add_note": {
        if (!board) throw new CliUsageError("add-note requires --board <id>");
        if (!flags.text) throw new CliUsageError("add-note requires --text <text>");
        const opts = { board, text: flags.text };
        if (flags.x !== undefined) opts.x = parseNumber(flags.x, "--x");
        if (flags.y !== undefined) opts.y = parseNumber(flags.y, "--y");
        if (flags.width !== undefined) opts.width = parseNumber(flags.width, "--width");
        if (flags.height !== undefined) opts.height = parseNumber(flags.height, "--height");
        if (flags.color !== undefined) opts.backgroundColor = flags.color;
        if (flags["stroke-color"] !== undefined) opts.strokeColor = flags["stroke-color"];
        result = await client.addNote(opts);
        break;
      }
      case "add_comment": {
        if (!board) throw new CliUsageError("add-comment requires --board <id>");
        if (!flags.text) throw new CliUsageError("add-comment requires --text <text>");
        const opts = { board, text: flags.text };
        if (flags.x !== undefined) opts.x = parseNumber(flags.x, "--x");
        if (flags.y !== undefined) opts.y = parseNumber(flags.y, "--y");
        if (flags.thread !== undefined) opts.thread = flags.thread;
        if (flags.element !== undefined) opts.element = flags.element;
        if (flags.stream !== undefined) opts.stream = flags.stream;
        result = await client.addComment(opts);
        break;
      }
      case "set_moderation": {
        if (!board) throw new CliUsageError("set-moderation requires --board <id>");
        const opts = { board };
        if (flags.locked !== undefined) opts.locked = parseBoolOpt(flags.locked, "--locked");
        if (flags["muted-users"] !== undefined) {
          opts.mutedUsers = flags["muted-users"] === "" ? [] : parseListOrJson(flags["muted-users"], "--muted-users");
        }
        if (opts.locked === undefined && opts.mutedUsers === undefined) {
          throw new CliUsageError("set-moderation requires --locked <true|false> and/or --muted-users <u1,u2|json>");
        }
        result = await client.setModeration(opts);
        break;
      }
      case "manage_versions": {
        if (!board) throw new CliUsageError("manage-versions requires --board <id>");
        const action = flags.action ?? (flags.board ? positional[0] : positional[1]);
        if (!action) throw new CliUsageError("manage-versions requires --action <list|create|get|delete>");
        const opts = { board, action };
        if (flags.label !== undefined) opts.label = flags.label;
        if (flags["version-id"] !== undefined) opts.versionId = flags["version-id"];
        else if (flags.id !== undefined) opts.versionId = flags.id;
        result = await client.manageVersions(opts);
        break;
      }
      case "manage_spaces": {
        const action = flags.action ?? positional[0];
        if (!action) throw new CliUsageError("manage-spaces requires --action <list_home|create_area|create_space|trash_board|restore_board>");
        const opts = { action };
        if (flags.name !== undefined) opts.name = flags.name;
        if (flags.group !== undefined) opts.group = flags.group === "null" ? null : flags.group;
        if (flags.general !== undefined) opts.general = flags.general === "null" ? null : flags.general;
        if (flags.board !== undefined) opts.board = flags.board;
        if (flags.from !== undefined) opts.from = flags.from;
        result = await client.manageSpaces(opts);
        break;
      }
      case "manage_org": {
        const action = flags.action ?? positional[0];
        if (!action) throw new CliUsageError("manage-org requires --action <list_members|add_member|remove_member|list_roles>");
        const opts = { action };
        if (flags["tenant-id"] !== undefined) opts.tenant = flags["tenant-id"];
        if (flags.email !== undefined) opts.email = flags.email;
        result = await client.manageOrg(opts);
        break;
      }
      case "export_compliance_data": {
        const opts = {};
        if (flags.scope !== undefined) opts.scope = flags.scope;
        if (flags.board !== undefined) opts.board = flags.board;
        if (flags["tenant-id"] !== undefined) opts.tenant = flags["tenant-id"];
        result = await client.exportComplianceData(opts);
        break;
      }
      case "gdpr_erase_user": {
        const userId = flags["user-id"] ?? positional[0];
        if (!userId) throw new CliUsageError("gdpr-erase-user requires --user-id <id> --confirm");
        const extraArgs = flags["user-id"] !== undefined ? positional : positional.slice(1);
        if (extraArgs.length > 0) {
          throw new CliUsageError(`unexpected argument '${extraArgs[0]}' for gdpr-erase-user (use --confirm or --confirm=true)`);
        }
        const opts = { userId, confirm: flags.confirm === true };
        if (flags["tenant-id"] !== undefined) opts.tenant = flags["tenant-id"];
        result = await client.gdprEraseUser(opts);
        break;
      }
    }

    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliUsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({
      ok: false,
      error: e?.message ?? String(e),
      code: e?.code ?? "error",
      ...(e?.details !== undefined ? { details: e.details } : {}),
    }));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), process.env);
  process.exit(code);
}

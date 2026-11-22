#!/usr/bin/env bun
// Plenary Agent CLI: interact with a Plenary server's HTTP Admin API and Protocol v1.1 WebSocket rooms.
//
// Auth: PLENARY_URL and PLENARY_TOKEN env vars, or --url / --token flags.
// Output: JSON to stdout by default; errors to stderr. Exit 0 = ok, 2 = usage error, 1 = runtime/API error.

import { readFileSync } from "node:fs";
import { createPlenaryClient } from "./plenary-client.js";

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
  list-boards
  create-board            [--title <title>] [--member-role <editor|annotator|commenter|viewer|null>]
  create-share-link       --board <id> [--role <editor|annotator|viewer>] [--expires-at <ms>]
  get-audit               [--board <id>] [--scope <board|tenant>] [--limit <n>] [--before <cursor>]
  read-board              --board <id>
  add-elements            --board <id> (--elements <json> | --file <path>) [--stream <board|notes>]
  add-mermaid             --board <id> (--source <mermaid> | --file <path>) [--x <n>] [--y <n>] [--layer <id>] [--elbow]
  add-note                --board <id> --text <text> [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--color <hex>]
  add-comment             --board <id> --text <text> [--x <n>] [--y <n>] [--thread <id>] [--element <id>] [--stream <board|notes>]

Aliases: snake_case command names (e.g. list_boards, read_board, add_mermaid) are also accepted.`;

const COMMAND_ALIASES = {
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
  "add-mermaid": "add_mermaid",
  "add_mermaid": "add_mermaid",
  "add-note": "add_note",
  "add_note": "add_note",
  "add-comment": "add_comment",
  "add_comment": "add_comment",
};

const BOOL_FLAGS = new Set(["--help", "-h", "--json", "--elbow", "--tenant"]);

/**
 * Parse CLI argv into `{ help, command, flags, positional }`.
 * Supports `--key value` and `--key=value`.
 */
export function parseCliArgs(argv) {
  let command = null;
  let help = false;
  const flags = {};
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

/**
 * Execute the Plenary CLI with explicit argv, env, and IO streams (easy to test).
 * @returns {Promise<number>} process exit code
 */
export async function runCli(
  argv,
  env = process.env,
  {
    out = s => process.stdout.write(s + "\n"),
    err = s => process.stderr.write(s + "\n"),
    clientFactory,
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
    const client = clientFactory
      ? clientFactory({ url: flags.url ?? env.PLENARY_URL, token: flags.token ?? env.PLENARY_TOKEN })
      : createPlenaryClient({
          url: flags.url ?? env.PLENARY_URL,
          token: flags.token ?? env.PLENARY_TOKEN,
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
        result = await client.createBoard(opts);
        break;
      }
      case "create_share_link": {
        if (!board) throw new CliUsageError("create-share-link requires --board <id>");
        const opts = { board, role: flags.role ?? "viewer" };
        if (flags["expires-at"] !== undefined) opts.expiresAt = parseIntOpt(flags["expires-at"], "--expires-at");
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
        let elements;
        try { elements = JSON.parse(rawJson); }
        catch { throw new CliUsageError("--elements must be valid JSON"); }
        result = await client.addElements({ board, elements, stream: flags.stream ?? "board" });
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
    }

    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliUsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code ?? "error" }));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), process.env);
  process.exit(code);
}

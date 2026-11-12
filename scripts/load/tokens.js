// Dev tokens for a load run. Writes, into <dir>, both files 0600 and never prints a token:
//   dev-tokens.json   the PLENARY_DEV_TOKENS value: { "<token>": { name, role, domain, admin? } } (one admin owner). The load client reads this file
//                     (--tokens) and picks tokens by role; the server takes the same JSON as its env value.
//   dev-tokens.env    one line `PLENARY_DEV_TOKENS='<json>'` for `bun --env-file=<dir>/dev-tokens.env server/main.js`.
//
// Users: one per editor and per annotator client (a writer may hold at most MAX_WRITER_CONNS = 8 connections per
// user and board per gateway; one each keeps that far away), and one per `viewersPerUser` viewer clients (the
// gateway caps sockets per user at PLENARY_MAX_CONNS_PER_USER, default 64). So 10k clients need a few hundred
// tokens, not 10k: the env value stays far below the OS's ARG_MAX.
//
// CLI: bun scripts/load/tokens.js --out <dir> --editors n --annotators n --viewers n [--viewers-per-user 32]
//      prints only the two file paths.

import { writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_VIEWERS_PER_USER = 32;
const ROLE_PREFIX = { editor: "e", annotator: "a", viewer: "v" };

const randomToken = () => "lt-" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

/** Tokens for that many clients of each role: { "<token>": { name, role } }. */
export function makeTokens({ editors = 0, annotators = 0, viewers = 0, viewersPerUser = DEFAULT_VIEWERS_PER_USER, prefix = "load", domain = "load.test" } = {}) {
  // One admin (owner) of the domain's tenant, so --create-board can POST /boards; every token is in the domain.
  const tokens = { [randomToken()]: { name: `${prefix}-admin`, role: "owner", domain, admin: true } };
  const users = { editor: editors, annotator: annotators, viewer: Math.ceil(viewers / Math.max(1, viewersPerUser)) };
  for (const [role, n] of Object.entries(users))
    for (let i = 1; i <= n; i++) tokens[randomToken()] = { name: `${prefix}-${ROLE_PREFIX[role]}${i}`, role, domain };
  return tokens;
}

/** Write dev-tokens.json and dev-tokens.env (0600) into dir. Returns their paths (never the tokens). */
export function writeTokens(dir, tokens) {
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(tokens);
  const jsonPath = join(dir, "dev-tokens.json"), envPath = join(dir, "dev-tokens.env");
  // mode on create, then chmod in case the file already existed with a wider mode.
  writeFileSync(jsonPath, json, { mode: 0o600 }); chmodSync(jsonPath, 0o600);
  writeFileSync(envPath, `PLENARY_DEV_TOKENS='${json}'\n`, { mode: 0o600 }); chmodSync(envPath, 0o600);
  return { jsonPath, envPath };
}

/**
 * Read a tokens file and group its tokens by role, in a stable order (by user name). Accepts the dev-tokens JSON
 * object ({ token: { name, role } }; a missing role is "editor", as the server reads it).
 * @returns {{ editor: string[], annotator: string[], viewer: string[], owner: string[], commenter: string[] }}
 */
export function readTokensByRole(path) {
  // The parser's message is not passed on: it can quote the file's text, and that text is tokens.
  let table;
  try { table = JSON.parse(readFileSync(path, "utf8")); } catch (err) { if (err?.code) throw err; throw new Error(`tokens file ${path} is not valid JSON`); }
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error(`tokens file ${path} is not a JSON object of token → { name, role }`);
  const out = { owner: [], editor: [], annotator: [], commenter: [], viewer: [] };
  const entries = Object.entries(table).sort((a, b) => String(a[1]?.name).localeCompare(String(b[1]?.name), "en", { numeric: true }));
  for (const [tok, t] of entries) (out[t?.role ?? "editor"] ?? out.editor).push(tok);
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.out) { console.error("usage: bun scripts/load/tokens.js --out <dir> --editors n --annotators n --viewers n [--viewers-per-user 32]"); process.exit(2); }
  const tokens = makeTokens({ editors: +(a.editors ?? 5), annotators: +(a.annotators ?? 0), viewers: +(a.viewers ?? 0), viewersPerUser: +(a["viewers-per-user"] ?? DEFAULT_VIEWERS_PER_USER) });
  const { jsonPath, envPath } = writeTokens(a.out, tokens);
  console.log(`tokens: ${Object.keys(tokens).length} users\n  ${jsonPath}\n  ${envPath}`);
}

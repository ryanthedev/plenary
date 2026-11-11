// What a room needs from the outside world, as interfaces, plus in-memory versions for tests and M2's
// first server. A deployment swaps these (Postgres, S3, a bus) without touching the room.

/**
 * Who is this token, and what may they do on this board? null = refused.
 * The tenant comes from the board, on the server; a client never names it.
 * @typedef {{ check(token: string, board: string): null | { user: string, role: string, tenant: string } }} Auth
 */

/**
 * The durable op log. append() returns only once the entry is stored: a room acks after it (PROTOCOL rule 1).
 * @typedef {{ append(entry: object): void }} Log
 */

/** An Auth from a fixed table: token → { user, role }, one tenant. */
export function tableAuth(table, tenant = "t1") {
  return { check: token => (table[token] ? { ...table[token], tenant } : null) };
}

/** A Log in memory (tests, single-process dev). */
export class MemoryLog {
  constructor() { this.entries = []; }
  append(entry) { this.entries.push(entry); }
}

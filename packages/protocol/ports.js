// What a room needs from the outside world, as interfaces, plus in-memory versions for tests and
// single-process use. A deployment swaps these (SQLite, Postgres, a bus) without touching the room.
// The server's ports are async (PROTOCOL.md § Ports); the ones here are synchronous, and a room takes both.

/**
 * The durable log of one board, as a room sees it (the server binds tenant and board).
 * `append` writes every entry or none, and only if the log ends at `expectSeq`; else it throws an error
 * with `code: "conflict"`. It returns (or resolves) only once the entries are durable: a room acks after it.
 * @typedef {{
 *   append(entries: object[], expectSeq: number): void | Promise<void>,
 *   putCheckpoint?(cp: object): void | Promise<void>,
 * }} Log
 */

/**
 * The server's ports (PROTOCOL.md § Ports), all async. A room is handed none of them: the server gives it a
 * per-board Log (above) made from the Store, and the verified identity with each hello.
 * @typedef {{ verify(token: string): Promise<null | { user: string, name: string, email: string, domain: string }>,
 *             role(identity: object, board: string): Promise<null | string> }} Auth  null = refused; a throw = unavailable
 * @typedef {{ append(tenant: string, board: string, entries: object[], expectSeq: number): Promise<void>,
 *             read(tenant: string, board: string, fromSeq: number, limit: number): Promise<object[]>,
 *             putCheckpoint(tenant: string, board: string, cp: object): Promise<void>,
 *             getCheckpoint(tenant: string, board: string, beforeSeq?: number): Promise<null | object> }} Store
 * @typedef {{ publish(subject: string, msg: object): void, subscribe(subject: string, fn: (msg: object) => void): () => void }} Bus  at-most-once
 * @typedef {{ put(tenant: string, sha1: string, bytes: Uint8Array): Promise<void>, get(tenant: string, sha1: string): Promise<null | Uint8Array> }} Blobs
 */

const copy = v => JSON.parse(JSON.stringify(v));
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Who is this token on this board? For tests: token → { user, role } (any board), or
 * { user, boards: { [board]: role } }. null = refused. The room never calls it; a gateway does (rule 8).
 */
export function tableAuth(table) {
  return {
    check(token, board) {
      const who = Object.prototype.hasOwnProperty.call(table, token) ? table[token] : null;
      const role = who && (who.boards ? who.boards[board] : who.role);
      return role ? { user: who.user, role, ...(who.name ? { name: who.name } : {}) } : null;
    },
  };
}

/** A Log in memory, with the Store's contract for one board: conditional append, read, checkpoints. */
export class MemoryLog {
  constructor() { this.entries = []; this.checkpoints = []; }

  /** The last seq in the log (0 when empty). */
  get end() { return this.entries.length ? this.entries[this.entries.length - 1].seq : 0; }

  append(entries, expectSeq) {
    if (!Array.isArray(entries) || !entries.length) throw fail("bad-append", "append takes a list of entries");
    if (expectSeq !== this.end) throw fail("conflict", `the log ends at ${this.end}, not ${expectSeq}`);
    for (let i = 0; i < entries.length; i++) if (entries[i].seq !== expectSeq + 1 + i) throw fail("bad-append", "entries must follow the log's end, one seq each");
    this.entries.push(...entries);
  }

  /** Entries with seq ≥ fromSeq, ascending. */
  read(fromSeq = 1, limit = Infinity) {
    const first = this.entries.length ? this.entries[0].seq : 1, at = Math.max(0, fromSeq - first);
    return this.entries.slice(at, limit === Infinity ? undefined : at + limit);
  }

  /** The highest seq wins, never the last write. */
  putCheckpoint(cp) {
    const mine = copy(cp), at = this.checkpoints.findIndex(c => c.seq >= mine.seq);
    if (at < 0) this.checkpoints.push(mine);
    else if (this.checkpoints[at].seq === mine.seq) this.checkpoints[at] = mine;
    else this.checkpoints.splice(at, 0, mine);
  }

  /** The latest checkpoint, or the latest below `beforeSeq` (to step back from a bad one). null if none. */
  getCheckpoint(beforeSeq = Infinity) {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) if (this.checkpoints[i].seq < beforeSeq) return copy(this.checkpoints[i]);
    return null;
  }
}

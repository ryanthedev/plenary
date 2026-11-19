// Ids the server trusts in keys, paths and bus subjects (PROTOCOL.md § Bus): server-minted, [a-z0-9-] only,
// so no ".", "*", ">" (subject wildcards) and no "/" or ".." (paths). Check at every port, whoever the caller is.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
import { randomId } from "./auth/util.js";

const CLUSTER = /^c-[a-z0-9]{16}$/;
const SHA1 = /^[0-9a-f]{40}$/;

/** Is this a tenant, board or gateway id? */
export const isId = v => typeof v === "string" && ID.test(v);
/** Is this a cluster id ("c-" + 16 of [a-z0-9], minted by the Postgres store: PROTOCOL.md § Bus, Cluster id)? */
export const isClusterId = v => typeof v === "string" && CLUSTER.test(v);
/** A new cluster id (the one place its format is built; `isClusterId` is the one place it is checked). */
export const mintClusterId = () => "c-" + randomId(16);
/** Is this a lowercase hex SHA-1? */
export const isSha1 = v => typeof v === "string" && SHA1.test(v);

export class PortError extends Error {
  /** @param {string} code e.g. "conflict", "bad-id", "too-large", "hash-mismatch", "not-image", "bad-entry", "closed" */
  constructor(code, message) { super(message); this.name = "PortError"; this.code = code; }
}

/** Throws PortError("bad-id") unless `v` is a server id. */
export function needId(v, what) { if (!isId(v)) throw new PortError("bad-id", `bad ${what} id`); return v; }

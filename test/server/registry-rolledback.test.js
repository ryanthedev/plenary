// `rolledBack` on a Registry rejection (registry-port.js): set only when the call certainly wrote nothing, so the idempotency key can be freed
// (http.js wroteNothing) without knowing any adapter's codes.
import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { PgRegistryError } from "../../server/registry/postgres.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-rolledback-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("SQLite: a write that meets a locked database rejects with SQLITE_BUSY and rolledBack; an ordinary failure is not marked; nothing was written", async () => {
  const path = join(dir, "r.db");
  const r = sqliteRegistry({ path, fullfsync: false, busyTimeoutMs: 50 });
  const other = new Database(path);
  other.run("BEGIN IMMEDIATE");                       // another connection holds the write lock
  try {
    const err = await r.idemClaim("dev:ada", "key-busy-0001", "f".repeat(64)).catch(e => e);
    expect(err.code).toMatch(/^SQLITE_BUSY/);
    expect(err.rolledBack).toBe(true);
    const bad = await r.idemClaim("dev:ada", 5, "x").catch(e => e);   // a validation failure: not a rollback claim
    expect(bad.rolledBack).toBeUndefined();
  } finally { other.run("ROLLBACK"); other.close(); }
  expect((await r.idemClaim("dev:ada", "key-busy-0001", "f".repeat(64))).state).toBe("new");   // the busy call left no row behind
  await r.close();
});

test("Postgres: the errors of a call that never began or rolled back carry rolledBack; a client-timeout (it may have committed) does not", () => {
  for (const code of ["queue-timeout", "overloaded", "lock-timeout", "statement-timeout"]) expect(new PgRegistryError(code, "x").rolledBack).toBe(true);
  for (const code of ["client-timeout", "last-owner"]) expect(new PgRegistryError(code, "x").rolledBack).toBeUndefined();
});

// The Store port's shared checks (server/store/port.js): what both adapters apply before touching a database.
import { test, expect } from "bun:test";
import { fitBytes, checkRead, checkAppend, checkCheckpoint, needTtl, needLeaseEpoch, MAX_READ, MAX_LEASE_TTL_MS, STORE_METHODS } from "../../server/store/port.js";

const code = f => { try { f(); return "ok"; } catch (e) { return e.code; } };

test("fitBytes: as many leading rows as fit the budget, always at least one", () => {
  expect(fitBytes([10, 10, 10], 25)).toBe(2);
  expect(fitBytes([100, 1], 5)).toBe(1);        // the first row alone is over budget: still returned
  expect(fitBytes([5, 5], 10)).toBe(2);         // an exact fit
  expect(fitBytes([], 10)).toBe(0);
});

test("checkRead: the page is capped at MAX_READ; bad arguments are bad-entry", () => {
  expect(checkRead(1, 5, undefined)).toBe(5);
  expect(checkRead(0, MAX_READ * 3, 100)).toBe(MAX_READ);
  for (const args of [[-1, 1], [1.5, 1], [1, 0], [1, 1.5], [1, Infinity], [1, 1, 0], [1, 1, "9"]]) expect(code(() => checkRead(...args))).toBe("bad-entry");
});

test("checkAppend: entries follow expectSeq one seq each, belong to the board, serialise; every write names its epoch", () => {
  const e = seq => ({ tenant: "t-a", board: "b-1", seq });
  expect(checkAppend("t-a", "b-1", [e(3), e(4)], 2, 1)).toEqual({ seqs: [3, 4], datas: [JSON.stringify(e(3)), JSON.stringify(e(4))] });
  const cyclic = e(3); cyclic.self = cyclic;
  for (const [entries, expect_, epoch] of [[[e(4)], 2, 1], [[e(3), e(5)], 2, 1], [[], 2, 1], [[e(3)], 2, undefined], [[e(3)], 2, 0], [[e(3)], -1, 1],
    [[{ ...e(3), board: "b-2" }], 2, 1], [[{ ...e(3), tenant: "t-b" }], 2, 1], [[cyclic], 2, 1], [[null], 2, 1]])
    expect(code(() => checkAppend("t-a", "b-1", entries, expect_, epoch))).toBe("bad-entry");
});

test("checkCheckpoint, needTtl, needLeaseEpoch", () => {
  expect(code(() => checkCheckpoint({ seq: 0 }, 1))).toBe("ok");
  for (const [cp, epoch] of [[{ seq: -1 }, 1], [{}, 1], [null, 1], [{ seq: 1.5 }, 1], [{ seq: 1 }, undefined]]) expect(code(() => checkCheckpoint(cp, epoch))).toBe("bad-entry");
  expect(code(() => needTtl(MAX_LEASE_TTL_MS))).toBe("ok");
  for (const ttl of [0, MAX_LEASE_TTL_MS + 1, 1.5, "5", undefined]) expect(code(() => needTtl(ttl))).toBe("bad-entry");
  for (const ep of [undefined, 0, -1, 1.5, "1"]) expect(code(() => needLeaseEpoch(ep))).toBe("bad-entry");
});

test("STORE_METHODS names the twelve port methods", () => expect(STORE_METHODS.length).toBe(12));

import { ddlColumns } from "../../server/pg/schema.js";
test("ddlColumns: the columns of a Postgres DDL string, minus table constraints, with nested parentheses", () => {
  expect(ddlColumns("tenant TEXT NOT NULL, board TEXT NOT NULL, seq BIGINT NOT NULL, PRIMARY KEY (tenant, board, seq)")).toEqual(["tenant", "board", "seq"]);
  expect(ddlColumns("id TEXT NOT NULL, singleton BOOLEAN NOT NULL DEFAULT true PRIMARY KEY CHECK (singleton)")).toEqual(["id", "singleton"]);
  expect(ddlColumns(`tenant TEXT NOT NULL REFERENCES "s".reg_tenants(id), grp TEXT REFERENCES "s".reg_groups(id), UNIQUE (tenant, owner_user)`)).toEqual(["tenant", "grp"]);
  expect(ddlColumns("d TEXT DEFAULT 'a,b', e TEXT")).toEqual(["d", "e"]);                    // a comma inside a literal
  expect(ddlColumns("d TEXT DEFAULT 'it''s, ok', e TEXT, f TEXT CHECK (f <> '(')")).toEqual(["d", "e", "f"]);   // an escaped quote, and a parenthesis inside a literal
  expect(ddlColumns(`"a,b" TEXT, c TEXT`)).toEqual(["a,b", "c"]);
  expect(ddlColumns("n BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE")).toEqual(["n", "id"]);
});

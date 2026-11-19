// Migration equivalence (issue #46): "existing boards, grants, invites, links and memberRole migrate with no change in
// anyone's access". Each durable adapter's test builds the PRE-ORGANIZATION database (the seven original tables, filled with
// a seeded random state), opens the adapter on it (which migrates), and checks that every identity's role on every board
// is what it was before.
//
// "Before" is `legacyRole` below: a frozen copy of the role rule as it was at 1d0bcbe (server/auth/tenancy.js `combine`),
// computed from the JS state itself, never through the adapter under test. Do not "fix" it to follow the new resolver:
// it is the oracle.
//
//   legacyEquivalence("sqlite", { install(state), open(), reopen?, cleanup() })
//     install(state): writes `state` into old-shape tables (the adapter's own DDL for the original tables, nothing else)
//     open(): opens the adapter on that database, returning { registry, close() }

import { describe, test, expect } from "bun:test";
import { tenancy, roleCache } from "../../server/auth/tenancy.js";
import { capTo, higher, normEmail, ROLES, LINK_ROLES, INVITE_ROLES } from "../../server/auth/util.js";

export const NOW = 5_000_000;
const liveRow = x => x && !x.revoked && (x.expiresAt == null || NOW < x.expiresAt);

/** The pre-organization rule, frozen. @returns {string|null} */
export function legacyRole(state, identity, boardId) {
  const board = state.boards.find(b => b.id === boardId);
  if (!board) return null;
  const tenant = state.tenants.find(t => t.id === board.tenant);
  let r = capTo(state.grants.find(g => g.board === boardId && g.user === identity.user)?.role ?? null, ROLES);
  const email = identity.email ? normEmail(identity.email) : null;
  for (const i of state.invites) if (email && i.board === boardId && normEmail(i.email) === email && liveRow(i)) r = higher(r, capTo(i.role, INVITE_ROLES));
  for (const u of state.uses) {
    if (u.board !== boardId || u.user !== identity.user) continue;
    const l = state.links.find(x => x.id === u.link);
    if (l && l.board === boardId && liveRow(l)) r = higher(r, capTo(l.role, LINK_ROLES));
  }
  if (identity.domain && board.memberRole && tenant?.domain && tenant.domain === identity.domain) r = higher(r, capTo(board.memberRole, INVITE_ROLES));
  return r ?? null;
}

const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** A seeded legacy state (invite emails are stored lower-cased, as every adapter wrote them): three tenants (two domains, one none), admins, boards of every memberRole, grants of every role (junk included), live/expired/revoked invites and links. */
export function legacyState(seed) {
  const rnd = rng(seed), pick = a => a[Math.floor(rnd() * a.length)];
  const tenants = [{ id: "t-aaaaaaaaaaaa", domain: "acme.com", admins: ["google:root", "email:boss@acme.com"] }, { id: "t-bbbbbbbbbbbb", domain: "globex.com", admins: [] }, { id: "t-cccccccccccc", domain: null, admins: ["dev:ops"] }];
  const users = Array.from({ length: 10 }, (_, i) => `google:u${i}`).concat(["google:root", "dev:ops"]);
  const mroles = [null, "viewer", "commenter", "annotator", "editor", "owner", "bogus"];
  const roles = ["viewer", "commenter", "annotator", "editor", "owner", "bogus", "admin", "member"];
  const boards = Array.from({ length: 16 }, (_, i) => ({ id: `b-${String(i).padStart(16, "0")}`, tenant: pick(tenants).id, title: `board ${i}`, memberRole: pick(mroles) }));
  const grants = [], invites = [], links = [], uses = [];
  for (const b of boards) {
    for (const u of users) if (rnd() < 0.25) grants.push({ board: b.id, user: u, role: pick(roles) });
    for (let k = 0; k < 3; k++) if (rnd() < 0.7) invites.push({ id: `i-${b.id}-${k}`, board: b.id, email: pick(["u1@acme.com", "u2@acme.com", "u3@globex.com", "u4@partner.io", "u5@gmail.com", "nobody@x.org"]),
      role: pick(roles), expiresAt: pick([null, NOW + 1000, NOW - 1000, NOW]), revoked: rnd() < 0.2 });
    for (let k = 0; k < 2; k++) if (rnd() < 0.7) {
      const l = { id: `l${b.id}${k}`, board: b.id, role: pick(roles), expiresAt: pick([null, NOW + 1000, NOW - 1000]), revoked: rnd() < 0.2 };
      links.push(l);
      for (const u of users) if (rnd() < 0.2) uses.push({ board: b.id, user: u, link: l.id });
    }
  }
  return { tenants, boards, grants, invites, links, uses };
}

/** Identities: every user with each of a few email / domain combinations (a role reads all three). */
export function identities() {
  const out = [];
  for (let i = 0; i < 10; i++) for (const [domain, mail] of [["acme.com", `u${i}@acme.com`], ["globex.com", `u${i}@globex.com`], [null, `u${i}@partner.io`], [null, null]])
    out.push({ user: `google:u${i}`, domain, email: mail });
  out.push({ user: "google:root", domain: "acme.com", email: "boss@acme.com" }, { user: "dev:ops", domain: null, email: null });
  for (const e of ["U1@Acme.com", "u2@acme.com", "u3@globex.com", "u4@partner.io", "u5@gmail.com"]) out.push({ user: "google:u1", domain: "acme.com", email: e });
  return out;
}

export function legacyEquivalence(name, { install, open, count }) {
  describe(`migration equivalence: ${name}`, () => {
    for (const seed of [1, 2, 3]) test(`seed ${seed}: every identity's role on every board is unchanged after the migration (and after a second open)`, async () => {
      const state = legacyState(seed);
      await install(state);
      const ids = identities();
      const expected = new Map(state.boards.map(b => [b.id, ids.map(id => legacyRole(state, id, b.id))]));
      // sanity: the state exercises every role and null, so equality is not vacuous
      const seen = new Set([...expected.values()].flat());
      for (const want of [null, "viewer", "editor", "owner"]) expect(seen.has(want)).toBe(true);

      for (let pass = 0; pass < 2; pass++) {                                       // pass 1 migrates; pass 2 re-runs start-up on the migrated database
        const { registry, close } = await open();
        try {
          const ten = tenancy({ registry, now: () => NOW });
          const cache = roleCache({ registry, now: () => NOW });
          for (const b of state.boards) {
            const want = expected.get(b.id);
            const many = await ten.rolesFor(b.id, ids);
            // every identity through the batch (one pass per board: the cheap path), a few per board through the hello path and the cache (a SQL round trip each: kept few so the test stays fast)
            for (let i = 0; i < ids.length; i++) expect([b.id, ids[i], many.get(`${ids[i].user}\n${ids[i].email ?? ""}\n${ids[i].domain ?? ""}`)]).toEqual([b.id, ids[i], want[i]]);
            for (let i = pass * 11; i < ids.length; i += 23) expect([b.id, ids[i], await ten.role(ids[i], b.id)]).toEqual([b.id, ids[i], want[i]]);
            for (const i of [pass ? 21 : 0]) expect(await cache.role(ids[i], b.id)).toBe(want[i]);
          }
          // nothing was invented: no Spaces, Groups, Teams, roles or scoped grants; boards unfiled; Units read as one-domain companies
          for (const t of state.tenants) {
            const u = await registry.tenant(t.id);
            expect([u.kind, u.domains, u.admins]).toEqual(["company", t.domain ? [t.domain] : [], t.admins]);
            expect([await registry.spaces(t.id), await registry.groups(t.id), await registry.teams(t.id), await registry.roles(t.id)]).toEqual([[], [], [], []]);
          }
          for (const b of state.boards) {
            const got = await registry.board(b.id);
            expect([got.space, got.memberRole]).toEqual([null, b.memberRole]);
            expect(await registry.grants(b.id)).toHaveLength(state.grants.filter(g => g.board === b.id).length);
          }
          if (count) expect(await count()).toEqual({ boards: state.boards.length, grants: state.grants.length, invites: state.invites.length, links: state.links.length });
        } finally { await close(); }
      }
    });
  });
}

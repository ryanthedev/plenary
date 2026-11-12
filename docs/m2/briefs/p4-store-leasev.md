# Brief: p4-store-leasev (verify p4-store-lease: lease + epoch fence in the Store)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture", the sdd
helpers), CLAUDE.md (NFRs: one sequencer per board, an acknowledged op is never lost), PROTOCOL.md v1.1 (§ Recovery,
Room identity / epoch), docs/m2/reports/p-audit.md (F5, F12, F13), then the job's brief docs/m2/briefs/p4-store-lease.md.

- **Your tab:** `verifier p4-store-leasev (engine) · <your id>: lease + epoch fence`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the job is uncommitted in the shared tree /Users/r/repos/plenary (main). Its files: server/store/sqlite.js,
  server/store/postgres.js, packages/protocol/ports.js (Store typedef only), test/server/store-contract.js,
  test/server/store.test.js, test/server/pg-store.test.js. Other sessions are editing other files in that tree
  (server/gateway.js, server/feed.js, test/server/rig.js, v1.test.js, tune.test.js, harness.test.js, PROTOCOL.md,
  web/**, server/auth|admin|registry/**): ignore those. **Change nothing in /Users/r/repos/plenary** except your
  report. Run attacks, mutations and repeated runs in a copy in your scratchpad
  (`rsync -a --exclude .git --exclude node_modules --exclude .env`; never copy `.env`).
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p4-store-leasev.md: PASS or FAIL, findings HIGH/MEDIUM/LOW,
  each with a repro. Then stop, idle.
- Read the builder's report docs/m2/reports/p4-store-lease.md only for "Not verified", "Risks", "Upgrade path" and
  "Spec proposal". Test the code, not the claims.

## How to check (minimum)

1. **systems-design skill, CHECKER mode** (/Users/r/repos/systems-design.skill) on the lease + fence against the NFRs:
   can two hosts both believe they hold a board? Can a stale holder land an entry or a checkpoint after a takeover
   (any window between the fence check and the CAS)? Is expiry judged only on the DB's clock? Is `openEpoch`
   overriding leases (builder's risk) safe for M2's single-node and cluster modes?
2. **Spec conformance:** the brief's Goal 1-4 vs the code, and the builder's PROTOCOL.md proposal vs the code, both
   ways. Every deviation is a finding.
3. **Attack it, both adapters:** many concurrent acquirers (exactly one wins, epochs strictly increase); a stale
   holder's append, checkpoint, renew after takeover; release then acquire; append with no epoch (the SEAM path:
   what does it bypass?); Postgres: a fenced append racing an uncommitted takeover from a second connection; the
   `needs-migration` refusal and LEASE_UPGRADE_SQL on a pre-lease table; `lock_timeout`; the wrapped 42501 as a bare
   least-privilege role (deploy/README.md's grants). SQLite: two OS processes on one file if you can.
4. **Mutation checks:** at least: drop the fence check in append, in putCheckpoint; don't bump the epoch on takeover;
   judge expiry on the host clock; let a stale holder renew. Each must be caught by a test.
5. **Repeat:** `bun test test/server` 10x in the copy; the lease cases' 300 ms ttl must not flake.
6. **Hexagonal:** the adapters import ports and the shared list only; test/architecture.test.js green.
7. **sdd ensemble** of `git diff -- server/store packages/protocol/ports.js test/server/store-contract.js
   test/server/store.test.js test/server/pg-store.test.js`: codex + every harness that passes check_adapter;
   confirm or refute each two-harness finding.
8. `bun test` in the shared tree, and once with DATABASE_URL (brew postgresql@17 on a free port, PID recorded,
   stopped after). test/core-source.test.js fails from known herdr-draw drift; not this job's.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete your scratch data at the end.

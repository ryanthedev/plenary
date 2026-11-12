# Brief: p-archv (verify p-arch: the architecture boundary test and the Postgres schema helper)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture"), CLAUDE.md,
then the job's brief docs/m2/briefs/p-arch.md.

- **Your tab:** `verifier p-archv (engine) · <your id>: architecture test`. Manager: `manager engine`, terminal
  `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main). The job is uncommitted: test/arch-scan.js,
  test/architecture.test.js, server/pg/ (new), server/store/postgres.js, server/registry/postgres.js (import lines),
  test/server/architecture.test.js (deleted). Other sessions are editing other files concurrently (p2-tune on
  server/gateway.js, server/feed.js, test/server/**; client's p6-hex on web/**): ignore those. **Change nothing in
  the tree**; plant violations only in a scratch copy.
- **Report:** docs/m2/reports/p-archv.md: PASS or FAIL, HIGH/MEDIUM/LOW with repros. Then stop, idle.
- Don't read the builder's report except "Not verified" and "Risks" (below).

## Builder's "Not verified" and "Risks" (verbatim, shortened)

- NATS and S3 suites not run live (no code changed there).
- Scanner blind spots: computed specifiers, import.meta.resolve, a block comment between `import` and `(`.
- Adapter imports of non-adapters are not restricted: an adapter may import any port and any non-adapter file
  (so an adapter importing server/gateway.js passes today).
- Concurrent edits by other sessions during its green run.

## Check (minimum)

1. Does the test catch each rule: core → adapter, adapter → adapter (different groups and same port), a non-root
   file wiring an adapter, a new folder silently becoming core, a stale allowlist entry? Plant each in a scratch
   copy; also try re-exports, dynamic `import()`, `require`, JSDoc `import("…")` types, relative paths with `..`
   and `./x/../y`, `.js`-less specifiers, and files outside the listed folders (scripts/, deploy/).
2. Is the class of every file under packages/ and server/ right (core, port, adapter, support, composition root)?
   List any you'd classify differently.
3. **Decide-able question for the manager, give a recommendation:** should adapters be limited to ports + an
   explicit shared list (ids.js, auth/util.js, server/pg/), so an adapter importing core logic (gateway, room-host,
   feed, server.js) fails?
4. server/pg/schema.js move: behaviour unchanged? Run the Postgres store and registry contracts against a local
   brew postgresql@17 (start it yourself with a recorded PID and a free port, stop it after), including p2-swap's
   least-privilege test.
5. The API in test/arch-scan.js is what client (test/web/architecture.test.js) and platform will import: is it
   documented, stable and usable for web/ rules? Try a tiny web/ rule in scratch.
6. `bun test` green (note any failure in files outside this job and say whose).
7. systems-design skill, CHECKER mode, lightly (static test: say what applies). sdd ensemble on the diff if quick.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.

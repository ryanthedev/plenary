# Brief: p-audit (architecture audit of the engine: hexagonal + systems design vs the NFRs)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Architecture"), CLAUDE.md (NFRs, decisions),
docs/m2/PLAN.md, PROTOCOL.md (v1.1), then all of server/ (except server/auth/, server/admin/, server/registry/,
which are platform's: read them only where engine code calls them) and packages/protocol/.

- **Your tab:** `worker p-audit (engine) · <your id>: architecture audit`. Manager: `manager engine`, terminal
  `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** a clean, read-only snapshot of main, so other sessions' in-flight edits don't mislead you:
  `git -C /Users/r/repos/plenary worktree add --detach <your scratchpad>/audit 3a7520d` (remove it at the end with
  `git worktree remove --force`). Change nothing in /Users/r/repos/plenary except your report.
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p-audit.md. Then stop, idle.
- In flight (don't report what they already fix): p2-tune (re-check stalls R1/R2, `here`, feed seq+1, flaky tests;
  brief docs/m2/briefs/p2-tune.md) and p-serve (static web serving; docs/m2/briefs/p-serve.md).

## Goal (CEO: "make sure we are doing hexagonal application architecture and use the systems design skill")

1. **Hexagonal review** beyond what test/architecture.test.js checks statically: does the core (room host, gateway,
   feed, server.js, packages/protocol) depend only on port *behaviour*, or does it lean on one adapter's quirks
   (SQLite timing, memory bus ordering, Bun specifics)? Is every port's contract written down and tested by a
   shared contract test that every adapter passes (Store, Bus, Blobs, Registry, Auth, Clock, Log, Transport)? Are
   ports missing (e.g. a Clock the core reads from `Date.now()`, timers, randomness)? Is main.js the only place that
   picks adapters? Name each gap with file:line.
2. **distributed-systems-design skill, CHECKER mode** (/Users/r/repos/systems-design.skill), against CLAUDE.md's
   NFRs and M2's shape (one program, two roles; gateways fan out, room hosts sequence one board each, sharded by
   board, lease and takeover in phase 4):
   - one sequencer per board and its fencing (epoch), an acknowledged op is never lost, presence may drop;
   - 100k viewers / 2k annotators per board, 100k joins in 2 min, editors < 150 ms, viewers < 1 s;
   - what breaks first at 10k clients (the M2 load test) and at 100k (M4): estimate with numbers from the code
     (per-message CPU, bytes, buffers, Store reads per join, bus fan-out).
   - failure modes: Store slow/down, bus partition, gateway crash, room host crash, clock skew, slow consumers.
3. **Phase 4 readiness:** what leases/takeover (room host sharding by board, lease + takeover, epoch fencing in
   the Store) needs from today's code; propose the job split.

## Output

- Findings as a table: id, severity (HIGH = violates an NFR or the hexagonal rule in a way that will bite in M2;
  MEDIUM = will bite by M4 or makes a port unswappable; LOW), file:line, what, proposed fix, and which job should
  own it. Group them into proposed fix jobs with file ownership that doesn't collide.
- The skill's CHECKER output (its steps, briefly).
- Numbers for the load estimates, each with how you got it.
- Do not fix anything. You may run tests and micro-benchmarks in your scratch worktree.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.

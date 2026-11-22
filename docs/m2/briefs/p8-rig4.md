# Brief: p8-rig4 (fix round 4 for the local cluster rig: A, C, B, D, E from p8-rig3v)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig4.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall, no ipcrm: stop only PIDs you started and recorded (and PIDs
whose command line names your scratchpad). Do not commit. **Work, tests and mutations only in a copy in your
scratchpad (rsync of the real tree with `--exclude .env --exclude .rig --exclude .git`, node_modules symlinked). The
copy must never contain .env; check with `find <copy> -name .env` before every run.** Set `TMPDIR` to your
scratchpad for every run. When done and green, sync only your files back (scripts/cluster-rig.js, test/deploy/*,
deploy/cluster/RIG.md, deploy/cluster.compose.yml; check first that the real-tree versions still equal what you
copied). Never edit server/*, packages/*, PROTOCOL.md, scripts/load/*, test/load/* or deploy/README.md. Another worker
(p8-load4) works on scripts/load/ and test/load/: ignore those and its processes. After every mutation batch, `ps` for
leftovers of your copy and stop them by PID, and record `ipcs -m -o -p` before and after (the rig's own shm cleanup
must leave no new segment in an unmutated run). Stop at 60% context after writing what you have.

## Job

Verifier p8-rig3v FAILED p8-rig3 (round 3): docs/m2/reports/p8-rig3v.md (read it whole; its attack scripts are in
`/private/tmp/claude-501/-Users-r-repos-plenary/*/scratchpad/atk/` of session 20b2cad7's scratchpad, find it with
`ls -d /private/tmp/claude-501/-Users-r-repos-plenary/*/scratchpad/atk`, read-only: copy what you need). Fix:

1. **A (HIGH):** a `ps` that fails once in `launch` and then recovers leaves the just-spawned child running and
   unrecorded. In `startRig`'s catch, always `stopKids` after `stopRig`, whether or not it threw. Test: a `ps` stub
   that fails once on the first probe of a matching PID and then recovers, for nats-server and for postgres; no
   process left, and a second `up` on the dir never wipes `pg/` under a live postmaster.
2. **C (MEDIUM):** a failing `save` inside the catch skips all cleanup. Make the catch's `save` best-effort so
   `stopRig`/`stopKids` always run. Test: the verifier's `rig.json.tmp`-is-a-directory repro.
3. **B (LOW):** three `up`s and a stale lock can leave two holders. Close it (e.g. never delete a lock you did not
   create; refuse instead) or, if you cannot close it within this round, keep it in RIG.md "Known limits" as now
   seen with injected delays. Say which and why.
4. **D (LOW):** `removeOrphanShm` is one-shot; if a backend is still attached when the postmaster dies, the segment
   is kept for good. Retry briefly until NATTCH is 0 (bounded), keeping every existing safety check (exact id, key,
   postmaster gone, same user).
5. **E (LOW, docs):** cluster.compose.yml comments at lines 19-20 and 72: make them true without depending on
   deploy/README.md's wording (that file is not ours).

## Done when

Each fix has a test, and a mutation that reverts it alone fails `bun test test/deploy`; re-run p8-rig3v's A and C
repros live. Gates: `bun test test/deploy` 3x in your copy, `bun test test/architecture.test.js` in the real tree
(read-only). Report docs/m2/reports/p8-rig4.md: changes and guards per finding, mutations, gates, housekeeping
(processes and shm segments before/after), not verified. Then stop.

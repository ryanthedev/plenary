# Review: Job A — rig and test-harness tools (c29dbc3, base 3f90e74)

Independent post-gate review. Worktree `/Users/r/loops/plenary/wt/rig`, branch `plenary/rig`. Nothing committed.

**Verdict: FAIL**, with two HIGH findings: H1 (the harness itself causes the `main-cluster` failure) and H2 (a SIGINT
during teardown leaks services).

## Executed results

- `bun run test:fast`, 3 runs: 412 pass / 0 fail, 3.90 s, 3.88 s, 4.02 s (wall clock 3.9–4.0 s).
- `bun run test:cluster`: 204 pass / 1 fail / 0 skip, 205 tests in 8 files, 58.7 s (60.6 s wall). Exit 1, rig kept and
  printed, services stopped. The fail is `main-cluster.test.js`, at **line 107** (`h2 /health` reports `rooms: 0,
  waiting: 1`). The builder reported line 81. See H1.
- Copy of the script with only `pg-store` (a green run): exit 0, rig dir removed, no processes left.
- Copy of the script with only `s3-blobs` and `S3_ENDPOINT` removed: "11 skip" was detected, it printed
  `cluster test files reported skipped tests`, and it **exited 1**. The skip check works.
- One SIGINT to the `test-cluster.js` pid mid-run: exit 130, `down` stopped all 6 parts, no `wt/rig/.rig` process
  left, no new `ipcs -m` row. The only remaining segment belongs to the mc81 rig (NATTCH 127, CPID = mc81's postmaster).
- A second SIGINT while the `down` helper runs: **leak**. See H2.
- `bun test test/deploy/cluster-rig.test.js`: 36 pass / 0 fail (50 s). `bun test test/architecture.test.js`: 16 pass.
- `rig ls`, `status/down --name nope`: shown below. `rig gc` live: exit 0, removed nothing; the only segment is attached.
- Clean-up: every rig I created (`test-57749-*`, `test-61444-*`, `test-64118-*`, `test-65090-*`, `test-68892-*`,
  `rv-79404`) was removed. `.rig/` is empty, no `wt/rig` processes are running, and `ipcs -m` matches the baseline.

## Done-when

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | minio stand-in, bucket, blobs in rig.json, S3_* env, stops on down | PASS | cluster-rig.js:485-497 (launch, `rig.blobs`, health wait, signed `PUT /plenary`); s3Env:673; `down` output lists `minio`; s3-blobs 22 tests ran with 0 skips in test:cluster |
| 2 | ls, down --all, down --clean, non-zero + "did you mean", gc safety | PASS (LOW notes) | `ls` → `test-65090-4eb981  4 process(es)`; `status --name nope` / `down --name nope` → `[rig] no rig named nope; did you mean --name test-64118-fd3753?` exit 1; `down --all --clean` stopped and removed 4 rigs; gc parser probes below |
| 3 | postgresql@17 keg dirs + linux path; missing binary prints install cmd | PASS (LOW note) | cluster-rig.js:57-66 (`/opt/homebrew/opt/postgresql@17/bin`, `/usr/local/opt/...`, `/usr/lib/postgresql/17/bin`); :412 install message |
| 4 | test-cluster: unique name, all gated files, teardown on finally+signals, rm on green, keep on red, exit = bun test's, loud on skip | **FAIL** | Items work as listed (above), but see H1 and H2 |
| 5 | package.json scripts | PASS | test, test:fast, test:full, test:cluster, rig all present; test:fast spawns no server (L3 notes small exceptions) |
| 6 | RIG.md documents it all + why Postgres is TCP-only | PASS (LOW note) | RIG.md:33-52 commands, :75 TCP-only (103-byte socket path), :77-82 test:cluster, :175 gc |

### Gated-file completeness (checked by grep)

Every test file that reads `DATABASE_URL`, `NATS_URL` or `S3_*` from `process.env`: pg-store, pg-registry, nats-bus,
room-host-lease, room-host-proc (+ its child helper), main-cluster, s3-blobs, admin/tenants. That is exactly the
8-file `FILES` list (test-cluster.js:8-17). Other matches are not gated. `main.test.js`, `p4-wire2.test.js` and
`devadmin.test.js` use literal fake URLs. `google-live*` is gated on `PLENARY_LIVE_GOOGLE`. `cluster-rig.test.js` is
gated on binaries and runs in plain `bun test`. **No gated file is missing.**

## Findings

### HIGH

**H1. test:cluster's own rig nodes make `main-cluster.test.js` fail.** scripts/test-cluster.js:32 starts the rig with
`--gateways 1 --hosts 1`, which runs Caddy and real `server/main.js` nodes `gw-1` and `host-1`. These nodes are on
the same NATS server the tests receive. `main-cluster.test.js:47` starts its own nodes with the **same ids**
(`gw-1`, `gw-2`, `host-1`) on that NATS server (its own database, shared NATS). No gated test uses the rig's nodes or
LB: the child env has only DATABASE_URL, NATS_URL and S3_*.
- Shown on rig `rv-79404`, same env, `bun test test/server/main-cluster.test.js`: **0/2 pass while the rig's nodes
  run, 3/3 pass after `rig kill host-1` and `rig kill gw-1`.**
- The "known" red test that a separate debug job owns comes from this harness, not from the server. That job is
  probably chasing a bug that does not exist, and test:cluster can never go green.
- The extra nodes and Caddy also add start-up time to every run.
- Fix: start a services-only rig (Postgres, NATS, MinIO; no nodes, no Caddy). `startRig` now needs `gateways >= 1`
  (cluster-rig.js:407), so add a services-only option. An interim alternative: `rig kill` the nodes before spawning
  the tests.

**H2. A SIGINT during teardown kills the `down` helper and leaks the rig's services.** The signal handler
(test-cluster.js:23-27) forwards every signal to `helper`. In `finally`, `helper` is the `down` process
(test-cluster.js:79 → runRigCli :96). `cluster-rig.js down` has no signal handler (only `up` installs one, :687), so
it dies at once.
- Shown: a first SIGINT mid-tests, then a second SIGINT as soon as `cluster-rig.js down` appeared. Exit 130. **Left
  running: postgres, nats-server and minio for `.rig/test-65090-4eb981`, plus `node:gw-1`.** A later
  `rig down --name test-65090-4eb981` reported `stopped node:gw-1, minio, nats, postgres`.
- One SIGINT is enough when it lands during the final `down`, for example a Ctrl-C while a red run tears down. A
  second Ctrl-C because teardown "hangs" is the common case. This breaks done-when 4, "always tears down … SIGINT".
- Fix: once in `finally`, stop forwarding signals to the `down` helper. Also give `down` its own SIGINT, SIGTERM and
  SIGHUP handling so that it finishes stopping (or ignores the signal) instead of dying halfway.

### MEDIUM

None.

### LOW

**L1. The MinIO credentials are fixed constants, committed, but the doc calls them "generated".**
cluster-rig.js:258-259 (`plenary-rig-local` / `plenary-rig-local-secret-key`); RIG.md:96 says "MinIO's generated
local credentials".
- The cookie and session keys are generated per rig. These are the same for every rig on every machine, so any local
  user can read and write any rig's bucket on its loopback port.
- `up` and `status` print the secret key in plain text (`S3_SECRET_ACCESS_KEY=…` in the test:cluster log).
- They do not leak further: `.rig/` is gitignored (verified with `git check-ignore`), and `git grep` finds them only
  in cluster-rig.js.
- Fix: generate them per rig, as `keys.json` does, or correct the doc.

**L2. `rig gc` notes (the parser was probed with crafted input; no unsafe selection found).**
- The probe: `parseIpcsSegments` (cluster-rig.js:69-82) against macOS `-o` output with rows attached (127, 1),
  other user (`root`), near-miss users (`rr`, `R`), a missing NATTCH, a shifted row, extra CPID/LPID columns, an
  empty or garbage header, and Linux default output. It selected only same-user rows with NATTCH 0. Attached rows,
  other users' rows and malformed rows were never selected.
- Quirk: NATTCH `00` and `0x0` also parse as 0 (`Number`). ipcs never prints these. Harmless.
- `gc` runs `ipcs -m -o` (:737). util-linux `ipcs` is not known to accept `-o`, so on Linux gc most likely exits with
  "ipcs -m -o failed; no segments were removed". That is safe, but gc then does nothing there. The Linux unit test
  parses default output, which the CLI never produces. Not verified on Linux.
- gc removes **every** unattached segment of the current user, not only the rig's. This matches done-when 2. There is
  a time-of-check gap: a segment created by another loop's postmaster between `ipcs` and `ipcrm` would be marked for
  removal. The window is microseconds.

**L3. test:fast is free of servers but not fully free of timing or spawns.**
- `test/envelope.test.js:62` asserts `< 500 ms` of wall clock. The test measured 12 ms, so the margin is about 40x.
- `test/web/collab/perf-clock.test.js:8` runs the clock contract on real `setTimeout` sleeps. Its bounds are lower
  bounds only (≥ 9 ms after a 10 ms wait).
- `test/web/core-runtime-globals.test.js:40` spawns `bun` child processes. These are not servers.
- No `Bun.serve`, sockets, load or cluster tests. 3/3 runs were green at about 3.9 s.

**L4. "did you mean" is incomplete.**
- It suggests `others[0]`, the first dir alphabetically, even when that rig is dead and another rig is live
  (cluster-rig.js:670). In my run it suggested a stopped rig while `test-65090` was the only live one.
- `env` and `kill` with an unknown name exit 1 with `no rig at … (rig.json missing)` and give no suggestion.

**L5. The install hints are partly wrong or stale.**
- The Debian/Ubuntu hint `sudo apt-get install … minio …` (cluster-rig.js:412) names a package that Debian and
  Ubuntu do not ship. `postgresql-17` also needs the PGDG repo on most releases.
- `test/deploy/cluster-rig.test.js:19` still says `brew install postgresql@17 nats-server caddy`, without minio,
  even though `missingBins()` now includes minio.

**L6. The gated-file list is hard-coded** (test-cluster.js:8-17). It is complete today. A new env-gated test file
would not run under test:cluster, and the skip check would not notice, because the file is never run. A small guard
test that greps `test/` for `process.env.(DATABASE_URL|NATS_URL|S3_ENDPOINT)` and compares the result with `FILES`
would close this.

**L7. Redundant work.** On green, `down --clean` already removes the dir, then `rmSync` removes it again
(test-cluster.js:79, :88). Harmless.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | FAIL | H1: the rig's nodes share NATS with the tests' nodes and use the same ids |
| Error handling | FAIL | H2: the teardown helper is killed by a forwarded signal |
| Resources | FAIL | H2: postgres, nats, minio and a node leak |
| Boundaries | PASS | gc parser probes (L2); name length ≤ 19 characters |
| Security | PASS (L1 note) | Loopback-only listeners (asserted in cluster-rig.test.js, 36/36 pass); static local creds noted |

**Verdict: FAIL.** The blockers are H1 (scripts/test-cluster.js:32: the rig's nodes cause the main-cluster failure)
and H2 (scripts/test-cluster.js:23-27 and :79, plus cluster-rig.js `down` with no signal handling: a SIGINT during
teardown leaks services). Everything else in done-when 1–6 checks out.

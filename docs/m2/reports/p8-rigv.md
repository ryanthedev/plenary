# Report: p8-rigv (verify p8-rig, the local cluster rig)

**Verdict: FAIL, on one HIGH (H1).** `isOurs` compares `ps -o lstart=` strings, and those strings are in local time
and the caller's locale. When `up` and `down` run under a different `TZ` or `LC_ALL`, every rig process looks "not
ours". `down` then stops nothing and reports them all "already gone". A second `up` on that dir deletes the live rig's
dir, including the running Postgres's data dir, and leaves 6 processes running that nothing records. I reproduced
both. The fix is small: run `ps` with a fixed `TZ`/`LC_ALL`.

Everything else the brief asked for holds (one test gap, M2, is graded LOW):
- **Teardown:** PID reuse with an edited rig.json, `down` after a SIGKILLed `up`.
- **Crash midway:** each start step fails in turn, plus SIGINT and SIGTERM during `up`.
- **Secrets:** none printed, none in logs, files are 0600.
- **Binding:** everything on loopback.
- **Real main.js:** board and hello through the LB.
- **Compose:** parses.
- **Mutations:** the builder's 7 each fail a test.

New mutations show gaps in the tests (no test checks loopback binding or SIGKILL escalation). Those are graded below.

Worked in a copy: `rsync` of the tree (uncommitted files included) to
`/private/tmp/claude-501/-Users-r-repos-plenary/853a8827-e186-4859-9b05-211df49662a2/scratchpad/pl`. No edits or
mutations were made in /Users/r/repos/plenary. The only file written there is this report. Nothing was committed.

## Findings

| # | Grade | Finding |
|---|---|---|
| H1 | HIGH | Process identity depends on the caller's TZ and locale: `down` leaks everything, and a second `up` deletes a live rig's dir |
| M1 | MEDIUM | `stopRig`/`save` write to `rig.dir` from the file's contents, not to the `--dir` given |
| M2 | LOW | No test checks that Postgres, NATS and Caddy bind 127.0.0.1 only (3 mutations survive). Today all 7 sockets are on 127.0.0.1 |
| L1 | LOW | No test covers the SIGKILL escalation in `stopRig`, or the health-wait timeout path (both checked live, both work) |
| L2 | LOW | Node env (COOKIE_KEY, SESSION_KEY, PLENARY_DEV_TOKENS) is readable through `ps eww` by the same Unix user |
| L3 | LOW | lstart has one-second resolution, and there is a gap between the check and the signal (codex). Theoretical on macOS |
| L4 | LOW | SIGKILL of the postmaster after the 10 s grace may orphan backends (codex). Not verified |
| L5 | LOW | The secrets test scans stdout and stderr but not `logs/` (codex). I scanned the logs live and found none |

### H1: `isOurs` depends on TZ and locale (scripts/cluster-rig.js:63-76)

`psInfo` runs `ps -o stat= -o lstart=` with the caller's environment. `lstart` is local time in the caller's locale:

```
$ ps -o lstart= -p <pid>                              Thu Nov 12 13:55:14 2026
$ TZ=UTC ps -o lstart= -p <pid>                       Thu Nov 12 19:55:14 2026
$ LC_ALL=de_DE.UTF-8 ps -o lstart= -p <pid>           Do. 12 Nov. 13:55:14 2026
```

**Repro 1 (`down` leaks everything):**

```
$ TZ=UTC bun scripts/cluster-rig.js up --dir $R/tz --node-cmd "bun test/deploy/stub-node.js"   # up, 6 pids
$ bun scripts/cluster-rig.js down --dir $R/tz
rig down: stopped nothing; already gone: caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres
$ ps -o pid=,comm= -p <the 6 pids>        # all 6 still alive: postgres, nats-server, 3x bun, caddy
$ TZ=UTC bun scripts/cluster-rig.js down --dir $R/tz
rig down: stopped caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres          # none left
```

**Repro 2 (a second `up` deletes a live rig):** `up` started under `LC_ALL=de_DE.UTF-8` (pids 34300…34364). A second
`up --dir` on the same dir in the default locale succeeded. It found "nothing live", so it ran `rmSync(dir)` on the
running rig, which removed the Postgres data dir under a live postmaster. It then started a new rig and overwrote
rig.json. Afterwards all 6 old processes were still running, and no rig.json named them. I stopped them from a copy
of the old rig.json, under the old locale.

**Who hits this:** any `up`/`down` pair run from shells with different `TZ`/`LC_*`. Examples: a CI job or test
harness that sets `TZ=UTC`, a user locale that differs from an agent's, or a daylight-saving change between `up` and
`down` (not tested). `bun test` itself is not affected: its `Date` is UTC, but it does not pass `TZ` to the `ps` child,
which I checked.

**Fix (builder's):** call `ps` with a fixed env, for example `env: { PATH, LC_ALL: "C", TZ: "UTC" }`, in `psInfo`
(scripts/cluster-rig.js:65), and in the test helper that reads lstart (test/deploy/cluster-rig.test.js:111). Add a
test that starts a rig under `TZ=UTC` and stops it under another `TZ`. Without an identity check that does not depend
on locale, a different locale makes the guard fail open: it leaks processes and wipes the dir. It never kills a
foreign process.

### M1: `save()` writes to the dir named inside rig.json (scripts/cluster-rig.js:80-84, 311-329)

`stopRig("/some/dir")` reads `/some/dir/rig.json` but saves to `join(rig.dir, "rig.json")`, where `rig.dir` comes
from the file. A rig dir that was copied or moved (for example `mv .rig/a .rig/b`, or a saved copy of rig.json used
for cleanup) therefore writes over **another** rig's rig.json. That is how I hit it: `down --dir <copy of old
rig.json>` overwrote the live new rig's rig.json, so the new rig's 6 processes were no longer recorded. I found them
by their command line (my scratchpad path, start time 13:56:10, parent 1) and stopped exactly those 6 PIDs.

**Fix:** in `stopRig`, `rigStatus` and `killNode`, use the dir that was passed in, and set `rig.dir = dir` before
`save`. Or refuse when `rig.dir !== dir`.

### M2 (LOW): binding to loopback is not under test

Postgres `listen_addresses=127.0.0.1`, NATS `listen: 127.0.0.1:…` and Caddy `bind 127.0.0.1` are all correct today.
I checked the code and the generated configs, and `ps` showed `listen_addresses=127.0.0.1` on the live postmaster.
I checked the live sockets on a stub rig with `lsof -iTCP -sTCP:LISTEN` on the 6 recorded PIDs. All 7 sockets were on
127.0.0.1: postgres, nats ×2, 3 nodes and caddy. But the mutations `listen_addresses=*`, NATS `0.0.0.0` and removing
Caddy's `bind` each pass the whole suite (table below).
- **Postgres:** initdb's `pg_hba.conf` trusts only `local`, `127.0.0.1/32` and `::1/128`, so `listen_addresses=*` on
  its own would not admit the LAN.
- **NATS (no auth) and Caddy (in front of admin dev tokens):** binding to all interfaces would expose them.

It is a gap in the tests, not a live defect.
**Fix:** a test that reads each listening socket (`lsof -nP -iTCP:<port> -sTCP:LISTEN`, or NATS `/varz` `host`, plus
`show listen_addresses`) and expects 127.0.0.1.

### L1–L5

- **L1: two paths with no test.** The SIGKILL escalation (scripts/cluster-rig.js:320-325) has no test, because the
  stub exits on SIGTERM. The "not ready after the timeout" path has no test either. I ran the timeout live: a fake
  `caddy` that only sleeps, with `--timeout-ms 15000`, gave
  `lb (caddy): not ready after the timeout (log: …/caddy.log)`, and everything was stopped.
- **L2: env is visible to the same user.** `ps eww -p <node pid>` shows `COOKIE_KEY=…` (I printed only the name).
  This is the usual same-user exposure for env-passed secrets, fine for a local rig. RIG.md could say so.
- **L3: PID reuse inside one second (codex).** macOS assigns PIDs sequentially. Reusing a PID within the same second it
  was first started needs a full wrap of the PID space inside one second. The check-to-kill window is milliseconds.
  Theoretical.
- **L4: orphaned Postgres backends (codex, not verified).** This only matters after a fast shutdown that did not finish
  in 10 s. Postgres backends normally exit on their own when the postmaster dies. My live check of this was not run (the
  command was denied).
- **L5: logs are not scanned for secrets (codex).** Logs from my live rig with the real main.js: 6,567 bytes across 6
  files, and 0 of the 107 secrets (2 keys + 105 tokens) were found in them.

## Checks run (all in the copy)

### Teardown only-ours

- **PID reuse on a live rig:** I started a decoy `sleep 120` (PID 46732) and added
  `{name: "decoy", pid: 46732, started: <gw-1's recorded lstart>}` to a live real-main.js rig's rig.json. `down`
  printed `stopped caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres; already gone: decoy`. The decoy was still
  alive (I killed it myself afterwards). All 6 rig PIDs were gone and every rig port was free.
- **`down` after a SIGKILLed `up`:** this is covered by the builder's test "CLI: `up` SIGKILLed midway…", which passed
  in all 3 gate runs and fails under mutation b3.
- **`kill <node>`:** covered by the builder's tests, and mutation v9 below.

### Crash midway (fake binaries placed first on PATH; nodes are the stub)

For each case, the check script verified three things: no recorded PID alive, no rig port listening, and no process
whose command line names the rig dir.

| Step made to fail | Error from `up` (exit 1) | Left running |
|---|---|---|
| `initdb` exits 1 | `initdb failed (log: …/postgres.log)` | nothing (procs `[]`) |
| `postgres` exits 1 | `postgres: the process exited before it was ready (log: …)` | nothing |
| NATS port taken (a wrapper rewrites `listen` to a port I held, then `exec`s the real nats-server) | `nats: the process exited before it was ready (log: …/nats.log)` | nothing (postgres stopped) |
| `caddy` exits 1 | `lb (caddy): the process exited before it was ready` | nothing (5 stopped) |
| `caddy` never healthy (`exec sleep 300`, `--timeout-ms 15000`) | `lb (caddy): not ready after the timeout (log: …)` | nothing |
| SIGINT to `up` while waiting for Postgres (fake postgres = sleep) | `aborted while waiting for postgres` | nothing |
| SIGTERM to `up` while waiting for Caddy | `aborted while waiting for lb (caddy)` | nothing (6 stopped) |
| a node exits (`--die-if-role=host`) | builder's test; passed 3x | nothing |
| caddy missing | by reading the code: `missingBins()` refuses before anything starts (scripts/cluster-rig.js:167). Not run, because `/opt/homebrew/bin/caddy` is a fallback even when it is off PATH | n/a |

### Secrets

- **Not printed:** the builder's test covers stdout and stderr for up, status, status --json, kill, down and a failing
  up, and mutations b4 and b5 fail it.
- **Files:** rig.json holds only paths. keys.json and tokens.json are 0600 (mutation v1 fails the test). Logs are
  0600.
- **Logs from the real main.js:** contain none of the secrets (L5).
- **Node env:** only the contract env (the builder's test, and mutation b6). Secrets go by env, never argv: the `ps`
  command lines above show no secrets.

### Postgres, NATS and Caddy

- **Postgres:** `initdb --auth=trust` (pg_hba: loopback and local only), `listen_addresses=127.0.0.1`, Unix socket
  off. Live socket on 127.0.0.1.
- **NATS:** `listen 127.0.0.1`, `http 127.0.0.1`, `max_payload: 2MB` (the test checks `/varz` = 2097152; mutation v6
  fails it).
- **Caddy:** `admin off`, `bind 127.0.0.1`, `reverse_proxy` for every path, upstreams are gateways only (mutation v5
  fails the test).
- **Health waits:** real polls with the deadline checked every 100 ms: `select 1` for Postgres, `/healthz` for NATS,
  `/health` on each node, and `/health` through the LB. None is a sleep.

### Real server/main.js (`up --dir $R/real`, default 2 gateways + 1 host)

```
LB /health 200
POST /boards 201 board? true                         (admin token read from tokens.json, never printed)
ws#0: error(auth)
ws#1: welcome(owner) here entries ack(seq 1)          (through Caddy, landed on the gateway that holds the board)
ws#2: error(auth)
ws#3: welcome(owner) entries here error(stale-setting) (same op re-sent: expected)
```

`error(auth)` on every other socket is expected before p4-wire. Each node has its own SQLite registry, so the board
exists only on the gateway that served `POST /boards`. The node logs confirm this: the other gateway logged
`"msg":"hello refused","why":"board"`, and the board's own gateway logged `hello accepted … role owner` and
`room opened`. The cross-gateway hop is what the skipped e2e test is for.
main.js still reads none of `PLENARY_ROLES`, `PLENARY_NODE_ID` or `PLENARY_LEASE_TTL_MS` (checked by grep), so the
skip is still right.

```
BEFORE  45474 postgres -D …/rigs/real/pg …   45488 nats-server   45492/45494/45496 bun …/server/main.js   45506 caddy run
down    rig down: stopped caddy, node:host-1, node:gw-2, node:gw-1, nats, postgres; already gone: decoy
AFTER   ps -p 45474,45488,45492,45494,45496,45506 -> none left; every rig port free
```

### Compose

`podman compose -f deploy/cluster.compose.yml config` ran with dummy values for the 4 required variables and output
redirected to a file: exit 0.
- **Roles:** app-1 `gateway`, app-2 `gateway`, app-3 `host`.
- **Env:** `PLENARY_NODE_ID` app-1/2/3; `PLENARY_LEASE_TTL_MS` "10000" on all three; `NATS_URL` and `DATABASE_URL`
  set. These match engine's env contract names.
- **Header:** still says NOT FUNCTIONAL YET, and names exactly what main.js does not read yet (DATABASE_URL, NATS_URL,
  PLENARY_NODE_ID, PLENARY_ROLES, PLENARY_LEASE_TTL_MS, S3_*).
- **NATS:** deploy/cluster/nats.conf has `max_payload: 2MB`.
- **Caddyfile:** `caddy validate` on deploy/cluster/Caddyfile: `Valid configuration`.

### Mutations (copy only; each applied to scripts/cluster-rig.js from a saved original, then `bun test test/deploy`)

Each mutation was applied in the copy, `bun test test/deploy` was run, and the original was then restored.
Final `diff` against the saved original: clean. Results:

| Mutation | Result | Test that failed |
|---|---|---|
| b1 `isOurs` ignores the start time | **fails** (1) | "down and kill only signal a PID whose start time still matches…" |
| b2 no `stopRig` in `startRig`'s catch | **fails** (3) | "up failing midway…", "CLI: SIGTERM…", "CLI: keys and dev tokens…" |
| b3 `save()` skips while `starting` | **fails** (2) | "CLI: `up` SIGKILLed midway…", plus "up: env contract…" |
| b4 `status` prints a token | **fails** (1) | "CLI: keys and dev tokens never reach stdout or stderr…" |
| b5 `up` failure message includes keys.json | **fails** (1) | same |
| b6 `baseEnv` spreads `process.env` | **fails** (1) | "up: env contract on every node…" |
| b7 no abort check in `waitFor` | **fails** (1) | "CLI: SIGTERM (or Ctrl-C) during `up`…" |
| v1 keys/tokens files 0644 | **fails** (1) | "CLI: keys and dev tokens…" (the 0600 check) |
| v2 Postgres `listen_addresses=*` | **survives** (6 pass) | none (M2) |
| v3 NATS `listen: 0.0.0.0` | **survives** (6 pass) | none (M2) |
| v4 Caddy without `bind 127.0.0.1` | **survives** (6 pass) | none (M2) |
| v5 LB upstreams include the host-only node | **fails** (1) | "up: env contract… WebSocket through the LB reaches only gateways…" |
| v6 NATS `max_payload: 1MB` | **fails** (1) | "up: env contract…" (`/varz` check) |
| v7 no SIGKILL escalation in `stopRig` | **survives** (6 pass) | none (L1) |
| v8 `waitFor` ignores a dead process | **fails** (1) | "up failing midway…" |
| v9 `killNode` without the only-ours check | **fails** (2) | "up: env contract…" (kill twice), "down and kill only signal…" |

So the builder's 7 guards each fail a test. My 9 add three surviving mutations about binding (M2) and one about
SIGKILL escalation (L1).

**Orphan from my b3 run (not killed, for the manager):** nats-server **PID 53168**, parent 1, started Thu Nov 12
14:00:16 2026, config in the deleted temp dir `plenary-rig-TLFHiW`.
- **Points to me:** it started inside my b3 run (log times 14:00:13–14:02:18), and b3 leaks a NATS by design (the
  builder reported the same shape).
- **Not proven:** none of my logs name that temp dir, so I cannot rule out another session's test run.
- **What I did:** I did not stop it. **Please stop PID 53168** (and 62656, p8-rig's, still running at 14:07).

Any `sleep 300` from that run had already expired when I swept at about 14:07. I found no Postgres from it.

### sdd ensemble review

| Harness | Result |
|---|---|
| codex (effort high) | 2 MEDIUM, 2 LOW. Same-second PID reuse: theoretical, graded L3. Postgres children after SIGKILL: not verified, L4. Logs not scanned: L5. initdb untracked after SIGKILL of `up`: LOW, because initdb exits on its own when it finishes and is not a server. It missed H1. |
| agy | Failed: quota exhausted (`RESOURCE_EXHAUSTED`, resets in about 49 h). |
| grok (stand-in for agy) | 2 MEDIUM, 3 LOW, all refuted. Signal handlers accumulating: the CLI is a one-shot process. "No cleanup when aborted before the first waitFor": every launch is followed by a waitFor that checks the abort flag, and my SIGINT-during-Postgres run left nothing. "Secrets test passes if a single secret leaks": wrong, because it uses `filter(sec => all.includes(sec))`. |

Overlap: codex (initdb is untracked if `up` is SIGKILLed) and grok (abort before the first waitFor) both point at the
early-start window. Refuted for SIGINT and SIGTERM by my live run. For SIGKILL during initdb, initdb finishes and
exits on its own. That gives no HIGH candidate from agreement. H1 came from my own reading and was proven live; both
harnesses missed it.

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy (restored, `diff` clean) | 6 pass, 1 skip, 0 fail (6.33 s) |
| `bun test test/deploy` #2 | copy | 6 pass, 1 skip, 0 fail (6.40 s) |
| `bun test test/deploy` #3 | copy | 6 pass, 1 skip, 0 fail (6.46 s) |
| `bun test` (full) | /Users/r/repos/plenary, no mutations | 1415 pass, 153 skip, **1 fail**, 1569 tests across 83 files (179 s) |

**The one failure:** `test/core-source.test.js`, "packages/core is still herdr-draw's core". This is known drift and
not this job's. test/architecture.test.js now passes: the manager's `COMPOSITION_ROOTS` line for
scripts/cluster-rig.js works, and no scripts/load/* failure showed in this run.

**After the full run:** the only `plenary-rig-*` processes alive were PIDs 53168 and 62656, both from before it. The
full suite's rig tests left nothing behind.

## Distributed-systems-design (CHECKER)

The rig is test tooling, not a change to the system's design. The one part that bears on the design is that the rig
sets a single `PLENARY_LEASE_TTL_MS` for every node, which matches engine's contract. The default of 2 gateways + 1
host cannot exercise takeover, so the phase-4 check must use `--hosts 2`. RIG.md and compose both say so.

## Stray processes

Every rig I started directly was stopped, with its own `down` or by recorded PID. That includes the decoy, the port
holder, and the 6 that M1 orphaned, which I matched by command line in my scratchpad, start time 13:56:10 and
parent 1.
- **One possible exception:** nats-server PID 53168 (see Mutations). It is probably from my b3 run, but not proven, so
  I left it.
- **Not touched:** nats-server PID 62656 (p8-rig's, per the brief).

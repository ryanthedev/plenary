# Local cluster rig

`scripts/cluster-rig.js` runs a whole Plenary cluster natively on one Mac, with no containers: Postgres 17, NATS,
MinIO (an S3-compatible local object store), N node processes and a Caddy load balancer. It is meant for the M2 load test (~10k clients on 3 nodes) and for the
phase-4 takeover check ("kill a board's host, another host takes over, no acked op is lost").

**Status (2026-11-12):** the rig works and is tested, with stub nodes and with the real `server/main.js`, which since
p4-wire (7bf171b) runs in cluster mode on the env below (shared Postgres and NATS).

**Env rules the rig keeps (main.js since 7bf171b, with p4-wire2's checks; docs/m2/reports/p4-wire2.md):**
- **Every node sets `PLENARY_ROLES` explicitly** (`gateway` or `host`) and both URLs. main.js refuses to start, before
  it opens or listens on anything, when:
  - `DATABASE_URL` or `NATS_URL` is set but empty;
  - only one of the two URLs is set;
  - `PLENARY_ROLES` names anything but both roles while neither URL is set.
  A rig node therefore never falls back to a single node (SQLite, in-memory bus) running alone.
- **`PLENARY_NODE_ID` starts and ends with a letter or digit** (`gw-1`, `host-1`); it prefixes the node's lease holder.
- **NATS has no auth, by choice.** The bus now passes `user:pass@` (or `token@`) from `NATS_URL` to the NATS client
  (p4-wire2 fixed p4-wirev M1), so a password-protected NATS would work. The rig keeps its NATS without credentials
  because it listens only on 127.0.0.1, for one user's local runs. That is a choice, not a workaround.

## Needs

`brew install postgresql@17 nats-server minio caddy` (it uses `initdb`, `postgres`, `nats-server`, `minio` and `caddy`
from PATH or the standard Homebrew locations), plus Bun and `/bin/ps`. Debian/Ubuntu: `postgresql-17` needs the PGDG apt repo, `nats-server` and `caddy` come from apt, and MinIO has no apt
package (use the official binary from https://min.io/download). Missing binaries are reported with these install hints. No npm dependencies.

## Run

To run the gated tests by hand: `up --name mine --services-only`, export `env --name mine`, `bun test <file>`, `down --name mine --clean`.
Use services-only for this: a rig with nodes puts `gw-1`/`host-1` on the same NATS as the tests, and those nodes answer the
tests' remote opens (two sequencers per board), which fails `main-cluster.test.js`.

```sh
bun --no-env-file scripts/cluster-rig.js up                      # 2 gateways + 1 host, rig dir .rig/default/
bun --no-env-file scripts/cluster-rig.js up --hosts 2            # two room hosts: needed for the takeover check
bun --no-env-file scripts/cluster-rig.js status                  # PIDs, ports, LB URL, tokens file path
bun --no-env-file scripts/cluster-rig.js status --json           # the same, as JSON (rig.json plus `alive` flags)
bun --no-env-file scripts/cluster-rig.js kill host-1             # SIGKILL one node by its recorded PID
bun --no-env-file scripts/cluster-rig.js down                    # stop everything this rig started
bun --no-env-file scripts/cluster-rig.js ls                      # list live rigs of any name
bun --no-env-file scripts/cluster-rig.js up --services-only      # Postgres, NATS, MinIO only: use this to run tests by hand
bun --no-env-file scripts/cluster-rig.js env                     # print database, NATS and S3 test environment
bun --no-env-file scripts/cluster-rig.js down --all              # stop all rigs
bun --no-env-file scripts/cluster-rig.js down --clean            # stop and remove this rig directory
bun --no-env-file scripts/cluster-rig.js down --all --clean      # stop and remove all rig directories
bun --no-env-file scripts/cluster-rig.js gc                      # remove ANY unattached shared-memory segment of this user (not only the rig's)
bun run test:cluster                               # run all service-gated tests on a fresh rig
bun run test:fast                                   # run pure unit tests only
bun run test:full                                   # run all tests (same as bun test)
```

`up` flags: `--name <a-z0-9->` (rig dir `.rig/<name>/`), `--dir <path>`, `--gateways n` (default 2), `--hosts n`
(default 1), `--lease-ttl-ms n` (default 10000, the same on every node), `--max-conns-per-user n` (default 100000),
`--timeout-ms n` (default 60000, for the whole start), `--watch-parent <pid>` (abort and stop what started if that process dies), and `--node-cmd "<cmd> <args>"` to run something other than
`bun server/main.js` (the tests use a stub). `status`, `kill`, `env` and `down` take `--name` or `--dir` too. Missing rig
names fail with a suggestion when another rig exists. `status --json` contains the S3 endpoint, bucket and credentials;
`env` prints all S3 settings for the tests.

`up` returns once every part answers: Postgres runs `select 1`, NATS `/healthz`, every node's `/health`, and `/health`
through the LB. Then it exits; the processes keep running. If anything fails or times out, or `up` gets SIGINT
(Ctrl-C), SIGTERM or SIGHUP (a closed terminal), it starts nothing more and stops everything it had started and says which part failed and where its log is. `up` refuses a rig dir that still
has live processes (run `down` first), refuses while a postmaster that rig.json does not name still runs on its `pg/`
(stop that PID first), and refuses while another `up` is starting the same dir (`up.lock`). It refuses a non-empty dir that has no `rig.json`. It wipes the old state of
a stopped rig, so every `up` starts from an empty database.

## What runs

| Part | How | Env the nodes get |
|---|---|---|
| Postgres 17 | `postgres -D <rig>/pg`, TCP on 127.0.0.1 only, no Unix socket, trust auth, database `plenary`, max_connections 300 | `DATABASE_URL=postgres://postgres@127.0.0.1:<port>/plenary` |
| NATS | `nats-server` on 127.0.0.1, `max_payload: 2MB` (as deploy/cluster/nats.conf), monitor port for `/healthz` | `NATS_URL=nats://127.0.0.1:<port>` |
| MinIO | `minio server <rig>/blobs`, API and console on separate probed loopback ports; bucket `plenary` created with a signed S3 request | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Nodes | `bun server/main.js`, one per node, its cwd outside the repo (so Bun's `.env` auto-load never applies) | `PORT`, `HOST=127.0.0.1`, `PLENARY_DATA_DIR=<rig>/nodes/<id>/data`, `PLENARY_NODE_ID` (`gw-1`, `gw-2`, `host-1`, ...), `PLENARY_ROLES` (`gateway` or `host`), `PLENARY_LEASE_TTL_MS`, `COOKIE_KEY`, `SESSION_KEY`, `PLENARY_DEV_TOKENS`, `PLENARY_MAX_CONNS_PER_USER`, `LOG_LEVEL` |
| LB | `caddy run` with a generated Caddyfile in the shape of deploy/cluster/Caddyfile: gateways only, round robin, active `/health` checks, WebSocket-safe | |

The nodes get only the env above, plus PATH, HOME and LANG; nothing from your shell or the repo's `.env`. Every port
is probed free at start, so none is fixed.

Postgres is TCP-only because macOS limits Unix socket paths to 103 bytes, so a socket under a deep rig directory can fail.

`bun run test:cluster` starts a uniquely named services-only rig (`up --services-only`: Postgres, NATS and MinIO, no nodes and no Caddy, because the tests start their own nodes with the ids `gw-1`, `host-1`, ... on the same NATS), runs all test files gated by `DATABASE_URL`, `NATS_URL` or
`S3_ENDPOINT`, then stops the rig. Any skipped test fails the command. Green runs remove the rig directory; failed runs
keep it and print its path. SIGINT, SIGTERM and SIGHUP (also a terminal Ctrl-C, which reaches the whole foreground process group) stop the child test, then tear the services down; the rig helpers run in their own process groups, so `down` always finishes. (Starting a helper in its own group is not atomic with bun on macOS: a signal in that moment kills it before it runs. A `down` that died by a signal therefore never ran, and is run again, up to 20 times; it is idempotent.) `up` and `down` print straight to your terminal (live, in order); only `env` is captured.

Exit codes: a signal that arrives after the tests passed still makes the run exit 1 (an interrupted run is never green),
and it says so: `[test:cluster] tests passed, but SIGINT arrived before the run finished: exit 1`. An interrupted run
keeps its rig dir (state `down`) unless it was already green when teardown started.

After a `SIGKILL` of `test:cluster` itself (nothing can catch it): the `up` helper watches its parent (`up
--watch-parent <pid>`) and stops what it started, but services of a run that was already testing are left running.
The next `bun run test:cluster` reaps every `test-<pid>-<hash>` rig whose owner is gone: its pid is dead, or reused by another process (the owner's start time is recorded beside the rig dir, in `test-<pid>-<hash>.owner`) (never a live run's rig: when `ps` cannot answer, the rig is left alone, and after a Ctrl-C during the reap no more `ps` runs, so only rigs whose owner pid is dead are still reaped; the owner record is written by temp file and rename, never seen empty; never
another name). To recover by hand: `bun run rig ls` lists live rigs, then `bun run rig down --name <name> --clean`.

### Cleaning up

`bun run clean` (a dry run: it lists what it would remove and the bytes, then a one-line total) and `bun run clean --yes`
(removes it) clear what test, load and rig runs leave behind, so the disk does not fill. Options: `--min-age 2h` (the default;
`90m`, `1d`), `--scratch <dir>` (also clear that dir's direct children, e.g. an agent's scratch copies), `--verbose`
(list kept entries and why). Three targets, each removed only when provably not in use, and kept on any doubt:

- the temp dir's `plenary-*`, `plen-*` and `pl-reg-*` entries (`plen-run-<pid>-*` roots also need a dead owner: `owner.json`'s `pid`, else the
  pid in the name), idle for `--min-age` (the newest mtime in the tree) with no process holding a file or its cwd inside (one `lsof`;
  an `lsof` that fails keeps everything);
- stopped rigs: this repo's `.rig/<name>` dirs whose processes are all gone, by this CLI's own `status` (a `ps` that fails reads as alive,
  so the rig stays); a dir touched in the last minute or without a `rig.json` is skipped. Other worktrees' `.rig` dirs are not touched:
  run it there;
- `--scratch <dir>`: the same age and in-use rules.

Symlinks are never followed (a symlinked entry is skipped), nothing outside those three places is touched, and a base that resolves
to `/` or `$HOME` is refused.

The gated files are
`test/server/pg-store`, `pg-registry`, `nats-bus`, `room-host-lease`, `room-host-proc`, `main-cluster`, `s3-blobs`,
and `test/admin/tenants`.

## Files in the rig dir

| File | What |
|---|---|
| `rig.json` | Everything the rig started and where, including local MinIO credentials. It is rewritten after every spawn, so `down` works even if `up` was killed. |
| `tokens.json` (0600) | Dev tokens, in `PLENARY_DEV_TOKENS` format: `{ "<token>": { name, role, domain, admin? } }`. One owner `rig-admin` with `admin: true`; editors `editor-1..8`, annotators `annotator-1..32`, viewers `viewer-1..64`. Every one has domain `rig.test`. |
| `keys.json` (0600) | `COOKIE_KEY` and `SESSION_KEY`, generated per rig and shared by every node. |
| `logs/<part>.log` | One log per process (`postgres`, `nats`, `minio`, `gw-1`, ..., `caddy`). |
| `blobs/` | MinIO object data for the local S3 bucket. |
| `up.lock` | Present only while an `up` runs: `{ pid, started }` of that `up`. A lock whose `up` is gone is cleared by the next `up`. |
| `up.lock.break` | Present only for the instant an `up` clears a stale `up.lock`. If one is left (that `up` died right then), every `up` refuses and names it: remove it once no `up` runs on the dir. |
| `pg/`, `nats.conf`, `Caddyfile`, `nodes/<id>/data/`, `caddy/` | State and generated config. |

The rig never prints cookie/session keys or dev tokens. MinIO credentials are generated per rig (random, stored in rig.json, which is 0600), never printed by `up` or
`status`, and available through `env` for tests; do not put production credentials in this rig.

### rig.json (version 1, stable; the load client in scripts/load/ reads it)

```
{ version: 1, name, dir, startedClock: "lstart TZ=UTC LC_ALL=C", state: "starting" | "up" | "failed" | "down", createdAt, leaseTtlMs, maxConnsPerUser,
  lb: { url, wsUrl, port }, blobs: { url, bucket, accessKey, secretKey, consolePort }, tokensFile, keysFile, logsDir,
  postgres: { port, url }, nats: { port, url, monitorPort },
  nodes: [{ id, roles, port, url, dataDir, log }],
  procs: [{ name: "postgres" | "nats" | "minio" | "node:<id>" | "caddy", pid, started, log }] }
```

Paths inside the rig dir (`tokensFile`, `keysFile`, `logsDir`, `nodes[].dataDir`, `nodes[].log`, `procs[].log`) are
stored **relative to the rig dir** (e.g. `"tokensFile": "tokens.json"`), so a moved rig dir still names its own files;
resolve them against the dir you read rig.json from (scripts/load/run.js already does). `status --json` and `startRig`
give them absolute. A file from before 2026-11-12's p8-rig3 has absolute paths; they are rebased onto the dir given.

`status --json` adds `alive` to every `procs` entry, and `pid` and `alive` to every `nodes` entry.

For a load client: connect to `lb.wsUrl`. Create a board through `lb.url` with `POST /boards` and
`Authorization: Bearer <rig-admin's token>`. Because every token is in domain `rig.test`, a board's `memberRole`
admits all of them. Raise roles with `PUT /boards/:board/grants/dev%3A<name>`.

## Safety

- **Only ours:** every PID in `rig.json` is stored with its start time (`ps -o lstart=`). `down` and `kill` signal a
  PID only while that start time still matches, so a reused PID is never touched. Nothing is killed by name.
- **Any TZ or locale:** `ps` always runs with `TZ=UTC LC_ALL=C`, so `up`, `status`, `kill` and `down` agree whatever
  shell, CI job or daylight-saving change sits between them (`startedClock` in rig.json records this). A rig.json from
  before this fix has no `startedClock`; its times are in an unknown local TZ and cannot be converted, so every command
  refuses it while any of its PIDs exists and names those PIDs. Check each with
  `LC_ALL=C TZ=UTC /bin/ps -o lstart=,command= -p <pid>`, stop the ones that are the rig's, then remove the dir.
- **A broken `ps` refuses, never guesses:** `ps` runs as `/bin/ps`, whatever PATH says. If it cannot run, is killed,
  exits with an error or prints something unexpected, or cannot see the rig's own process, every command refuses with
  `cannot check processes: …` before it signals or removes anything. The one exception is a `ps` killed by SIGINT,
  SIGTERM or SIGHUP: it shares its caller's process group, so a terminal Ctrl-C kills it too, and it is run again (up to
  5 times) so that `down`, which ignores those signals, still finishes. When `up` fails for any reason, it stops what
  rig.json records and then, always, every process it started through its own child handles, which need no `ps`: a
  `ps` that fails once right after a spawn and then works again leaves that process unrecorded, and only the handle
  knows it. A save of rig.json that fails (disk full, permissions) does not skip that cleanup.
- **One `up` per dir:** `up` takes `<dir>/up.lock` (created atomically, holding its PID and start time) before it
  reads or wipes anything, and removes it when it returns (only if it still holds its own content). A second `up`
  meanwhile refuses. A stale lock (its `up` is gone) is cleared only under `<dir>/up.lock.break`, taken exclusively,
  and only while `up.lock` still holds exactly the text judged stale; a live or left-over break lock refuses. So any
  number of `up`s racing for a stale lock end with at most one holder. `down`, `status` and
  `kill` do not take the lock, so `down` can still stop a hung `up`'s processes.
- **The dir you name:** `--dir`/`--name` decide which rig.json is read and written, never the `dir` inside the file.
  A copied or moved rig.json is updated where it is, so it never overwrites another rig's record.
- **Shutdown order:** `down` goes in reverse start order (LB, nodes, MinIO, NATS, Postgres). It sends SIGTERM, or SIGINT to
  Postgres for a fast shutdown, then SIGKILL after 10 s.
- **No leaks from a failed or killed run:** a failed `up`, or one stopped by SIGINT, SIGTERM or SIGHUP, stops what
  it started before it exits. Only a SIGKILLed `up` leaves processes; they are in rig.json, so `down` stops them. The
  tests share test/deploy/rig-guard.js: `afterAll` and SIGINT/SIGTERM/SIGHUP to the test runner abort in-flight `up`s,
  stop tracked CLI children, then stop every rig dir by recorded PID (with the test's own `/bin/ps` check as a
  fallback) before removing the dirs. Tests kill an `up` with each signal, and kill a whole `bun test` run midway, and
  check that nothing tied to the rig dir remains. A SIGKILL of the test runner itself is not covered.
- **Stray state:** state stays under `.rig/` (git-ignored). Nothing listens beyond 127.0.0.1 (a test checks every
  listening socket).

### Known limits

- **Env is visible to your own user.** Nodes get `COOKIE_KEY`, `SESSION_KEY` and `PLENARY_DEV_TOKENS` by env, so
  `ps eww` run as the same Unix user shows them. Fine for a local rig; never point one at real keys.
- **Start times have one-second resolution.** A PID reused within the same second as the original start, between the
  check and the signal, would pass. On macOS that needs the PID space to wrap in under a second.
- **`up` killed between a spawn and its save.** rig.json is saved right after each spawn; a SIGKILL of `up` in that
  gap (microseconds) leaves one process `down` does not know. Find it by its command line, which names the rig dir
  (stub nodes excepted).
- **A left-over `up.lock.break`.** An `up` killed in the microseconds while it clears a stale lock leaves
  `up.lock.break`; every later `up` refuses and names it until you remove it. Never cleared automatically, because
  clearing it safely would need the same race-free takeover one level up.
- **SIGKILL of Postgres.** If Postgres does not finish a fast shutdown within 10 s, `down` SIGKILLs the postmaster;
  its backends normally exit on their own after that (not tested with a real Postgres). A SIGKILLed postmaster leaves
  its SysV shared-memory segment behind, and macOS allows only 32 (`kern.sysv.shmmni`); when they run out, no Postgres
  on the machine starts (`initdb`: "could not create shared memory segment: No space left on device"). So whoever
  SIGKILLs a postmaster (`down`, a failed `up`'s fallback, the tests' rig-guard) reads its segment from line 7 of
  `pg/postmaster.pid` first and, once it is gone, removes exactly that segment with `ipcrm -m <id>`, only if `ipcs`
  lists that id with that key and NATTCH 0. A backend still attached when the postmaster died is waited for (up to
  5 s, re-checking id, key and NATTCH each time); a segment still attached after that is kept. Segments orphaned by anything else (a SIGKILLed `up` plus a SIGKILLed
  postmaster) are not cleaned up: check with `ipcs -m`.
- **Manual shared-memory cleanup.** `gc` parses `ipcs -m -o` and removes only current-user segments with `NATTCH 0`;
  attached segments and segments owned by other users are never removed.

## Tests

`bun test test/deploy` uses real Postgres, NATS and Caddy, with stub nodes (test/deploy/stub-node.js). The tests skip
with a reason if a binary is missing. One end-to-end test runs the real main.js (hello over the LB, an op acked, the
entry seen from the other gateway).

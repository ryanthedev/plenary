# Report: p8-deps (image installs the lockfile; CI gets an S3 store)

Done. Not committed (manager commits after engine's commit with package.json and bun.lock).

## What changed

| File | Change |
|---|---|
| `deploy/Dockerfile` | Copies `package.json` + `bun.lock` first, then `RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache bun install --frozen-lockfile --production && rm -rf /tmp/bun-install-cache`, then copies `packages/`, `server/`, `web/` by name. The install runs as root, so `node_modules` is root-owned and read-only to the `bun` user. The cache is removed in the same layer, so it never ships. |
| `.dockerignore` | No rule change: `bun.lock` was not excluded, `**/node_modules` already was. Comments now say five copied paths and that `bun.lock` must never be listed. |
| `.github/workflows/ci.yml` | (1) Both jobs: install is now unconditional, `bun install --frozen-lockfile`, and fails with a message if `bun.lock` is missing (was "skip if no lockfile"). (2) `test-cluster-services`: job env gains `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_BUCKET=plenary-ci`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID=plenary-ci-only`, `S3_SECRET_ACCESS_KEY=plenary-ci-only-secret`, each commented as a throwaway CI-only value. (3) New step "Start blob store (pgsty/minio) and create the bucket": `docker run -d --rm -p 127.0.0.1:9000:9000` of `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (same tag as `cluster.compose.yml`), container id recorded in `BLOBS_CONTAINER_ID` before any wait, 30 s health wait (`curl /minio/health/live` inside the container), then a 30 s retry loop of `mc alias set` + `mc mb --ignore-existing` + `mc stat` on the bucket; fails with logs if either wait runs out. (4) New `Stop blob store` step (`if: always()`), stops only the recorded id. Old TODO comment replaced. |
| `deploy/README.md` | Dockerfile row and "Image" bullet mention `bun.lock` and the frozen install; CI paragraph describes the frozen install and the blob-store step. |

No tests added: no test file is mine. Checks below were run in the scratchpad.

## How I checked it

- **YAML parses** (`Bun.YAML.parse`); the cluster job's steps are, in order: checkout, setup-bun, Install, Start NATS,
  Start blob store, Test, Stop NATS, Stop blob store. The job env holds all five `S3_*`.
- **Blob step against a stub `docker`** (the step's `run` extracted from the parsed YAML, run with `bash -e`,
  stub `sleep`):

  | Scenario | Exit | Result |
  |---|---|---|
  | ok | 0 | "Blob store up (cid123), bucket plenary-ci exists." 5 docker calls |
  | store never healthy | 1 | "Blob store did not become healthy in 30 s." + logs; 30 health tries; id already in `GITHUB_ENV` |
  | bucket never appears | 1 | "Bucket plenary-ci did not appear in 30 s." + logs; 30 `mc stat` tries |
  | bucket appears on 4th try | 0 | waits, then succeeds |

  The `docker run` the stub saw: `-p 127.0.0.1:9000:9000 -e MINIO_ROOT_USER=plenary-ci-only -e MINIO_ROOT_PASSWORD=plenary-ci-only-secret pgsty/minio:RELEASE.2026-08-04T00-00-00Z minio server /data`.
- **Image simulated:** scratch dir with only `package.json`, `bun.lock`, then `packages/`, `server/`, `web/` (copied
  with `node_modules`, `.env*`, databases excluded). `bun install --frozen-lockfile --production` with a throwaway
  cache dir: 5 packages (`@nats-io/{transport-node,nats-core,nkeys,nuid}`, `tweetnacl`), `bun.lock` byte-identical
  after. `server/main.js` on `PORT=0`: `GET /health` returned 200 `{"ok":true,...}`; stopped by its PID with SIGTERM,
  log shows "server stopped". `@nats-io/transport-node` resolves from the copy's own `node_modules`.
- **CI-form install** (plain `bun install --frozen-lockfile`, clean copy): exit 0, `bun.lock` unchanged.
- **`bun test`:** 315 pass, 69 skip, 0 fail.
- **Tree:** only my four files and this report changed. `package.json` (already modified by engine) and `bun.lock`
  (untracked, engine's) were read, not edited.
- **herdr-draw clone and NATS steps:** unchanged text. The install now runs before them; it writes only `node_modules`
  in the workspace, which neither touches.

## Not verified

- **Nothing ran in Docker or on GitHub** (no Docker here). Not run: the real `docker build`, the real MinIO container,
  `mc stat` on a bucket in this image's `mc` version, and engine's S3 tests against a real store.
- **`BUN_INSTALL_CACHE_DIR` inside the image** was honoured locally (the cache landed in the dir I named and was
  removed), not in the `oven/bun:1.4.4-slim` image.
- **`main.js` does not wire NATS, Postgres or S3 yet**, so `/health` proves the install and the start only. Covered
  separately: every `server/**/*.js` except `main.js` imports cleanly from the scratch image. The only non-builtin
  import in `server/` is `@nats-io/transport-node`, loaded lazily (`server/bus/nats.js:81`, so a module import alone
  would not catch it), and it resolves from the image's own `node_modules`. Postgres and S3 use Bun built-ins (`"bun"`).
- **The bucket wait runs inside the container** (`docker exec … mc stat`). No step tries the published
  `127.0.0.1:9000` path that Bun's S3 client uses before `bun test` (same pattern as the NATS step).

## Risks

- **`mc stat` on a bucket:** if this fork's `mc` refuses `stat` on a bare bucket, the bucket wait fails every time
  and the job fails loudly (not silently). Fallback: `mc ls "ci/$S3_BUCKET"`.
- **Port 9000 on the runner** is fixed, as NATS's 4222 is. A hosted runner is a fresh VM, so a clash is unlikely.
- **`pgsty/minio` is a community fork that stopped tagging** (see p8-cluster-envv L2); CI now depends on that tag too.
- **Frozen install fails the build** if engine lands package.json without a matching bun.lock. That is the intent.

## Fix round (from p8-depsv)

**M1 fixed; L2 fixed; L3 kept on purpose.** Only `.github/workflows/ci.yml` changed. Not committed.

### What changed

- **M1, hung `docker exec`:** every `docker exec` and `docker logs` in the NATS and blob-store steps now runs as
  `timeout 10 docker …` on the runner. Seven `docker exec` calls in total; none is left unwrapped. A timeout
  (exit 124) counts as a failed try.
- **Waits are a 60 s deadline, not 30 tries:** each loop runs `while [ "$SECONDS" -lt "$deadline" ]`. A try count
  would multiply with the per-call timeout (30 × 3 calls × 10 s = 15 min for the bucket loop). A deadline keeps the
  bound fixed.
  - **Worst case, blob step:** about 60 + 10 + 1 (health) + 60 + 30 + 1 (bucket) + 10 (logs), so about 3 minutes.
  - **Worst case, NATS step:** about 60 + 10 + 1 + 10 (varz) + 10 (logs), so about 1.5 minutes.
  - Failure messages now say "in 60 s".
- **L2, logs lost on a crash:** both containers now start without `--rm`, so `docker logs` still works if the process
  exits on its own. "Stop NATS" and "Stop blob store" run `docker stop "$ID"` then `docker rm "$ID"`, on the recorded
  id only, and do nothing when no id was recorded.
- **L3, root-owned `node_modules`:** unchanged. It is deliberate (the app can't rewrite its own deps), documented in
  the Dockerfile, and no current dep writes there.

### How I checked it

- **YAML re-parsed** (`Bun.YAML.parse`); cluster-job step order unchanged.
- **Both steps against a stub `docker`**, run in parallel with real `sleep` and GNU `timeout` (`gtimeout`, as on
  ubuntu-latest). "hang" means the stub's `docker exec` never returns.

  | Step / scenario | Exit | Time | Note |
  |---|---|---|---|
  | NATS ok | 0 | 1 s | "max_payload 2097152" |
  | NATS never healthy | 1 | 61 s | message + logs |
  | NATS every exec hangs | 1 | 67 s | was: hung until the job timeout |
  | NATS exec and logs both hang | 1 | 77 s | "did not become healthy in 60 s" |
  | blobs ok | 0 | 1 s | bucket exists |
  | blobs bucket on 4th try | 0 | 3 s | waits, then succeeds |
  | blobs never healthy | 1 | 61 s | message + logs |
  | blobs bucket never appears | 1 | 60 s | message + logs |
  | blobs every exec hangs | 1 | 67 s | was: hung until the job timeout |
  | blobs only `mc stat` hangs | 1 | 66 s | health passed; bucket loop times out |
  | blobs exec and logs both hang | 1 | 76 s | "did not become healthy in 60 s" |

  Every run wrote the container id to `GITHUB_ENV` before waiting, so the stop step still runs.
- **Stop step** (extracted, stub): with an id it ran `docker stop cid123` then `docker rm cid123`, exit 0; with no id
  it made no calls, exit 0.
- **`bun test`:** 315 pass, 69 skip, 0 fail.

### Not verified

- **Still no Docker or GitHub run.** Real `timeout` killing a real `docker exec` was not observed. On Linux, `timeout`
  kills the docker CLI; the process inside the container may keep running, which is harmless because the step then
  fails and the container is stopped and removed.
- **`docker run` itself has no timeout** (an image pull can stall). The job's 15-minute timeout still bounds it.

# Report: p8-depsv (verify p8-deps: lockfile in the image, S3 store in CI)

**PASS.** No HIGH findings. One MEDIUM (a single stuck call in the blob-store step is capped only by the job
timeout) and two LOW. Nothing committed; only this report was written in the repo (everything else lives in the
session scratchpad).

## Findings

### HIGH

None. No secret, nothing published, no broken existing CI step, and the simulated image loads its deps. No CI step
can pass falsely.

**The rubric's "can hang" item, graded explicitly:** M1 is a hang, but I grade it MEDIUM, not HIGH, because:

- **Both loops are bounded:** 30 tries each.
- **Only one call can hang:** the risk is a single `docker exec` that never returns, and there is no known trigger
  for that.
- **The job timeout caps it:** `timeout-minutes: 15` ends the job, so it fails red and never passes.
- **NATS has the same pattern:** the existing NATS step, already accepted, does the same thing.

### MEDIUM

- **M1. A stuck `docker exec` blocks the step until the 15-minute job timeout** (`.github/workflows/ci.yml`,
  "Start blob store" step).
  - **Why:** each `curl`/`mc` call inside the two 30-try loops has no timeout of its own.
  - **Shown:** in a stub scenario where `docker exec` never returns, the step stayed on the first health call until
    an outer 6 s alarm killed it (exit 142).
  - **Fix:** put the timeout on the runner side, for example `timeout 10 docker exec …` for each call. Don't rely on
    `timeout` inside the minio image, which is unverified. `curl --max-time 3` covers the health call only.
  - **Optional:** the same change for the NATS step.

### LOW

- **L2. Logs may be lost when the store crashes** (same step). The container runs with `--rm`, so if MinIO exits on
  its own, `docker logs "$cid"` finds nothing. `|| true` keeps the step's failure message intact, so this only
  costs diagnostics.
- **L3. `node_modules` in the image is root-owned and read-only to `bun`** (`deploy/Dockerfile`, install layer).
  This is deliberate and documented in the Dockerfile. The current deps (`@nats-io/*`, `tweetnacl`) are plain JS
  and write nothing at runtime. Grok rated this MEDIUM; I grade it LOW (see the ensemble section).

## Image simulation

Built in the scratchpad from the same five paths the Dockerfile COPYs. The `.dockerignore` rules were applied by
hand (`node_modules`, `.DS_Store`, `.env*` and database files excluded), not by Docker. Steps:

1. **Manifests:** copied only `package.json` and `bun.lock`.
2. **Install:** ran `bun install --frozen-lockfile --production` with `BUN_INSTALL_CACHE_DIR` set to a scratch dir.
   - Result: exit 0, 5 packages (`@nats-io/{transport-node,nats-core,nkeys,nuid}`, `tweetnacl`).
   - `bun.lock` was byte-identical afterwards (sha1 `5151151f…`).
   - The cache landed in the named dir, so Bun honours `BUN_INSTALL_CACHE_DIR` locally.
3. **Source:** copied `packages/`, `server/` and `web/` with the ignore rules applied.
   - Nothing could leak today: a `find` under those three paths found none of the excluded kinds (`node_modules`,
     `.env*`, `.envrc`, databases, `*.pem`, `*.key`, `id_*`, credential files).
   - The root-anchored `data` and `blobs` rules do not match `server/blobs/`, which is how that source directory
     (the S3 and disk adapters) reaches the image. That is correct.
   - The only `node_modules` in the copy came from the install.
4. **Resolution:** checked from `server/bus`. `@nats-io/transport-node` resolves to the copy's own
   `node_modules/@nats-io/transport-node/index.js` (inside the image dir, not the host), and `connect` is a function.
   - All 23 `server/**/*.js` modules other than `main.js` import cleanly.
5. **Start:** ran `server/main.js` with `PORT=0`, `HOST=127.0.0.1` and a scratch `PLENARY_DATA_DIR` (recorded PID
   49953).
   - `GET /health` returned 200 `{"ok":true,…}`.
   - SIGTERM to that PID stopped it, and the log ends with "server stopped".
   - `main.js` writes only under `PLENARY_DATA_DIR` (`/data` in the image, owned by `bun`), so the read-only `/app` is
     fine.

**Frozen-install failure modes:**

- **Mismatch:** `package.json` pinned to 3.3.0 against the 3.4.0 lock makes the install exit 1 ("dependencies in
  package.json changed since bun.lock was saved").
- **Missing lock:** the CI Install script, extracted from the YAML, exits 1 with "bun.lock is missing" when there is
  no `bun.lock`.
- **Both jobs:** the two Install scripts are identical.

## CI blob-store step against a stub `docker`

The step's `run` was extracted from the parsed YAML and run with `bash -e`, with a stub `docker` and a stub `sleep`.

| Scenario | Exit | Result |
|---|---|---|
| ok | 0 | "Blob store up (cid123), bucket plenary-ci exists.", 5 docker calls |
| never healthy | 1 | "did not become healthy in 30 s" + logs, 30 tries; id already in `GITHUB_ENV` |
| bucket never appears | 1 | "Bucket plenary-ci did not appear in 30 s" + logs, 30 tries |
| `mc stat` refused on a bare bucket | 1 | Same loud failure after 30 tries, so no false pass |
| `mc alias set` fails | 1 | Same loud failure (the `&&` chain short-circuits) |
| bucket appears on try 4 | 0 | Waits 3 s, then succeeds |
| `docker run` fails (pull denied) | 125 | Exits at once; no id written, so the stop step does nothing |
| `docker exec` never returns | killed | Step stays on the first health call until an outer 6 s alarm kills it (M1) |

- **`docker run` arguments:** `-p 127.0.0.1:9000:9000`, root user and password taken from the `S3_*` job env, and
  `pgsty/minio:RELEASE.2026-08-04T00-00-00Z minio server /data`. The tag equals `deploy/cluster.compose.yml:100,117`.
- **Stop step:** `docker stop cid123` with the recorded id only, and a no-op exit 0 when no id was recorded.
  `if: always()` is set.
- **Pipes:** the step has none, so `pipefail` cannot hide a failure.
- **Hangs:** a hang inside a single call is bounded only by the job timeout (M1).

## Secrets and YAML

- **YAML parses** (`Bun.YAML.parse`). The cluster job's steps, in order: checkout, setup-bun, Install, Start NATS,
  Start blob store, Test, Stop NATS, Stop blob store.
- **No `${{ }}` inside any `run:`** (0 matches across both jobs).
- **The five `S3_*` values are throwaway literals**, each commented as CI-only, and the store is published on
  loopback only. Nothing real is stored; the only existing literal is the CI Postgres password.
- **Env names match:** they are exactly what `test/server/s3-blobs.test.js:13` reads.
- **Addressing is path-style (verified):** I pointed `s3Blobs` with the CI values at a local `Bun.serve` on port 0.
  A `get` requested `http://127.0.0.1:<port>/plenary-ci/t1/<sha1>` with `Host: 127.0.0.1:<port>`: the bucket is in
  the path, not the hostname, which is what MinIO on loopback needs.

## Existing CI steps

These steps are unchanged in text, confirmed by the diff: the herdr-draw clone, the NATS start with its 2 MB
`max_payload` check, the Postgres service and the Test steps. The Install step now always runs before them and writes
only `node_modules` in the workspace, which none of them reads. Nothing ran on GitHub.

## `bun test`

315 pass, 69 skip, 0 fail (384 tests, 24 files). The repo held an installed `node_modules`
(`@nats-io`, `tweetnacl`) during the run, the same shape as CI after its install step.

## sdd ensemble review

- **Usage:** codex at 3% of its 5-hour window and 6% weekly.
- **`check_adapter` results:**
  - `codex`: ok.
  - `grok`: ok.
  - `agy`: failed (quota exhausted, resets in about 67 h).
  - `kimi`: failed (no model configured).
  - `mistral`: failed (no `MISTRAL_API_KEY`).
  - `qwen`: not installed.
- **Ran:** codex (effort high) and grok. Each ran in its own scratch copy of the repo with the diff, so neither could
  touch the real tree.
- **codex:** "No actionable findings."
- **grok:** no HIGH findings.
  - MEDIUM, retry loops "can hang up to ~60 s": **refuted as stated.** The loops are bounded at 30 tries each and
    fail loudly. The real risk is a single stuck call, which I found separately and graded MEDIUM (M1).
  - MEDIUM, root-owned `node_modules`: **downgraded to LOW (L3).** It is intentional, and no current dep writes
    there.
  - LOW, mc alias name `ci` vs `local` in compose: **refuted.** The alias exists only inside the throwaway
    container.
  - LOW, future writes under `/app`: **refuted.** Speculative; nothing writes there today.
  - LOW, env names: **confirmed as correct** (not a defect).
- **Agreement:** no finding was reported by two harnesses, so there was no HIGH candidate.

## Not verified (same limits as the builder)

- **No Docker here:** no real `docker build`, no real `oven/bun:1.4.4-slim` behaviour for `BUN_INSTALL_CACHE_DIR`,
  and no real `pgsty/minio` container. In particular, whether this fork's `mc stat` accepts a bare bucket is
  unverified. If it refuses, the job fails loudly; it never passes falsely.
- **Nothing ran on GitHub.**
- **`/health` proves install and start only.** `main.js` does not wire NATS, Postgres or S3 yet.

## Re-check (after the fix round in docs/m2/reports/p8-deps.md)

**PASS.** M1 and L2 are fixed, and L3 stays LOW, kept on purpose. There are no new findings. Only
`.github/workflows/ci.yml` changed: the `.dockerignore`, `deploy/Dockerfile` and `deploy/README.md` diffs are
byte-identical to the ones I verified, so the image simulation above still holds.

### M1 (stuck `docker exec`): fixed

- **Every call is wrapped:** all 7 `docker exec` calls and both `docker logs` calls run as `timeout 10 docker …`. A
  grep finds no unwrapped call outside comments.
- **Waits use a 60 s deadline** (`$SECONDS`) instead of a try count, so the per-call timeout can't multiply the bound.
- **How I tested it:** both steps, extracted from the parsed YAML, ran against a stub `docker` with real `sleep` and
  GNU `timeout`. On macOS that is `gtimeout`, linked onto PATH as `timeout`, as on ubuntu-latest. "hang" means the
  stub's `docker exec` never returns.

| Step | Scenario | Exit | Time | Message |
|---|---|---|---|---|
| NATS | ok | 0 | 0 s | "max_payload 2097152" |
| NATS | every exec hangs | 1 | 67 s | "did not become healthy in 60 s" |
| NATS | every exec and `logs` hang | 1 | 77 s | same |
| NATS | slow but working (5 s per exec) | 0 | 10 s | passes |
| NATS | every exec takes 11 s | 1 | 67 s | fails: over the 10 s per-call limit (intended) |
| NATS | never healthy | 1 | 60 s | message + logs |
| NATS | healthy on try 4 | 0 | 3 s | passes |
| blobs | ok | 0 | 0 s | bucket exists |
| blobs | every exec hangs | 1 | 67 s | "did not become healthy in 60 s" |
| blobs | every exec and `logs` hang | 1 | 77 s | same |
| blobs | only `mc stat` hangs | 1 | 68 s | "Bucket plenary-ci did not appear in 60 s" |
| blobs | slow but working (5 s per exec) | 0 | 20 s | passes |
| blobs | every exec takes 11 s | 1 | 67 s | fails (intended, as above) |
| blobs | never healthy | 1 | 60 s | message + logs |
| blobs | bucket never appears | 1 | 60 s | message + logs |
| blobs | bucket on try 4 | 0 | 4 s | passes |

- **Bounds:** every failure ended well inside the stated bounds (about 90 s for NATS, about 170 s for blobs) and far
  inside the 15-minute job timeout. No run passed falsely.
- **Container id:** every run wrote it to `GITHUB_ENV` before waiting.
- **Nothing left running:** no stub process survived the 16 parallel runs (`ps` found no `sleep 3601`). GNU `timeout`
  killed each stuck call's whole process group.

### L2 (logs lost on a crash): fixed

- **Logs survive a crash:** both containers start without `--rm` (`grep 'docker run -d --rm'` finds 0).
- **Stop steps, run against the stub with `if: always()` kept:**
  - With an id: `docker stop cid123` then `docker rm cid123`, exit 0.
  - With no id: no calls, exit 0.
  - Only the recorded id is touched.

### L3 (root-owned `node_modules`): unchanged, still LOW

It is deliberate and documented, and no current dependency writes there.

### New LOWs (non-blocking, for the record)

- **A slow call counts as a failed try:** any single container call that legitimately takes more than 10 s is
  retried. The step fails only if that happens on every try for 60 s, so a slow store fails red and never passes
  falsely.
- **`docker run` has no per-call timeout:** a stalled image pull is still bounded only by the job timeout. The
  builder listed this; it can't pass falsely.
- **Stop steps don't always remove the container:** they run under `bash -e`, so a failed `docker stop` skips
  `docker rm`. That is harmless on a throwaway hosted runner.

### YAML and tests

- **YAML parses:** cluster-job step order unchanged; both stop steps keep `if: always()`; no `${{ }}` inside any
  `run:`.
- **`bun test`:** 315 pass, 69 skip, 0 fail.
- **Not run again:** the sdd ensemble. The brief asked for it on the original diff, and this round is a narrow change
  to one file, checked directly above.

### Still not verified

There was no real Docker or GitHub run. Real `timeout` killing a real `docker exec` was not observed; only the stub
behaviour was.

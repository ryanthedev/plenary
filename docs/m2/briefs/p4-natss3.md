# Brief: p4-natss3 (NATS Bus and S3 Blobs adapters)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PLAN.md phase 4, PROTOCOL.md § Bus, § Blobs,
§ Tenancy, then the single-node adapters you mirror: server/bus/memory.js, server/blobs/disk.js (read-only), and
test/server/ports.test.js (read-only; another builder owns it). deploy/cluster.compose.yml and .github/workflows/ci.yml
are platform's (read-only): match their env names.

- **Your tab:** `worker p4-natss3 (engine): NATS bus + S3 blobs`. Manager: `manager engine`, terminal `t14j`.
- **You own (new files only):** server/bus/nats.js, server/blobs/s3.js, test/server/bus-contract.js,
  test/server/blobs-contract.js (contract factories you write from § Bus/§ Blobs and ports.test.js),
  test/server/nats-bus.test.js, test/server/s3-blobs.test.js; and **package.json / bun.lock** only to add the NATS
  client dependency. Nothing else; another builder is editing the rest of server/ and test/server/.
- **Report:** docs/m2/reports/p4-natss3.md. Then stop, idle. Don't commit.

## Goal (PLAN.md phase 4, adapters only)

- **NATS Bus** behind § Bus, same contract as memory.js: subjects `plen.<tenant>.<board>.<kind>` (server-minted ids
  only; validate, no wildcards from input), at-most-once (NATS core, no JetStream), publish/subscribe/unsubscribe,
  max payload 2 MB (deploy's NATS is set to it; refuse bigger publishes clearly). Use the official NATS JS client
  (pick the current maintained package; one dependency). URL from the caller (`NATS_URL` in deploy), never env inside.
- **S3 Blobs** behind § Blobs, same contract as disk.js: `put(tenant, sha1, bytes)`/`get(tenant, sha1)`, 10 MB cap,
  SHA-1 verified, key `<tenant>/<sha1>` (validated ids), put idempotent; Bun's built-in `S3Client` with
  `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` passed in by the caller.

## Tests and where they run

- NATS tests skip when `NATS_URL` is unset; S3 tests skip when `S3_ENDPOINT` is unset. CI sets NATS_URL.
- Locally: `minio` is installed (/opt/homebrew/bin/minio): run it from a temp dir on a free port with throwaway
  credentials, record its PID, stop it by that PID. You may `brew install nats-server` and run it the same way
  (no `brew services`). Never pkill. Report exactly what you installed.
- Done when: both contracts pass against real NATS and MinIO locally (say how) and skip cleanly without them;
  `bun test` green.

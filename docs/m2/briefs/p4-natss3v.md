# Brief: p4-natss3v (verify the NATS Bus and S3 Blobs adapters)

Base: docs/m2/BRIEF-BASE.md applies (including "sdd helpers"). Read docs/m2/OFFICE.md ("Checking people's work"),
CLAUDE.md, PROTOCOL.md § Bus, § Blobs, § Tenancy, then the job's files. **Do not read docs/m2/reports/p4-natss3.md**.

- **Your tab:** `verifier p4-natss3v (engine): NATS bus + S3 blobs`. Manager: `manager engine`, terminal `t14j`.
- **You own:** docs/m2/reports/p4-natss3v.md only. Everything else is read-only.
- **The job's files** (new, untracked): server/bus/nats.js, server/blobs/s3.js, test/server/bus-contract.js,
  test/server/blobs-contract.js, test/server/nats-bus.test.js, test/server/s3-blobs.test.js, plus package.json and
  bun.lock (one dependency added: `@nats-io/transport-node`). Other files in server/ and test/server/ are other jobs'.
- **Servers:** nats-server and minio are installed locally. Run each from a scratch dir on a free port with
  throwaway credentials (NATS with `max_payload: 2MB`), record PIDs, stop by PID. Never pkill. Scratch tests outside
  the repo.
- **sdd ensemble:** codex only today: label it "single harness"; findings are leads to confirm or refute.
- Report PASS or FAIL with HIGH / MEDIUM / LOW findings. Then stop, idle.

## The job

Goal: a NATS Bus (NATS core, at-most-once) and an S3 Blobs adapter (Bun's S3Client) behind the existing ports, same
contracts as server/bus/memory.js and server/blobs/disk.js. Bus: subjects `plen.<tenant>.<board>.<kind>` from
server-minted ids only (no wildcards or dots from input), 2 MB max payload (refuse bigger publishes clearly; refuse a
server whose max_payload is smaller). Blobs: `put(tenant, sha1, bytes)` / `get`, 10 MB cap, SHA-1 verified, key
`<tenant>/<sha1>` with validated ids, put idempotent. Adapters take URLs/credentials from the caller, never env.
Tests skip cleanly when NATS_URL / S3_ENDPOINT are unset.

Done when: both contracts pass against real NATS and MinIO; skip cleanly without them; `bun test` green.

## Hunt for

- Subject injection or cross-tenant delivery (a subscriber for tenant A getting B's messages; wildcards).
- Blob key traversal, cross-tenant reads, hash mismatch accepted, cap off-by-one, partial writes visible.
- Lost or duplicated handlers on unsubscribe/close; leaked connections; a slow subscriber blocking others.
- Behaviour when NATS or MinIO is down or restarts mid-run (errors, not hangs; no unhandled rejections).
- Does the contract test really match memory.js/disk.js (run the contract files against those too)?

## The builder's not-verified list and risks

- CI not run (CI sets NATS_URL, no S3_*, so S3 tests skip in CI). NATS restart mid-run untested (client reconnects
  forever; messages in the gap may be lost, allowed at-most-once). Cross-node ordering not guaranteed (entries carry
  seq). Only MinIO, not AWS S3. No performance measurement (a JSON replacer runs on every message).
- `flush` covers only this process's subscribers. Blob quota not enforced (SEAM(p3)).
- The gateway subject is still `plen-gw.<gateway>` in memory.js's `subjects` (spec says `plen.<tenant>.<board>.gw.<gateway>`).

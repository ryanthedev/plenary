// The Postgres/NATS/S3-gated test files `bun run test:cluster` runs. A data module, so the guard (test/deploy/test-cluster.test.js)
// imports the list instead of scraping scripts/test-cluster.js (importing that script runs it).
export const DEFAULT_FILES = [
  "test/server/adapter-surface.test.js",   // every adapter has the port's methods; its Postgres, NATS and S3 cases are gated
  "test/server/pg-store.test.js",
  "test/server/pg-registry.test.js",
  "test/server/nats-bus.test.js",
  "test/server/room-host-lease.test.js",
  "test/server/fold-host.test.js",
  "test/server/room-host-proc.test.js",
  "test/server/main-cluster.test.js",
  "test/server/cluster-id.test.js",
  "test/server/cluster-isolation.test.js",
  "test/server/s3-blobs.test.js",
  "test/server/blobs-s3-e2e.test.js",
  "test/server/blobs-main.test.js",   // names S3_* (its start-up refusal test); its children get an explicit env, so the rig's values never reach them
  "test/admin/tenants.test.js",
];

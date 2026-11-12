# Brief: p8-cluster-envv (verify p8-cluster-env: cluster compose + CI services)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-cluster-envv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; port 0; kill
only PIDs you recorded. Pull or push no images.

## Goal and done-when (docs/m2/briefs/p8-cluster-env.md: read it)

A phase-4 cluster stack (Postgres, NATS core, an S3-compatible blob store, 3 app nodes, a load balancer that passes
WebSocket upgrades on /ws and /health; images pinned; only the LB published, on 127.0.0.1; healthchecks), env by
name only with no secret values, and a CI job with Postgres and NATS services that runs `bun test` and passes
today. The single-node deploy/compose.yml must work exactly as before. Nothing published.

## The diff

`git diff -- .github deploy` plus untracked `deploy/cluster.compose.yml` and `deploy/cluster/`.

## Try to break it

- Secrets: any value in a file (beyond the documented throwaway CI Postgres password); `${VAR:?}` on every secret.
- Does the existing CI job still behave exactly as before (same steps, herdr-draw clone, permissions)? Does the new
  job pass today, and would it fail if a service is unhealthy? `${{ }}` in `run:`; action SHAs pinned.
- Ports: anything other than the LB published, or bound to 0.0.0.0 on the host.
- LB config: WebSocket upgrade headers for /ws; validate with `caddy validate` / `nginx -t` if installed, else read
  it against the tool's docs.
- Image tags exist (registry API; don't pull). The blob store is a community MinIO fork (`pgsty/minio`), chosen
  because official MinIO images left Docker Hub: confirm that claim and the fork's license.
- deploy/compose.yml unchanged in behaviour (diff it).
- YAML parses (`ruby -ryaml`); `bun test` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then review the diff with codex + agy + every other
harness passing `check_adapter`. Two agreeing = HIGH candidate: confirm or refute. List which harnesses ran.

## The builder's not-verified list and risks (only these)

- No container ever started; healthcheck commands, Caddy /ws proxying, and three services building one tag untested.
- Workflow never ran on GitHub; no actionlint; service health flags and NATS monitoring port untested;
  `nats.conf` not parsed.
- CI NATS keeps the default 1 MB max_payload (service containers can't take a config).
- Blob store is a fork; `POSTGRES_PASSWORD` must be URL-safe; app nodes use the blob store's root credentials;
  round-robin LB without stickiness.

Grade HIGH: a secret in a file, anything published, a port exposed beyond 127.0.0.1, the existing CI job or
single-node compose broken, or the new CI job failing today. Then stop and leave the session idle.

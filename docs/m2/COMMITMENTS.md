# M2 commitments and state (owned by the proxy)

Every promise made to the CEO goes here the same turn. Status: OPEN, RUNNING, VERIFYING, DONE (commit), DROPPED.

## Sessions

| Role / job | Terminal | Tab label | Status |
|---|---|---|---|
| owner | t13s | owner (audits) | idle after starting the proxy |
| proxy | t14h | ★ proxy (talk here) | running |
| manager engine | t14j | manager engine | running: phase 1 spec (builder + verifier) |
| manager client | t14k | manager client | running: phase 6 design mock |

## Commitments

| # | What | Status | Evidence |
|---|---|---|---|
| 1 | Phase 1 protocol v1 spec, CEO reviews it before code | RUNNING | manager engine t14j, brief docs/m2/briefs/manager-engine.md |
| 2 | Phase 6 design mock, CEO approves before building | RUNNING | manager client t14k, brief docs/m2/briefs/manager-client.md |
| 3 | Ask the CEO for the Google OAuth client (env vars, never chat) when phase 5 starts | OPEN | |
| 4 | drawh change is a proposal only; herdr-draw untouched without the CEO | OPEN | |

## Decisions (reversible; the CEO may overturn)

- 2026-11-11 owner: three tracks (engine, client, platform) with disjoint ownership; platform starts after phase 3.
- 2026-11-11 proxy: managers report to the proxy by `herdr_agent prompt` to t14h plus docs/m2/reports/manager-<track>.md; managers keep their own worker rosters there, the proxy keeps this file.
- 2026-11-11 proxy: Engram was unreachable at start (name resolver error); proceeding without recall.

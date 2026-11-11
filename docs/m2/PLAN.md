# M2 plan: scale-ready product

Approved by the CEO (the user) 2026-11-11. Decisions behind it: CLAUDE.md, "Decisions (M2 scope)".
Change this file only with the CEO's OK; record status in COMMITMENTS.md, not here.

## Tracks (disjoint ownership)

| Track | Manager tab | Owns | Phases |
|---|---|---|---|
| engine | `manager engine` | PROTOCOL.md, packages/protocol/, server/ (except server/auth, server/admin), test/ (except test/web, test/auth) | 1, 2, 3, 4, load-test half of 8 |
| client | `manager client` | web/, test/web/, design mocks under docs/m2/design/ | 6, 7 |
| platform | `manager platform` (starts after phase 3) | server/auth/, server/admin/, test/auth/, deploy/, .github/, README.md, drawh proposal | 5, packaging half of 8 |

- **Seam rule:** a line that crosses two tracks has ONE named owner, written in the brief. The engine track owns
  every protocol message (incl. comments, reactions, presence); the client consumes them.
- **packages/core is never edited here** (CLAUDE.md). herdr-draw is never edited without the CEO's OK.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | **Protocol v1 spec** (PROTOCOL.md): restart recovery (snapshot + log replay; op-id and note-author tables in snapshots; op-id table bounded per client), presence channel (cursors, selections, laser, emotes; never logged, may drop), comments (threads anchored to element or point, replies, resolve) and reactions as durable records, tenancy, ports: Store, Bus, Blobs, async Auth (verified before a room sees hello). | CEO reviewed the spec (proxy asks with a timer). Existing tests pass. |
| 2 | **Room recovery** in packages/protocol (stays pure: test/purity.test.js). | A room rebuilt from MemoryLog equals the original; a resend gets the same ack/seq; note ownership still refused; convergence test with a restart mid-run passes. |
| 3 | **Single-node server** (server/, Bun): gateway + room host in one process, WebSocket via the codec, SQLite store (`synchronous=FULL`), in-memory bus, local-disk blobs (10 MB cap, SHA-1 verified, keyed by tenant+hash), dev-token auth, `POST /boards` admin endpoint, structured logs to stdout, /health. | Gates as tests: convergence over real sockets (vs a fresh `since: 0` client); op-to-peer p95 < 150 ms on localhost; kill -9 child server mid-stream, restart: every acked op present, resends land once. Bad frames don't kill the process. |
| 4 | **Cluster mode:** Postgres store, NATS bus, S3-compatible blobs, board leases + takeover, gateways separate from room hosts. | docker-compose 3-node test: kill a board's host, another takes over, no acked op lost; cross-node editors still < 150 ms p95 locally. |
| 5 | **Google sign-in** (OIDC; OAuth client in the CEO's Omniping Google Cloud project, id/secret from env only), tenants = Workspace domain, invites and share links (role per link), admin API. | End-to-end sign-in with the real client; cross-tenant reads of boards/blobs refused (tests). |
| 6 | **Full canvas UI** over core's Editor: Canvas2D adapter for the display list (path, text, image), every tool, style/layers panels, frames, timeline, Mermaid, library, paste/drag pictures, export, dark mode, touch. **Design mock first; CEO approves before building.** | CEO approved the mock; two browsers edit together with every tool; headless test: refused op + resync leaves Editor == Replica. |
| 7 | **Full collaboration:** live cursors with names, avatar row, others' selections, laser, draw, highlighter, emotes, reactions, comment threads, annotations (notes stream), connection status pill. | All work across two nodes; headless tests for comments, reactions, presence. |
| 8 | **Packaging and proof of scale:** Docker image, compose file, GitHub Actions CI running every gate, /metrics, load test ~10k simulated clients on 3 nodes. | CI green; load-test report in docs/m2/. |
| — | **drawh proposal** (`drawh --server URL --token`): a patch file under docs/m2/proposals/, never applied to herdr-draw without the CEO. | CEO approves or rejects. |

Order: 1 first (engine). The client track starts the phase-6 design mock at the same time (it needs core's Editor,
not the protocol). 2 → 3 → 4 in order. Platform starts after 3. 7 after 1 and 6. 8 last.

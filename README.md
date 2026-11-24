# Plenary

**Plenary** is an open-source (Apache-2.0), self-hostable collaborative infinite canvas built with Bun, vanilla ESM JavaScript, and a strict hexagonal architecture — from a 5-minute single-node pilot to a multi-node high-availability cluster.

Presenters sketch diagrams, import Excalidraw/Draw.io/Mermaid scenes, animate multi-swimlane timelines, and run live presentations, while annotators and audiences collaborate in real time through isolated **board**, **notes**, and **comments (`records`)** streams.

---

## Capabilities

- **Infinite Canvas & Diagramming:** 12 core tools (`Select`, `Hand`, `Rectangle`, `Diamond`, `Ellipse`, `Arrow`, `Line`, `Pen`, `Text`, `Eraser`, `Frame`, `Laser`), Sticky Notes & Highlighter (`notes` stream), smart port-snapping connectors & elbow arrows, Mermaid flowchart import, Swimlane & Table builders, Rich Link Cards (GitHub, Linear, Jira, Azure DevOps), Media Embeds (YouTube, Figma, Google Docs/Sheets/Slides, Notion, PDF, video/image), Icon Packs (Kubernetes & Cloud), and `.excalidrawlib` support.
- **Animation, Frames & Present Mode:** `Draw` / `Animate` / `Present` modes, multi-swimlane NLE timeline with 25 presets, 7 easings, cue markers, `Reduced motion` support, Frames (`F`), Saved Views (`⌘J`), local Solo Layer, and deep links (`#frame=`, `#el=`, `#view=`).
- **Live Collaboration & Governance:** Real-time cursors, selections, live stroke previews, 8 emotes, Laser pointer (`K`), Lock Audience, spatial comment pins & threads, 5-tier access ladder (`Owner`, `Editor`, `Annotator`, `Commenter`, `Viewer`), Personal & Shared Spaces, Areas, 30-day Trash, Version History (up to 50 snapshots), Audit Logs, Custom Roles, Teams, and Offboarding.
- **Import & Export:** `.excalidraw`/`.json`, `.drawio`/`.xml`, PNG/JPEG/GIF/WebP (≤10 MB), MP4/WebM/QuickTime video with HTTP `Range` streaming (≤50 MB); export to `SVG`, `PNG`, `PDF / Print`, and `.excalidraw` (excluding private notes, comments, and cursors).
- **Mobile Web & PWA:** Chrome-on-iOS / touch ergonomics, 2-finger Undo / 3-finger Redo, Apple Pencil pressure + palm rejection, swipe bottom sheets, and Light & Dark themes (`Warm Studio Craft` / `Obsidian Studio`).
- **Enterprise Auth & Deployment:** Simultaneous multi-provider OIDC SSO (**Google Workspace**, **Microsoft Entra ID**, and **Generic OIDC**) plus local dev tokens; Single-Node mode (SQLite + local disk blobs) and HA Cluster mode (PostgreSQL + NATS + S3-compatible blobs + Prometheus `/metrics`).
- **Automation & AI Agents:** 22-command Agent CLI (`scripts/plenary-cli.js`) and 22-tool JSON-RPC 2.0 stdio MCP server (`scripts/plenary-mcp.js`).

---

## Quickstart ("Try it")

Requires [Bun](https://bun.sh) **1.4.4+** and one dependency install:

```sh
bun install --frozen-lockfile
```

Start a local single-node server with temporary SQLite storage and two dev users (no Postgres, NATS, or IdP account needed):

```sh
PORT=8099 PLENARY_DATA_DIR="$(mktemp -d)" \
PLENARY_DEV_TOKENS='{"dev-ada":{"name":"ada","role":"owner"},"dev-bo":{"name":"bo","role":"editor"}}' \
bun server/main.js
```

Open two browser tabs to collaborate live:

- **ada (owner):** <http://localhost:8099/?as=ada>
- **bo (editor):** <http://localhost:8099/?as=bo>

Without `?board=`, you land on **Home**: the starter dev board appears under *Your boards* for `ada` and *Shared with me* for `bo`. Without `?as=`, the sign-in page lists dev users as buttons (only when `HOST` and `PUBLIC_URL` are loopback, no OIDC provider is configured, and the token has no `admin`, `domain`, or `content` flags). Use `PORT=0` to pick an ephemeral free port, and check `GET /health` for readiness.

> **Note:** Dev tokens are strictly for local testing (`GET /auth/dev` is disabled automatically behind a non-loopback `PUBLIC_URL`, non-loopback `HOST`, or when OIDC is enabled).

---

## Architecture & Repository Layout

Plenary uses plain ESM JavaScript with TypeScript JSDoc checking (`jsconfig.json`, zero build step) organized in a hexagonal ports-and-adapters layout:

| Path | Role |
| --- | --- |
| `packages/core/` | 34 pure canvas, editor, geometry, rendering, animation, importer, and export modules (owned directly in Plenary) |
| `packages/protocol/` | 10 pure Protocol v1.1 modules: envelope/codec, client `Replica`, reference `Room` sequencer, presence, records, moderation, and ports |
| `server/main.js` | Composition root wiring SQLite or PostgreSQL + NATS, local disk or S3 blobs, Prometheus metrics, and multi-provider OIDC |
| `server/core/` | Gateway, room host, feed, blob access/reaper, trash sweep, tenancy, access/spaces/roles/move/offboard/versions, and admin services |
| `server/ports/` | Outbound & inbound port contracts (`auth`, `blobs`, `bus`, `entra-directory`, `idp`, `live-sources`, `metrics`, `registry`, `store`, `webhook-delivery`) |
| `server/adapters/` | `driving/` (HTTP, WS, Auth, Blobs, Metrics, Static), `driven/` (SQLite, PostgreSQL, NATS, S3, Disk, OIDC, Prometheus), and `support/` (codecs & DB schemas) |
| `web/` | Browser client served by the server (`index.html`, `main.js`, `style.css`, `home.css`, `styles/`, `ports/`, `core/`, `adapters/`) |
| `scripts/` | Agent CLI (`plenary-cli.js`), MCP server (`plenary-mcp.js`), `admin-bootstrap.js`, `cluster-rig.js`, `bench.js`, `clean.js` |
| `deploy/` | `Dockerfile`, single-node `compose.yml`, `docker-compose.enterprise.yml`, Helm chart (`deploy/helm/plenary/`), and backup/restore scripts |
| `test/` | Unit, protocol, server, auth, admin, web UI, architecture, purity, load, and deployment kit test suites (`bun test`) |
| `docs/` | End-user guide, OIDC & Enterprise ops handbooks, design system (`docs/design/DESIGN.md`), and benchmark report |

### Browser-Only Dev Sandbox

You can also run the canvas entirely in-browser via a `SharedWorker` without starting the Node/Bun server (using any static file server, not `file://`):

```sh
python3 -m http.server 0 --bind 127.0.0.1
```

Open `/web/dev-main.html?board=demo&as=ada` (or `bo`, `cy`, `di`, `ed`, `fi`). Note that `server/main.js` intentionally blocks `web/dev*.html` in server mode.

---

## Multi-Provider SSO & Tenant Bootstrap

Plenary supports configuring **Google Workspace**, **Microsoft Entra ID**, and **Generic OIDC** simultaneously (or any single provider). Configured providers are listed by `GET /auth/providers` and selected via `GET /auth/login?provider=google|microsoft|oidc`, sharing a single `OIDC_REDIRECT_URI`:

- **Google Workspace:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Microsoft Entra ID:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (`common` default, `organizations`, `consumers`, or tenant GUID)
- **Generic OIDC (Okta, Keycloak, Authentik, Pocket ID, Auth0, etc.):** `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`
- **Verified email & org auto-provisioning:** `PLENARY_TRUST_VERIFIED_EMAIL` and `PLENARY_AUTO_PROVISION_DOMAIN_ORGS` (on by default for verified corporate `google:` and `microsoft:` domains)

To bootstrap a tenant's initial admin or content-tier holders via CLI (idempotent):

```sh
bun scripts/admin-bootstrap.js --domain acme.com --admin alice@acme.com
```

See [`docs/self-hosting-oidc.md`](docs/self-hosting-oidc.md) for provider recipes, group gating, and security guarantees.

---

## Self-Hosting & Production Deployment

- **Single-Node Docker Compose:** SQLite (`plenary.db`, `registry.db`) + local-disk blobs (`PLENARY_DATA_DIR=/data`) via `deploy/compose.yml`.
- **Enterprise HA Compose:** Plenary + PostgreSQL 17 + NATS + Caddy automatic HTTPS via `deploy/docker-compose.enterprise.yml`.
- **Kubernetes Helm Chart:** `deploy/helm/plenary/` supporting `mode=single` and `mode=ha` (PostgreSQL `DATABASE_URL`, NATS `NATS_URL`, S3-compatible blobs `S3_ENDPOINT` + `S3_*`, `PodDisruptionBudget`, non-root read-only rootfs).
- **Observability:** Set `PLENARY_METRICS_TOKEN` (≥16 chars) to expose Prometheus metrics at `GET /metrics` (Bearer-authenticated; `404` when unset).

See [`docs/enterprise-hosting.md`](docs/enterprise-hosting.md) and [`deploy/README.md`](deploy/README.md) for step-by-step runbooks, backups, and air-gap checklists.

---

## Agent CLI & MCP Server

Plenary ships a 22-command Agent CLI and a 22-tool JSON-RPC 2.0 stdio MCP server speaking HTTP Admin API + Protocol v1.1 WebSockets:

```sh
# Agent CLI
PLENARY_URL=http://localhost:8099 PLENARY_TOKEN=dev-ada \
  bun scripts/plenary-cli.js list-boards

# Stdio MCP server
PLENARY_URL=http://localhost:8099 PLENARY_TOKEN=dev-ada \
  bun scripts/plenary-mcp.js
```

---

## Development & Verification

```sh
# Full test suite (Postgres/NATS/S3 contract tests auto-skip unless DATABASE_URL/NATS_URL/S3_* are set)
bun test

# Static typecheck (TypeScript over ESM + JSDoc via jsconfig.json)
bun run typecheck

# 3-node cluster integration test (Docker/Podman)
bun run test:compose

# Multi-node local rig / cluster tests
bun run test:cluster

# Dry-run cleanup of scratch test/load/rig directories
bun run clean
```

---

## Documentation

- **End-User Guide:** [`docs/user-guide.md`](docs/user-guide.md)
- **OIDC, Google & Microsoft Entra ID Setup:** [`docs/self-hosting-oidc.md`](docs/self-hosting-oidc.md)
- **Enterprise Self-Hosting & Operations Handbook:** [`docs/enterprise-hosting.md`](docs/enterprise-hosting.md)
- **Visual & UX Design System:** [`docs/design/DESIGN.md`](docs/design/DESIGN.md)
- **Container & Release Packaging:** [`deploy/README.md`](deploy/README.md)
- **Wire Protocol Specification (v1.1):** [`PROTOCOL.md`](PROTOCOL.md)
- **Performance Benchmarks:** [`docs/benchmarks/report.md`](docs/benchmarks/report.md)
- **License:** Apache-2.0 — see [`LICENSE`](LICENSE)

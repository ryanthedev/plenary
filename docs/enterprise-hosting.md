# Plenary Enterprise Self-Hosting & Operations Handbook

This handbook covers running Plenary in production — from a 5-minute single-node deployment to a High-Availability (HA) Kubernetes or Docker Compose cluster, SSO/OIDC configuration, backup/restore, upgrades, and air-gapped environments.

---

## 1. 5-Minute Single-Node Setup (Docker Compose)

Best for small teams or departmental pilots (SQLite store + registry + local-disk blobs on one persistent volume).

1. **Create `deploy/.env`** (git-ignored; Compose reads `.env` beside `deploy/compose.yml`):

   ```sh
   cat <<EOF > deploy/.env
   COOKIE_KEY=$(openssl rand -hex 32)
   PUBLIC_URL=https://plenary.example.com
   OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
   OIDC_ISSUER_URL=https://auth.example.com
   OIDC_CLIENT_ID=<your-client-id>
   OIDC_CLIENT_SECRET=<your-client-secret>
   EOF
   chmod 600 deploy/.env
   ```

2. **Start Plenary** (builds from this repository by default; set `PLENARY_IMAGE=<your-registry>/plenary:<tag>` when pulling a published or mirrored image):

   ```sh
   docker compose -f deploy/compose.yml up -d --build
   ```

3. **Verify health:**

   ```sh
   curl -fsS http://127.0.0.1:8080/health
   ```

4. Place a TLS-terminating reverse proxy (Caddy, nginx, Traefik, or cloud ALB) in front of `127.0.0.1:8080` with WebSocket upgrade support on `/ws`.

> **Important:** Single-node SQLite (`plenary.db` and `registry.db` in `PLENARY_DATA_DIR=/data`) supports **only one server process**. Never mount one SQLite volume across multiple replicas.

---

## 2. Enterprise HA Setup

For multi-node availability and zero-downtime rolling upgrades, Plenary switches to **Cluster Mode** automatically when both `DATABASE_URL` (PostgreSQL) and `NATS_URL` (NATS core, `max_payload >= 2MB`) are set. Every node also requires the same `COOKIE_KEY` and shared S3-compatible blob storage (`S3_*`), unless running a single-gateway cluster with `PLENARY_BLOBS=local-disk`.

### Option A: 1-Command Enterprise Compose (with Automatic HTTPS)

`deploy/docker-compose.enterprise.yml` deploys Plenary + PostgreSQL 17 + NATS + Caddy automatic HTTPS (Let's Encrypt) with healthchecks and named persistent volumes.

1. Populate `deploy/.env` (see the header of `deploy/docker-compose.enterprise.yml` for all options):

   ```env
   PLENARY_DOMAIN=plenary.example.com
   PUBLIC_URL=https://plenary.example.com
   OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
   POSTGRES_PASSWORD=<letters-and-digits-only>
   COOKIE_KEY=<openssl rand -hex 32>
   PLENARY_BLOBS=local-disk   # or leave unset and set S3_ENDPOINT + S3_* for external S3

   OIDC_ISSUER_URL=https://auth.example.com
   OIDC_CLIENT_ID=<your-client-id>
   OIDC_CLIENT_SECRET=<your-client-secret>
   ```

2. Launch and verify (builds locally by default; set `PLENARY_IMAGE` to pull a prebuilt image):

   ```sh
   docker compose -f deploy/docker-compose.enterprise.yml up -d --build
   curl -fsS https://plenary.example.com/health
   ```

### Option B: Kubernetes via Helm (`deploy/helm/plenary/`)

The Helm chart supports both **Simple Single-Node** (`mode: single`, default) and **Enterprise HA** (`mode: ha`).

> **Image note:** Official container images are not yet published to a public registry (see `deploy/README.md` § *Release*). Build and push `deploy/Dockerfile` to your organization's container registry first, then pass `--set image.repository=<your-registry>/plenary --set image.tag=<version>`.

#### Single-Node on Kubernetes

```sh
kubectl create namespace plenary
kubectl -n plenary create secret generic plenary-secrets \
  --from-literal=COOKIE_KEY="$(openssl rand -hex 32)" \
  --from-literal=OIDC_CLIENT_ID="<client-id>" \
  --from-literal=OIDC_CLIENT_SECRET="<client-secret>"

helm upgrade --install plenary deploy/helm/plenary \
  --namespace plenary \
  --set mode=single \
  --set secrets.existingSecret=plenary-secrets \
  --set config.publicUrl=https://plenary.example.com \
  --set config.oidc.issuerUrl=https://auth.example.com \
  --set config.oidc.redirectUri=https://plenary.example.com/auth/callback \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=plenary.example.com
```

#### Enterprise HA on Kubernetes (3 Replicas + PDB + RollingUpdate)

```sh
kubectl create namespace plenary
kubectl -n plenary create secret generic plenary-ha-secrets \
  --from-literal=COOKIE_KEY="$(openssl rand -hex 32)" \
  --from-literal=DATABASE_URL="postgres://plenary_app:<pass>@postgres.db.svc:5432/plenary" \
  --from-literal=NATS_URL="nats://nats.messaging.svc:4222" \
  --from-literal=S3_ACCESS_KEY_ID="<key>" \
  --from-literal=S3_SECRET_ACCESS_KEY="<secret>" \
  --from-literal=OIDC_CLIENT_ID="<client-id>" \
  --from-literal=OIDC_CLIENT_SECRET="<client-secret>"

helm upgrade --install plenary deploy/helm/plenary \
  --namespace plenary \
  --set mode=ha \
  --set replicaCount=3 \
  --set secrets.existingSecret=plenary-ha-secrets \
  --set config.s3.endpoint=https://s3.internal.example.com \
  --set config.s3.bucket=plenary \
  --set config.s3.region=us-east-1 \
  --set config.publicUrl=https://plenary.example.com \
  --set config.oidc.issuerUrl=https://auth.example.com \
  --set config.oidc.redirectUri=https://plenary.example.com/auth/callback \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=plenary.example.com
```

#### Hardening Built Into the Chart
- Non-root UID/GID `1000:1000` (`runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `seccompProfile: RuntimeDefault`).
- `readOnlyRootFilesystem: true` with writable mounts only on `/data` (PVC in single-node, `emptyDir` in HA) and `/tmp` (`emptyDir`).
- Startup, readiness, and liveness probes against `GET /health` on port `8080`.
- `PodDisruptionBudget` (`minAvailable: 2`) enabled automatically in HA mode.

#### PostgreSQL Least-Privilege Roles
For hardened clusters, separate schema ownership (`plenary_owner`) from runtime traffic (`plenary_app`):
- `plenary_owner` owns database `plenary` and creates missing `reg_*` / `pl_*` tables during schema bootstrap/upgrades.
- `plenary_app` receives only `USAGE` on schema `public` and `SELECT, INSERT, UPDATE, DELETE` on tables (`ALTER DEFAULT PRIVILEGES ...`). See `deploy/README.md` § *Postgres roles (least privilege)* for the exact SQL.

---

## 3. OIDC & Google Workspace SSO Reference

Plenary supports **either** Generic OIDC **or** Google Workspace SSO (do not configure both simultaneously; `server/main.js` refuses to start if both are set).

### Generic OIDC (Okta, Keycloak, Authentik, Pocket ID, Auth0, Entra ID)
- Uses OIDC Discovery (`/.well-known/openid-configuration`), Authorization Code Flow with **PKCE (`S256`)**, and JWKS (`RS256`/`ES256`) verification.
- Minimum required variables: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL`, `OIDC_REDIRECT_URI` (`<PUBLIC_URL>/auth/callback`), and `COOKIE_KEY`.
- Recommended production controls:
  - `OIDC_ALLOWED_GROUPS` + `OIDC_GROUPS_CLAIM` to restrict sign-in to specific IdP groups.
  - `OIDC_ADMIN_USERS` (comma-separated `sub` values) to bootstrap Unit admins on startup.
  - `OIDC_TENANT_DOMAIN` and `OIDC_EMAIL_DOMAINS` to authorize email-based board invite claiming.
- Full provider-by-provider setup examples live in `docs/self-hosting-oidc.md`.

### Google Workspace SSO
- Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`, `OIDC_REDIRECT_URI`, and `COOKIE_KEY` (leave `OIDC_ISSUER_URL` unset).
- Uses Google's verified Workspace `hd` claim for tenant isolation.

---

## 4. Backup, Restore & Upgrade Runbook

### Creating a Consistent Hot Backup

Never run raw `cp` on an active SQLite WAL database (`plenary.db` / `registry.db`). Always use `deploy/scripts/backup.sh`, which uses SQLite's online `.backup` API, archives `blobs/`, optionally runs `pg_dump`, and generates a `SHA256SUMS` manifest:

```sh
# Single-node (SQLite + local blobs)
deploy/scripts/backup.sh \
  --data-dir /data \
  --output-dir /var/backups/plenary

# Enterprise (PostgreSQL + local blobs)
deploy/scripts/backup.sh \
  --data-dir /data \
  --output-dir /var/backups/plenary \
  --database-url "$DATABASE_URL"
```

> For HA deployments using external S3 blobs, enable bucket versioning / cross-region replication on your S3 bucket alongside `pg_dump` backups.

### Verifying & Restoring a Backup

1. **Verify integrity without modifying anything:**

   ```sh
   deploy/scripts/restore.sh \
     --backup-dir /var/backups/plenary/plenary-backup-20261123T000000Z \
     --verify-only
   ```

2. **Stop all Plenary nodes** writing to the target store.

3. **Restore:**

   ```sh
   # Single-node SQLite + blobs
   deploy/scripts/restore.sh \
     --backup-dir /var/backups/plenary/plenary-backup-20261123T000000Z \
     --data-dir /data \
     --force

   # Enterprise PostgreSQL + blobs
   deploy/scripts/restore.sh \
     --backup-dir /var/backups/plenary/plenary-backup-20261123T000000Z \
     --data-dir /data \
     --database-url "$DATABASE_URL" \
     --force
   ```

4. **Staging / cloned cluster warning:** If you restore a PostgreSQL dump into a staging cluster that shares a NATS server with production, run `DELETE FROM pl_cluster;` while all staging nodes are stopped so the staging cluster generates a fresh NATS subject prefix.

### Upgrade Runbook

1. **Back up first** using `deploy/scripts/backup.sh` and verify with `--verify-only`.
2. **Check release notes** for any new Postgres tables/indexes. If using least-privilege Postgres roles (`plenary_app`), run the `plenary_owner` schema bootstrap before rolling runtime pods.
3. **Roll the new image:**
   - **HA (Kubernetes):** `helm upgrade plenary deploy/helm/plenary --namespace plenary --reuse-values --set image.tag=<new-version>`. The `RollingUpdate` strategy + `PodDisruptionBudget` drains one pod at a time via `SIGTERM` while board leases fail over automatically.
   - **Single-node (Kubernetes):** `Recreate` strategy stops the old pod cleanly on `SIGTERM` before starting the new pod on the same RWO PVC.
   - **Docker Compose:** update `PLENARY_IMAGE` and run `docker compose -f deploy/docker-compose.enterprise.yml up -d`.
4. **Verify:** check `GET /health` returns HTTP `200` and review structured JSON logs for clean startup.

---

## 5. Air-Gap Mode Checklist

Plenary is designed to operate with **zero internet egress** at runtime:

- [ ] **Zero CDN dependencies:** All frontend HTML, CSS, JavaScript, and icons in `web/` are served directly by the Plenary container (`server/main.js`). No external CDN `<script>`, `<link>`, `@import`, or font URLs are loaded at runtime (enforced automatically by `test/deploy/self-host-kit.test.js`).
- [ ] **No telemetry or phone-home:** Plenary sends zero outbound analytics, crash reports, or update checks.
- [ ] **Private container registry:** Mirror required images to your internal registry before deployment:
  - `ghcr.io/ryanthedev/plenary:<version>`
  - `postgres:17.11-alpine3.23` (HA / Enterprise Compose)
  - `nats:2.15.3-alpine` (HA / Enterprise Compose)
  - `caddy:2.11.9-alpine` (Enterprise Compose)
- [ ] **Internal Identity Provider:** Point `OIDC_ISSUER_URL` at an internal HTTPS OIDC provider (Keycloak, Authentik, Pocket ID, ADFS/Entra hybrid). Note that Plenary's OIDC SSRF guard rejects raw private IP literals — always address your internal IdP via internal DNS (`https://idp.corp.internal`) backed by your internal CA.
- [ ] **Internal TLS / PKI:** Mount your internal CA bundle if using a private PKI (`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` via `extraEnv` in Helm) and configure Ingress/Caddy with internal TLS certificates (disable ACME in air-gapped networks).
- [ ] **Internal S3-compatible store (HA):** Point `S3_ENDPOINT` at an on-prem object store (MinIO, Ceph RGW, Garage, etc.).

---

## 6. Complete Environment Variable Reference

Every variable read by `server/main.js`:

### Core Server
| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `PORT` | `8080` | No | HTTP/WebSocket listen port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in image) | Container | Bind address. Must be `0.0.0.0` inside containers. |
| `PLENARY_DATA_DIR` | `./data` (`/data` in image) | No | Directory for SQLite databases (`plenary.db`, `registry.db`), local blobs (`blobs/`), and `dev-board.json`. |
| `NODE_ENV` | unset (`production` in Helm/Enterprise Compose) | Prod | Enables production guards (e.g. rejects `http://localhost` OIDC issuers). |
| `LOG_LEVEL` | `info` | No | Structured JSON log level: `debug`, `info`, `warn`, or `error`. |
| `PUBLIC_URL` | origin of `OIDC_REDIRECT_URI` | Prod | External browser-visible origin (e.g. `https://plenary.example.com`). |
| `POST_LOGIN_URL` | `<PUBLIC_URL>/` | No | Redirect target after sign-in completes. |
| `BOARD_URL` | `<PUBLIC_URL>/?board={board}` | No | Template for generated board links. |

### Security & Signing Keys
| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `COOKIE_KEY` | random per start (single-node only) | **Yes (HA)** / Prod | ≥ 32 bytes (`openssl rand -hex 32`). Signs login cookies, sessions (unless `SESSION_KEY` is set), and blob URLs. Must be identical on every HA replica. |
| `SESSION_KEY` | `COOKIE_KEY` | No | Optional ≥ 32-byte key dedicated to session signing. |
| `PLENARY_DEV_TOKENS` | unset | **Never in prod** | Local-dev-only JSON token map. Leave unset in production. |

### Cluster & Blob Storage (HA Mode)
| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | unset | **Yes (HA)** | PostgreSQL connection URL for Store and Registry. Setting either `DATABASE_URL` or `NATS_URL` enables cluster mode (both required). |
| `NATS_URL` | unset | **Yes (HA)** | NATS server URL (or comma-separated list). NATS must set `max_payload: 2MB`. |
| `PLENARY_NODE_ID` | normalized hostname | No | Unique node ID (`[a-z0-9-]`, 1–32 chars, alphanumeric ends). |
| `PLENARY_ROLES` | `gateway,host` | No | Comma-separated roles: `gateway`, `host`, or `gateway,host`. |
| `PLENARY_LEASE_TTL_MS` | `10000` | No | Room-host lease TTL in ms (`3`–`600000`). Must be identical on all HA nodes. |
| `S3_ENDPOINT` | unset | **Yes (HA)** | S3-compatible endpoint URL. When set, all five `S3_*` variables are required. |
| `S3_BUCKET` | unset | With `S3_ENDPOINT` | Pre-created S3 bucket name. |
| `S3_REGION` | unset | With `S3_ENDPOINT` | S3 region (e.g. `us-east-1`). |
| `S3_ACCESS_KEY_ID` | unset | With `S3_ENDPOINT` | S3 access key ID. |
| `S3_SECRET_ACCESS_KEY` | unset | With `S3_ENDPOINT` | S3 secret access key. |
| `S3_SESSION_TOKEN` | unset | No | Optional temporary STS session token. |
| `PLENARY_BLOBS` | unset | Single-GW HA | Set to `local-disk` only for a single-gateway cluster without S3 (mutually exclusive with `S3_ENDPOINT`). |

### Authentication (OIDC or Google Workspace SSO — Pick One)
| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `OIDC_ISSUER_URL` | unset | Generic OIDC | HTTPS OIDC issuer base URL. |
| `OIDC_CLIENT_ID` | unset | Generic OIDC | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | unset | Generic OIDC | OIDC client secret. |
| `OIDC_REDIRECT_URI` | `http://localhost:8080/auth/callback` | Prod | Callback URL registered at the IdP (must match `PUBLIC_URL` origin). |
| `OIDC_SCOPES` | `openid email profile` | No | Space-separated OIDC scopes. |
| `OIDC_DISPLAY_NAME` | `SSO` | No | Provider/tenant display name. |
| `OIDC_TENANT_SLUG` | derived from issuer | No | Explicit slug for `oidc:<slug>` tenancy. |
| `OIDC_TENANT_DOMAIN` | `oidc:<slug>` | No | Explicit tenant domain binding. |
| `OIDC_EMAIL_DOMAINS` | `OIDC_TENANT_DOMAIN` if DNS | No | Comma-separated email domains allowed to claim email invites. |
| `OIDC_ALLOWED_GROUPS` | unset | No | Comma-separated IdP groups required to sign in. |
| `OIDC_GROUPS_CLAIM` | `groups` | No | ID token claim name inspected for `OIDC_ALLOWED_GROUPS`. |
| `OIDC_ADMIN_USERS` | unset | No | Comma-separated OIDC `sub` values granted Unit admin on startup. |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | `0` | No | Set `1` only for IdPs (e.g. Entra ID) omitting `email_verified`. |
| `OIDC_ALLOW_HTTP_LOCALHOST` | `0` in prod | No | Set `1` only for local dev HTTP IdPs. |
| `GOOGLE_CLIENT_ID` | unset | Google SSO | Google Workspace OAuth client ID (mutually exclusive with `OIDC_ISSUER_URL`). |
| `GOOGLE_CLIENT_SECRET` | unset | Google SSO | Google Workspace OAuth client secret. |

### Observability & Tuning
| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `PLENARY_METRICS_TOKEN` | unset | No | ≥ 16-char RFC 6750 Bearer token enabling `GET /metrics` (Prometheus text). Unset = 404. |
| `PLENARY_REQUEST_DEADLINE_MS` | `8000` | No | Per-request HTTP deadline in ms (must stay above 5000 ms Registry limit). |
| `PLENARY_MAX_CONNS_PER_USER` | `64` | No | Maximum concurrent WebSocket connections per user. |
| `PLENARY_BLOB_QUOTA_BYTES` | `10737418240` (10 GiB) | No | Per-tenant blob storage quota in bytes. |
| `PLENARY_BLOB_REAP_MS` | `600000` (10 min) | No | Gateway unreferenced-blob reaper interval in ms (`1000`–`86400000`). |
| `PLENARY_TRASH_SWEEP_MS` | `600000` (10 min) | No | Expired-Trash board purge interval in ms (`1000`–`86400000`). |

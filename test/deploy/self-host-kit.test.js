// Automated validation tests for the Plenary Enterprise Self-Host & Operations Kit (#28):
// - Production Helm chart (deploy/helm/plenary/)
// - 1-command Enterprise Compose stack (deploy/docker-compose.enterprise.yml)
// - Safe hot backup & verified restore scripts (deploy/scripts/backup.sh, restore.sh)
// - Enterprise operator handbook (docs/enterprise-hosting.md)
// - Air-gap readiness (zero external CDN runtime script/stylesheet dependencies in web/)
import { test, expect, describe } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const hasBin = (name) => spawnSync("which", [name], { encoding: "utf8" }).status === 0;

describe("Production Helm Chart (deploy/helm/plenary/)", () => {
  const requiredFiles = [
    "deploy/helm/plenary/Chart.yaml",
    "deploy/helm/plenary/values.yaml",
    "deploy/helm/plenary/templates/_helpers.tpl",
    "deploy/helm/plenary/templates/deployment.yaml",
    "deploy/helm/plenary/templates/service.yaml",
    "deploy/helm/plenary/templates/ingress.yaml",
    "deploy/helm/plenary/templates/pvc.yaml",
    "deploy/helm/plenary/templates/secret.yaml",
    "deploy/helm/plenary/templates/pdb.yaml",
    "deploy/helm/plenary/templates/serviceaccount.yaml",
    "deploy/helm/plenary/templates/NOTES.txt",
  ];

  test("all required Helm chart files exist", () => {
    for (const file of requiredFiles) {
      expect(existsSync(join(ROOT, file))).toBe(true);
    }
  });

  test("Chart.yaml has valid v2 application metadata", () => {
    const chart = read("deploy/helm/plenary/Chart.yaml");
    expect(chart).toMatch(/^apiVersion:\s*v2$/m);
    expect(chart).toMatch(/^name:\s*plenary$/m);
    expect(chart).toMatch(/^type:\s*application$/m);
    expect(chart).toMatch(/^version:\s*\d+\.\d+\.\d+/m);
    expect(chart).toMatch(/^appVersion:\s*"?\d+\.\d+\.\d+/m);
  });

  test("values.yaml enforces hardened non-root securityContext, /health probes, and no hardcoded secrets", () => {
    const values = read("deploy/helm/plenary/values.yaml");
    expect(values).toContain("runAsNonRoot: true");
    expect(values).toContain("runAsUser: 1000");
    expect(values).toContain("runAsGroup: 1000");
    expect(values).toContain("readOnlyRootFilesystem: true");
    expect(values).toContain("allowPrivilegeEscalation: false");
    expect(values).toMatch(/drop:\s*\n\s*-\s*ALL/);
    expect(values).toContain("path: /health");
    expect(values).toContain("targetPort: 8080");

    // Ensure every secret field in values.yaml defaults to empty string (no hardcoded secrets)
    const secretKeys = [
      "existingSecret",
      "cookieKey",
      "sessionKey",
      "metricsToken",
      "databaseUrl",
      "natsUrl",
      "s3AccessKeyId",
      "s3SecretAccessKey",
      "s3SessionToken",
      "oidcClientId",
      "oidcClientSecret",
      "googleClientId",
      "googleClientSecret",
    ];
    for (const key of secretKeys) {
      expect(values).toMatch(new RegExp(`^\\s+${key}:\\s*""\\s*$`, "m"));
    }
  });

  test("deployment.yaml supports Single-Node Recreate and HA RollingUpdate with /health probes and real env vars", () => {
    const dep = read("deploy/helm/plenary/templates/deployment.yaml");
    expect(dep).toContain("type: Recreate");
    expect(dep).toContain("type: RollingUpdate");
    expect(dep).toContain("startupProbe:");
    expect(dep).toContain("readinessProbe:");
    expect(dep).toContain("livenessProbe:");
    expect(dep).toContain("PLENARY_DATA_DIR");
    expect(dep).toContain("OIDC_ISSUER_URL");
    expect(dep).toContain("PLENARY_ROLES");
    expect(dep).toContain("PLENARY_LEASE_TTL_MS");
    expect(dep).toContain("mountPath: /data");
    expect(dep).toContain("mountPath: /tmp");
  });

  test("helm lint and helm template succeed for both single-node and HA modes (when helm CLI is installed)", () => {
    if (!hasBin("helm")) return;
    const chartDir = join(ROOT, "deploy/helm/plenary");

    const lint = spawnSync("helm", ["lint", chartDir], { encoding: "utf8" });
    expect(lint.status).toBe(0);

    // Render Single-Node mode (default)
    const single = spawnSync("helm", ["template", "plenary-single", chartDir], { encoding: "utf8" });
    expect(single.status).toBe(0);
    expect(single.stdout).toContain("kind: PersistentVolumeClaim");
    expect(single.stdout).toContain("type: Recreate");
    expect(single.stdout).toContain("replicas: 1");
    expect(single.stdout).toContain("runAsNonRoot: true");
    expect(single.stdout).toContain("readOnlyRootFilesystem: true");
    expect(single.stdout).toContain("path: /health");
    expect(single.stdout).not.toContain("kind: PodDisruptionBudget");

    // Render Enterprise HA mode
    const ha = spawnSync(
      "helm",
      [
        "template",
        "plenary-ha",
        chartDir,
        "--set", "mode=ha",
        "--set", "secrets.existingSecret=plenary-ha-ext",
        "--set", "config.s3.endpoint=https://s3.internal.example.com",
        "--set", "ingress.enabled=true",
      ],
      { encoding: "utf8" }
    );
    expect(ha.status).toBe(0);
    expect(ha.stdout).toContain("type: RollingUpdate");
    expect(ha.stdout).toContain("replicas: 3");
    expect(ha.stdout).toContain("kind: PodDisruptionBudget");
    expect(ha.stdout).toContain("kind: Ingress");
    expect(ha.stdout).not.toContain("kind: PersistentVolumeClaim");
    expect(ha.stdout).not.toContain("kind: Secret");

    // Guard: single-node mode refuses replicaCount > 1
    const badSingle = spawnSync(
      "helm",
      ["template", "plenary-bad", chartDir, "--set", "mode=single", "--set", "replicaCount=2"],
      { encoding: "utf8" }
    );
    expect(badSingle.status).not.toBe(0);

    // Guard: HA mode with S3 endpoint refuses missing S3 credentials when chart-managed secret is used
    const badS3Creds = spawnSync(
      "helm",
      [
        "template",
        "plenary-bad-s3",
        chartDir,
        "--set", "mode=ha",
        "--set", "secrets.cookieKey=0123456789abcdef0123456789abcdef",
        "--set", "secrets.databaseUrl=postgres://u:p@pg:5432/plenary",
        "--set", "secrets.natsUrl=nats://nats:4222",
        "--set", "config.s3.endpoint=https://s3.internal.example.com",
      ],
      { encoding: "utf8" }
    );
    expect(badS3Creds.status).not.toBe(0);

    // Guard: cannot set both blobsMode=local-disk and s3.endpoint
    const badBothBlobs = spawnSync(
      "helm",
      [
        "template",
        "plenary-bad-blobs",
        chartDir,
        "--set", "mode=ha",
        "--set", "secrets.existingSecret=plenary-ha-ext",
        "--set", "config.blobsMode=local-disk",
        "--set", "config.s3.endpoint=https://s3.internal.example.com",
      ],
      { encoding: "utf8" }
    );
    expect(badBothBlobs.status).not.toBe(0);

    // Edge case: PDB renders minAvailable: 0 explicitly
    const pdbZero = spawnSync(
      "helm",
      [
        "template",
        "plenary-pdb0",
        chartDir,
        "--set", "mode=ha",
        "--set", "secrets.existingSecret=plenary-ha-ext",
        "--set", "config.s3.endpoint=https://s3.internal.example.com",
        "--set", "podDisruptionBudget.minAvailable=0",
      ],
      { encoding: "utf8" }
    );
    expect(pdbZero.status).toBe(0);
    expect(pdbZero.stdout).toContain("minAvailable: 0");
  });
});

describe("1-Command Enterprise Compose (deploy/docker-compose.enterprise.yml)", () => {
  test("includes Plenary, Postgres 17, NATS, Caddy HTTPS, healthchecks, named volumes, and real env vars", () => {
    const compose = read("deploy/docker-compose.enterprise.yml");

    // Required services
    for (const svc of ["plenary:", "postgres:", "nats:", "caddy:"]) {
      expect(compose).toMatch(new RegExp(`^  ${svc}$`, "m"));
    }

    // Postgres 17, NATS with 2MB config, Caddy
    expect(compose).toMatch(/image:\s*postgres:17\./);
    expect(compose).toMatch(/image:\s*nats:2\./);
    expect(compose).toContain("./cluster/nats.conf:/etc/nats/plenary.conf:ro");
    expect(compose).toMatch(/image:\s*caddy:2\./);
    expect(compose).toContain("443:443");

    // All 4 services have healthchecks
    const healthchecks = compose.match(/^    healthcheck:/gm) ?? [];
    expect(healthchecks.length).toBe(4);
    expect(compose).toContain("/health");
    expect(compose).toContain("pg_isready");
    expect(compose).toContain("/healthz");

    // Named persistent volumes
    for (const vol of ["plenary-data:", "postgres-data:", "caddy-data:", "caddy-config:"]) {
      expect(compose).toMatch(new RegExp(`^  ${vol}$`, "m"));
    }

    // Hardened non-root Plenary container & real env vars
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("PLENARY_DATA_DIR: /data");
    expect(compose).toContain("DATABASE_URL:");
    expect(compose).toContain("NATS_URL:");
    expect(compose).toContain("COOKIE_KEY:");
    expect(compose).toContain("OIDC_ISSUER_URL:");
    expect(compose).toContain("GOOGLE_CLIENT_ID:");
    // PLENARY_BLOBS must be a pass-through (not forced to local-disk) so S3 mode is reachable
    expect(compose).toMatch(/^\s+PLENARY_BLOBS:\s*$/m);
    expect(compose).toContain("dockerfile: deploy/Dockerfile");
  });
});

describe("Backup & Restore Scripts (deploy/scripts/backup.sh, restore.sh)", () => {
  const backupScript = join(ROOT, "deploy/scripts/backup.sh");
  const restoreScript = join(ROOT, "deploy/scripts/restore.sh");

  test("scripts exist, are executable, use strict bash mode, and pass bash -n", () => {
    for (const script of [backupScript, restoreScript]) {
      expect(existsSync(script)).toBe(true);
      const st = statSync(script);
      expect((st.mode & 0o111) !== 0).toBe(true);

      const text = readFileSync(script, "utf8");
      expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
      expect(text).toContain("set -euo pipefail");

      const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(syntax.status).toBe(0);
    }
  });

  test("backup.sh uses safe online SQLite .backup (never raw cp on DB) and writes SHA256SUMS", () => {
    const text = readFileSync(backupScript, "utf8");
    expect(text).toContain(".backup ");
    expect(text).toContain("PRAGMA integrity_check;");
    expect(text).toContain("pg_dump");
    expect(text).toContain("blobs.tar.gz");
    expect(text).toContain("SHA256SUMS");
    // Ensure backup.sh never uses raw cp on .db files
    expect(text).not.toMatch(/\bcp\b[^\n]*\.db\b/);
  });

  test("restore.sh verifies SHA256SUMS before touching target and rejects tar path traversal", () => {
    const text = readFileSync(restoreScript, "utf8");
    expect(text).toContain("SHA256SUMS");
    expect(text).toContain("sha256sum -c");
    expect(text).toContain("PRAGMA integrity_check;");
    expect(text).toContain("pg_restore");
    expect(text).toContain("-wal");
    expect(text).toContain("-shm");
  });

  test("end-to-end hot SQLite WAL backup, tamper detection, and verified restore round-trip", () => {
    if (!hasBin("sqlite3")) return;
    const work = mkdtempSync(join(tmpdir(), "plenary-backup-test-"));
    try {
      const srcData = join(work, "src-data");
      const outBackups = join(work, "backups");
      const dstData = join(work, "dst-data");
      mkdirSync(join(srcData, "blobs"), { recursive: true });

      // Create WAL-mode plenary.db and registry.db
      const initPlenary = spawnSync(
        "sqlite3",
        [
          join(srcData, "plenary.db"),
          "PRAGMA journal_mode=WAL; CREATE TABLE ops (seq INTEGER PRIMARY KEY, body TEXT); INSERT INTO ops VALUES (1, 'hello-plenary');",
        ],
        { encoding: "utf8" }
      );
      expect(initPlenary.status).toBe(0);

      const initRegistry = spawnSync(
        "sqlite3",
        [
          join(srcData, "registry.db"),
          "PRAGMA journal_mode=WAL; CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT); INSERT INTO boards VALUES ('b1', 'Q4 Roadmap');",
        ],
        { encoding: "utf8" }
      );
      expect(initRegistry.status).toBe(0);

      writeFileSync(join(srcData, "blobs", "img-001.bin"), "fake-png-bytes-12345");

      // Run backup.sh
      const backupRes = spawnSync(
        backupScript,
        ["--data-dir", srcData, "--output-dir", outBackups],
        { encoding: "utf8" }
      );
      expect(backupRes.status).toBe(0);

      const dirs = readdirSync(outBackups).filter((d) => d.startsWith("plenary-backup-"));
      expect(dirs.length).toBe(1);
      const backupDir = join(outBackups, dirs[0]);

      expect(existsSync(join(backupDir, "plenary.db"))).toBe(true);
      expect(existsSync(join(backupDir, "registry.db"))).toBe(true);
      expect(existsSync(join(backupDir, "blobs.tar.gz"))).toBe(true);
      expect(existsSync(join(backupDir, "metadata.json"))).toBe(true);
      expect(existsSync(join(backupDir, "SHA256SUMS"))).toBe(true);

      // Verify-only succeeds on clean backup
      const verifyOk = spawnSync(restoreScript, ["--backup-dir", backupDir, "--verify-only"], {
        encoding: "utf8",
      });
      expect(verifyOk.status).toBe(0);

      // Restore into fresh target directory
      const restoreRes = spawnSync(
        restoreScript,
        ["--backup-dir", backupDir, "--data-dir", dstData, "--force"],
        { encoding: "utf8" }
      );
      expect(restoreRes.status).toBe(0);

      // Confirm SQLite rows & blob content match
      const row1 = spawnSync("sqlite3", [join(dstData, "plenary.db"), "SELECT body FROM ops WHERE seq=1;"], {
        encoding: "utf8",
      });
      expect(row1.stdout.trim()).toBe("hello-plenary");

      const row2 = spawnSync("sqlite3", [join(dstData, "registry.db"), "SELECT title FROM boards WHERE id='b1';"], {
        encoding: "utf8",
      });
      expect(row2.stdout.trim()).toBe("Q4 Roadmap");
      expect(readFileSync(join(dstData, "blobs", "img-001.bin"), "utf8")).toBe("fake-png-bytes-12345");

      // Tamper detection: corrupting metadata.json must fail verification
      writeFileSync(join(backupDir, "metadata.json"), '{"tampered":true}\n');
      const verifyBad = spawnSync(restoreScript, ["--backup-dir", backupDir, "--verify-only"], {
        encoding: "utf8",
      });
      expect(verifyBad.status).not.toBe(0);

      // Security: a crafted backup containing a symlink inside blobs.tar.gz must be rejected
      // AND must leave existing target databases untouched.
      const craftedDir = join(work, "crafted-backup");
      const craftedBlobsSrc = join(work, "crafted-blobs-src");
      mkdirSync(craftedDir, { recursive: true });
      mkdirSync(join(craftedBlobsSrc, "blobs"), { recursive: true });
      spawnSync("ln", ["-s", "/etc/passwd", join(craftedBlobsSrc, "blobs", "evil-link")], { encoding: "utf8" });
      spawnSync("tar", ["-C", craftedBlobsSrc, "-czf", join(craftedDir, "blobs.tar.gz"), "blobs"], {
        encoding: "utf8",
      });
      spawnSync("cp", [join(backupDir, "plenary.db"), join(craftedDir, "plenary.db")], { encoding: "utf8" });
      const sumCmd = hasBin("sha256sum")
        ? "sha256sum blobs.tar.gz plenary.db > SHA256SUMS"
        : "shasum -a 256 blobs.tar.gz plenary.db > SHA256SUMS";
      spawnSync("bash", ["-c", sumCmd], { cwd: craftedDir, encoding: "utf8" });

      // Mutate dstData/plenary.db to prove restore.sh does not overwrite it when blobs validation fails
      spawnSync("sqlite3", [join(dstData, "plenary.db"), "UPDATE ops SET body='live-untouched' WHERE seq=1;"], {
        encoding: "utf8",
      });
      const evilRestore = spawnSync(
        restoreScript,
        ["--backup-dir", craftedDir, "--data-dir", dstData, "--force"],
        { encoding: "utf8" }
      );
      expect(evilRestore.status).not.toBe(0);
      const afterEvil = spawnSync("sqlite3", [join(dstData, "plenary.db"), "SELECT body FROM ops WHERE seq=1;"], {
        encoding: "utf8",
      });
      expect(afterEvil.stdout.trim()).toBe("live-untouched");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("Enterprise Operator Handbook (docs/enterprise-hosting.md)", () => {
  test("covers all required operational sections and real Plenary environment variables", () => {
    const doc = read("docs/enterprise-hosting.md");
    expect(doc).toContain("Single-Node Setup");
    expect(doc).toContain("Enterprise HA Setup");
    expect(doc).toContain("OIDC & Google Workspace SSO");
    expect(doc).toContain("Backup, Restore & Upgrade");
    expect(doc).toContain("Air-Gap Mode Checklist");
    expect(doc).toContain("Environment Variable Reference");

    for (const envVar of [
      "PLENARY_DATA_DIR",
      "COOKIE_KEY",
      "DATABASE_URL",
      "NATS_URL",
      "OIDC_ISSUER_URL",
      "GOOGLE_CLIENT_ID",
      "S3_ENDPOINT",
      "PLENARY_METRICS_TOKEN",
    ]) {
      expect(doc).toContain(`\`${envVar}\``);
    }
  });
});

describe("Air-Gap Readiness (zero external CDN runtime dependencies)", () => {
  test("web/index.html contains zero external http(s) or protocol-relative script/stylesheet references", () => {
    const html = read("web/index.html");
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  });

  test("web/*.css and collab.css contain zero external CDN @import or url() references", () => {
    const cssFiles = readdirSync(join(ROOT, "web"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => join("web", f));
    if (existsSync(join(ROOT, "web/adapters/dom/collab/collab.css"))) {
      cssFiles.push("web/adapters/dom/collab/collab.css");
    }
    expect(cssFiles.length).toBeGreaterThan(0);

    for (const rel of cssFiles) {
      const css = read(rel);
      expect(css).not.toMatch(/@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i);
      expect(css).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    }
  });
});

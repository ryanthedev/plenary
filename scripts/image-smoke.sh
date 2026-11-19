#!/usr/bin/env bash
# Image smoke test: build deploy/Dockerfile, start the container, wait for health, assert it runs as non-root and
# stops cleanly on SIGTERM. Works with docker or podman (CONTAINER_CLI=podman). Cleans up what it creates.
# Usage: scripts/image-smoke.sh [tag]     (default tag plenary-smoke-$$)
set -euo pipefail
cd "$(dirname "$0")/.."
cli="${CONTAINER_CLI:-docker}"
tag="${1:-plenary-smoke-$$}"
name="$tag"
cleanup() { "$cli" rm -f "$name" >/dev/null 2>&1 || true; "$cli" rmi -f "$tag" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fmt=(); [ "$cli" = podman ] && fmt=(--format docker)   # podman drops HEALTHCHECK in OCI format
"$cli" build ${fmt[@]+"${fmt[@]}"} -f deploy/Dockerfile \
  --build-arg VERSION=smoke --build-arg REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  -t "$tag" .
echo "image size: $("$cli" image inspect "$tag" --format '{{.Size}}') bytes"

# Port 0 on the host side: the runtime picks a free port.
"$cli" run -d --name "$name" -p 127.0.0.1::8080 "$tag" >/dev/null
port="$("$cli" port "$name" 8080/tcp | head -1 | sed 's/.*://')"

ok=; deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "no /health within 60 s" >&2; "$cli" logs "$name" >&2; exit 1; }
echo "healthy on host port $port"

# The image's own HEALTHCHECK command must exist and pass (run it now: the first scheduled run is 30 s away).
[ "$("$cli" inspect "$name" --format '{{len .Config.Healthcheck.Test}}')" -gt 0 ] || { echo "no HEALTHCHECK" >&2; exit 1; }
if [ "$cli" = podman ]; then "$cli" healthcheck run "$name"; else "$cli" exec "$name" bun -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; fi
echo "healthcheck passes"
uid="$("$cli" exec "$name" id -u)"; gid="$("$cli" exec "$name" id -g)"
[ "$uid" != 0 ] && [ "$gid" != 0 ] || { echo "container runs as root ($uid:$gid)" >&2; exit 1; }
echo "runs as $uid:$gid"
rev="$("$cli" inspect "$tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[ "$rev" = "$(git rev-parse HEAD 2>/dev/null || echo unknown)" ] || { echo "revision label is '$rev'" >&2; exit 1; }
"$cli" exec "$name" sh -c 'touch /data/.w && rm /data/.w' || { echo "/data not writable" >&2; exit 1; }
if "$cli" exec "$name" sh -c 'touch /app/.w' 2>/dev/null; then echo "/app is writable" >&2; exit 1; fi

# SIGTERM: the server must exit on its own well inside the 10 s stop grace, not be killed.
start=$SECONDS
"$cli" stop -t 10 "$name" >/dev/null
code="$("$cli" inspect "$name" --format '{{.State.ExitCode}}')"
echo "stopped in $((SECONDS - start)) s, exit code $code"
[ "$code" = 0 ] || { echo "expected exit 0 on SIGTERM, got $code (137 = killed)" >&2; "$cli" logs "$name" >&2; exit 1; }
echo "smoke OK"

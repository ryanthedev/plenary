#!/usr/bin/env bash
# Image smoke test: start a container, wait for health, assert it runs as non-root with read-only app code and stops
# cleanly on SIGTERM. Works with docker or podman (CONTAINER_CLI=podman); removes the container it starts.
# Usage:
#   scripts/image-smoke.sh [tag]           build deploy/Dockerfile as <tag> (default plenary-smoke-$$), test it, remove
#                                          the image. Refuses a tag that already exists.
#   SMOKE_IMAGE=<ref> scripts/image-smoke.sh   test an existing image (no build); the image is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
cli="${CONTAINER_CLI:-docker}"; cliname="$(basename "$cli")"
name="plenary-smoke-$$-$RANDOM"   # always generated: the trap can only remove what this run created
built=
cleanup() { "$cli" rm -f "$name" >/dev/null 2>&1 || true; [ -z "$built" ] || "$cli" rmi -f "$tag" >/dev/null 2>&1 || true; }
trap cleanup EXIT

revision="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "${SMOKE_IMAGE:-}" ]; then
  [ $# -eq 0 ] || { echo "give either SMOKE_IMAGE or a tag argument, not both" >&2; exit 1; }
  tag="$SMOKE_IMAGE"; check_rev=
else
  tag="${1:-plenary-smoke-$$}"; check_rev=1
  if "$cli" image inspect "$tag" >/dev/null 2>&1; then echo "image '$tag' already exists; refusing to overwrite and delete it" >&2; exit 1; fi
  fmt=(); [ "$cliname" = podman ] && fmt=(--format docker)   # podman drops HEALTHCHECK in OCI format
  built=1
  "$cli" build ${fmt[@]+"${fmt[@]}"} -f deploy/Dockerfile --build-arg VERSION=smoke --build-arg REVISION="$revision" -t "$tag" .
fi
echo "image size: $("$cli" image inspect "$tag" --format '{{.Size}}') bytes ($cliname's measure)"

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

# The image's own HEALTHCHECK must exist and report healthy.
[ "$("$cli" inspect "$name" --format '{{len .Config.Healthcheck.Test}}')" -gt 0 ] || { echo "no HEALTHCHECK" >&2; exit 1; }
if [ "$cliname" = podman ]; then
  "$cli" healthcheck run "$name"   # podman has no scheduler without systemd: run it once
else
  ok=; deadline=$((SECONDS + 90))  # first scheduled run is one interval (30 s) after start
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$("$cli" inspect "$name" --format '{{.State.Health.Status}}')" = healthy ] && { ok=1; break; }
    sleep 2
  done
  [ -n "$ok" ] || { echo "health status never became healthy" >&2; "$cli" inspect "$name" --format '{{json .State.Health}}' >&2; exit 1; }
fi
echo "healthcheck passes"

uid="$("$cli" exec "$name" id -u)"; gid="$("$cli" exec "$name" id -g)"
[ "$uid" != 0 ] && [ "$gid" != 0 ] || { echo "container runs as root ($uid:$gid)" >&2; exit 1; }
echo "runs as $uid:$gid"
if [ -n "$check_rev" ]; then
  rev="$("$cli" inspect "$tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [ "$rev" = "$revision" ] || { echo "revision label is '$rev'" >&2; exit 1; }
fi
"$cli" exec "$name" sh -c 'touch /data/.w && rm /data/.w' || { echo "/data not writable" >&2; exit 1; }
for d in /app /app/server /app/web /app/packages /app/node_modules; do
  if "$cli" exec "$name" sh -c "touch $d/.w" 2>/dev/null; then echo "$d is writable by uid $uid" >&2; exit 1; fi
done

# SIGTERM: the server must exit on its own well inside the 10 s stop grace, not be killed.
start=$SECONDS
"$cli" stop -t 10 "$name" >/dev/null
code="$("$cli" inspect "$name" --format '{{.State.ExitCode}}')"
echo "stopped in $((SECONDS - start)) s, exit code $code"
[ "$code" = 0 ] || { echo "expected exit 0 on SIGTERM, got $code (137 = killed)" >&2; "$cli" logs "$name" >&2; exit 1; }
echo "smoke OK"

#!/usr/bin/env bash
# Checks a machine built by install-host.sh, with an empty data disk standing
# in for a new user's. Runs on the test machine in the image pipeline and can
# be run by hand. Exits non-zero, with the reason, on the first failure.
set -euo pipefail

source /etc/companion.env
scratch="$(mktemp -d)"
trap 'docker rm -f companion-test >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
chown 1000:1000 "$scratch"

[ "$(systemctl is-enabled docker.service)" = enabled ] || { echo "docker is not enabled"; exit 1; }
! systemctl is-enabled ssh.service 2>/dev/null | grep -qx enabled || { echo "ssh is still enabled"; exit 1; }

docker run -d --name companion-test --shm-size=1g -v "$scratch":/data "$COMPANION_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec companion-test curl -fsS localhost:3010/health >/dev/null 2>&1 && break
  sleep 2
done
docker exec companion-test curl -fsS localhost:3010/health
echo
# Chrome and a desktop app, not only the health route.
# A second try is allowed: the first start of Chrome reads a disk that is still filling in.
docker exec companion-test tsx scripts/smoke-stack.ts \
  || { echo "retrying once"; docker exec companion-test tsx scripts/smoke-stack.ts; }
echo "host ok"

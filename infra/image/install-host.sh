#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 x86_64 machine into a host for users' microVMs
# (ADR 0005). It can be run by hand on a test machine:
#
#   sudo ./install-host.sh ghcr.io/<owner>/companion@sha256:<digest> <commit>
#
# It installs Firecracker and its guest kernel (both pinned by checksum), Node,
# and the host agent from the given commit; turns the container image, pulled
# by digest, into the read-only root filesystem every microVM shares; removes
# Docker and remote login; and adds the service that runs the agent. Nothing
# here is secret: the relay token and any keys arrive at boot, from the
# control plane's settings.
set -euo pipefail

IMAGE_REF="${1:?Usage: install-host.sh <image reference with @sha256 digest> <commit>}"
COMMIT="${2:?Usage: install-host.sh <image reference with @sha256 digest> <commit>}"
case "$IMAGE_REF" in
  *@sha256:*) ;;
  *) echo "The image must be pinned by digest, not a tag." >&2; exit 1 ;;
esac
[ "$(dpkg --print-architecture)" = "amd64" ] || { echo "x86_64 only" >&2; exit 1; }

FIRECRACKER_VERSION=1.18.0
FIRECRACKER_SHA256=1ac8eec866dd5eea14efecf6323e22b23eea24054545338a5b34bc5bca6623cd
KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-6.1.155
KERNEL_SHA256=e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53
NODE_VERSION=24.18.0
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
TSX_VERSION=4.23.15
HOST_DIR=/var/lib/companion-host

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git docker.io e2fsprogs iproute2 iptables procps \
  unattended-upgrades xz-utils

# No remote login of any kind: the machine is reached only through the relay.
systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
apt-get purge -y openssh-server || true
dpkg-reconfigure -f noninteractive unattended-upgrades

# Firecracker and its jailer.
cd /tmp
curl -fsSLo firecracker.tgz \
  "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-x86_64.tgz"
echo "${FIRECRACKER_SHA256}  firecracker.tgz" | sha256sum -c -
tar -xzf firecracker.tgz
install -m 0755 "release-v${FIRECRACKER_VERSION}-x86_64/firecracker-v${FIRECRACKER_VERSION}-x86_64" /usr/local/bin/firecracker
install -m 0755 "release-v${FIRECRACKER_VERSION}-x86_64/jailer-v${FIRECRACKER_VERSION}-x86_64" /usr/local/bin/jailer
rm -rf firecracker.tgz "release-v${FIRECRACKER_VERSION}-x86_64"

# The guest kernel, and the unprivileged user every microVM runs as.
mkdir -p "$HOST_DIR"
curl -fsSLo "$HOST_DIR/vmlinux" "$KERNEL_URL"
echo "${KERNEL_SHA256}  $HOST_DIR/vmlinux" | sha256sum -c -
id fcuser >/dev/null 2>&1 || useradd --uid 1001 --no-create-home --shell /usr/sbin/nologin fcuser

# Node, tsx, and the host agent at the given commit. The agent runs from
# source, like the daemon, so it needs tsx to map its `.js` import names.
curl -fsSLo node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c -
mkdir -p /opt/node && tar -xJf node.tar.xz -C /opt/node --strip-components=1 && rm node.tar.xz
export PATH="/opt/node/bin:$PATH"
npm install --prefix /opt/tsx --no-audit --no-fund "tsx@${TSX_VERSION}"
mkdir -p /opt/companion && cd /opt/companion
git init -q repo && cd repo
git fetch -q --depth 1 https://github.com/mittal-parth/companion.git "$COMMIT"
git checkout -q FETCH_HEAD
corepack enable
pnpm install --frozen-lockfile --prod --filter "@companion/host..."

# The container image becomes the microVMs' read-only root filesystem.
systemctl start docker.service
docker pull "$IMAGE_REF"
container="$(docker create "$IMAGE_REF")"
rootfs="$HOST_DIR/rootfs.ext4"
truncate -s 6G "$rootfs"
mkfs.ext4 -q -F -L rootfs "$rootfs"
mkdir -p /mnt/rootfs
mount -o loop "$rootfs" /mnt/rootfs
docker export "$container" | tar -x -C /mnt/rootfs
docker rm "$container" >/dev/null
install -m 0755 /opt/companion/repo/infra/image/guest-init.sh /mnt/rootfs/init
mkdir -p /mnt/rootfs/config /mnt/rootfs/data
# resolv.conf is written by init into a tmpfs, because the root is read only.
ln -sf /run/resolv.conf /mnt/rootfs/etc/resolv.conf
umount /mnt/rootfs
chmod 0644 "$rootfs" "$HOST_DIR/vmlinux"
echo "$IMAGE_REF" > "$HOST_DIR/image-ref"

# Docker was only needed to unpack the image; nothing on the host runs containers.
systemctl disable --now docker.service docker.socket containerd.service 2>/dev/null || true
apt-get purge -y docker.io containerd runc || true
rm -rf /var/lib/docker /var/lib/containerd

# The agent. It reads its settings, the relay address and where to find the
# host's token, from /etc/companion-host.env, which the instance writes at launch.
cat > /etc/systemd/system/companion-host.service <<'UNIT'
[Unit]
Description=Companion host agent
After=network-online.target cloud-init.service
Wants=network-online.target

[Service]
EnvironmentFile=-/etc/companion-host.env
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/opt/companion/repo/apps/host
ExecStart=/opt/tsx/node_modules/.bin/tsx src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable companion-host.service

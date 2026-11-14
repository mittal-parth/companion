#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 arm64 machine into the host for one companion
# container. It can be run by hand on a test machine:
#
#   sudo ./install-host.sh ghcr.io/<owner>/companion@sha256:<digest>
#
# It installs Docker, removes remote login, pulls the image by digest so the
# first start needs no download, and sets up the services that mount the data
# disk and run the container. Nothing here is secret: keys arrive later, from
# the control plane.
set -euo pipefail

IMAGE_REF="${1:?Usage: install-host.sh <image reference with @sha256 digest>}"
case "$IMAGE_REF" in
  *@sha256:*) ;;
  *) echo "The image must be pinned by digest, not a tag." >&2; exit 1 ;;
esac
[ "$(dpkg --print-architecture)" = "arm64" ] || { echo "arm64 only" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io unattended-upgrades xfsprogs

# No remote login of any kind: the machine is reached only through the relay.
systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
apt-get purge -y openssh-server || true

# Security patches apply on their own between image rebuilds.
dpkg-reconfigure -f noninteractive unattended-upgrades

# Formats the data disk on its first boot, then mounts it by label. A disk that
# already holds data is never touched, so replacing the root disk keeps it.
cat > /usr/local/sbin/companion-prepare-data <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
root_disk="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)"
device=""
for candidate in $(lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}'); do
  [ "$candidate" = "$root_disk" ] && continue
  device="/dev/$candidate"
  break
done
[ -n "$device" ] || { echo "No data disk is attached." >&2; exit 1; }
if ! blkid -o value -s LABEL "$device" | grep -qx companion; then
  if [ -n "$(blkid -o value -s TYPE "$device" || true)" ]; then
    echo "$device holds a filesystem that is not ours. Refusing to format it." >&2
    exit 1
  fi
  mkfs.xfs -L companion "$device"
fi
mkdir -p /data
mountpoint -q /data || mount LABEL=companion /data
chown 1000:1000 /data
SCRIPT
chmod 0755 /usr/local/sbin/companion-prepare-data

cat > /etc/systemd/system/companion-data.service <<'UNIT'
[Unit]
Description=Prepare and mount the companion data disk
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/companion-prepare-data

[Install]
WantedBy=multi-user.target
UNIT

# The image reference the VM runs. The update flow (Task 4.5a) rewrites this.
echo "COMPANION_IMAGE=$IMAGE_REF" > /etc/companion.env

# Publishes no port: the daemon is reached from inside, and dials out to the relay.
cat > /etc/systemd/system/companion.service <<'UNIT'
[Unit]
Description=Companion daemon container
Requires=companion-data.service docker.service
After=companion-data.service docker.service network-online.target

[Service]
EnvironmentFile=/etc/companion.env
ExecStartPre=-/usr/bin/docker rm -f companion
ExecStart=/usr/bin/docker run --rm --name companion --shm-size=1g -v /data:/data ${COMPANION_IMAGE}
ExecStop=/usr/bin/docker stop -t 30 companion
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable docker.service companion-data.service companion.service

# Pulled now so the first boot starts at once. The image is public.
systemctl start docker.service
docker pull "$IMAGE_REF"

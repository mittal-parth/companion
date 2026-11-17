# Builds the microVM root filesystem from the x86 container image and a blank data volume, on a host with Docker.
# Run as root in /spike next to vmlinux and the repo (see docs/phase-4-5.md). The spike init can also start Chrome.
set -e
cd /spike
# 1. Root filesystem from the container image (read-only at run time).
if [ ! -f rootfs.ext4 ]; then
  cid=$(docker create companion-x86)
  mkdir -p mnt
  truncate -s 5G rootfs.ext4 && mkfs.ext4 -q -F rootfs.ext4
  mount -o loop rootfs.ext4 mnt
  docker export $cid | tar -x -C mnt
  docker rm $cid >/dev/null
  cat > mnt/init <<'INIT'
#!/bin/bash
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mkdir -p /dev/pts /dev/shm; mount -t devpts devpts /dev/pts; mount -t tmpfs tmpfs /dev/shm
for d in /run /tmp /var/tmp /var/log /var/lib/dbus /home/companion; do mount -t tmpfs tmpfs $d; done
chown companion:companion /home/companion
mount /dev/vdb /data
echo "init: data mounted, starting daemon uptime=$(cut -d' ' -f1 /proc/uptime)" > /dev/console
cd /app/apps/daemon
exec setpriv --reuid=1000 --regid=1000 --init-groups env -i HOME=/home/companion \
  PATH=/opt/tsx/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  COMPANION_DATA_DIR=/data COMPANION_HOST=0.0.0.0 COMPANION_CHROME_SANDBOX=off PORT=3010 \
  SARVAM_API_KEY=spike-dummy tsx src/main.ts > /dev/console 2>&1
INIT
  chmod +x mnt/init
  du -sh mnt | tail -1
  umount mnt
fi
# 2. A data volume (stands in for the user's EBS volume).
if [ ! -f data-template.ext4 ]; then
  truncate -s 2G data-template.ext4 && mkfs.ext4 -q -F data-template.ext4
  mkdir -p dmnt && mount -o loop data-template.ext4 dmnt && chown 1000:1000 dmnt && umount dmnt
fi
ls -lsh rootfs.ext4 data-template.ext4

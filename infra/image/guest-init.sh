#!/bin/bash
# The first program in a user's microVM (the kernel runs it as /init). It
# mounts the three drives the host attached, reads what the host told it at
# boot, and runs the daemon as an unprivileged user. The root filesystem is
# read only, so everything the daemon writes goes to /data or a tmpfs.
#
#   vda  root filesystem (shared by every microVM, read only)
#   vdb  the user's data volume, mounted at /data
#   vdc  a tiny private drive holding /env: the relay address and token
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs tmpfs /dev/shm
for dir in /run /tmp /var/tmp /var/log /var/lib/dbus /home/companion; do
  mount -t tmpfs tmpfs "$dir"
done
chmod 1777 /tmp /var/tmp
chown companion:companion /home/companion

# DNS: the guest may reach only the internet, so it uses public resolvers.
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /run/resolv.conf

mount /dev/vdb /data
# A fresh volume is root's; the daemon runs as uid 1000.
[ "$(stat -c %u /data)" = 1000 ] || chown 1000:1000 /data

mount -o ro /dev/vdc /config
set -a
# shellcheck disable=SC1091
. /config/env
set +a
umount /config

echo "init: ready to start the daemon, uptime $(cut -d' ' -f1 /proc/uptime)" > /dev/console
cd /app/apps/daemon || exit 1
exec setpriv --reuid=1000 --regid=1000 --init-groups env -i \
  HOME=/home/companion \
  PATH=/opt/tsx/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  COMPANION_DATA_DIR=/data COMPANION_HOST=0.0.0.0 COMPANION_CHROME_SANDBOX=off PORT=3010 \
  COMPANION_RELAY_URL="$COMPANION_RELAY_URL" COMPANION_VM_TOKEN="$COMPANION_VM_TOKEN" \
  ${SARVAM_API_KEY:+SARVAM_API_KEY="$SARVAM_API_KEY"} \
  tsx src/main.ts > /dev/console 2>&1

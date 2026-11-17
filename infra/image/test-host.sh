#!/usr/bin/env bash
# Checks a machine built by install-host.sh. Runs on the test machine in the
# image pipeline and can be run by hand. It checks the install, not a running
# microVM: the build machines do not offer nested virtualization, so booting
# one is checked on a real host (docs/phase-4-5.md). Exits non-zero, with the
# reason, on the first failure.
set -euo pipefail
export PATH="/opt/node/bin:$PATH"
dir=/var/lib/companion-host

firecracker --version | head -1 | grep -q "1.18.0" || { echo "wrong firecracker"; exit 1; }
jailer --version | head -1 | grep -q "1.18.0" || { echo "wrong jailer"; exit 1; }
[ -s "$dir/vmlinux" ] || { echo "no guest kernel"; exit 1; }
id fcuser | grep -q "uid=1001" || { echo "no fcuser"; exit 1; }
node --version | grep -q "v24" || { echo "wrong node"; exit 1; }
[ "$(systemctl is-enabled companion-host.service)" = enabled ] || { echo "agent not enabled"; exit 1; }
! systemctl is-enabled ssh.service 2>/dev/null | grep -qx enabled || { echo "ssh is still enabled"; exit 1; }
! command -v docker >/dev/null || { echo "docker is still installed"; exit 1; }

# The agent's code loads, and its own tests of the rules need no microVM.
(cd /opt/companion/repo/apps/host && /opt/tsx/node_modules/.bin/tsx --eval 'import("./src/agent.ts").then(() => console.log("agent loads"))')

# The root filesystem holds what a microVM needs: our init, the daemon, the user.
mkdir -p /mnt/check
mount -o loop,ro "$dir/rootfs.ext4" /mnt/check
trap 'umount /mnt/check 2>/dev/null || true' EXIT
[ -x /mnt/check/init ] || { echo "no /init in the root filesystem"; exit 1; }
[ -f /mnt/check/app/apps/daemon/src/main.ts ] || { echo "no daemon in the root filesystem"; exit 1; }
grep -q '^companion:x:1000' /mnt/check/etc/passwd || { echo "no companion user"; exit 1; }
[ -x /mnt/check/usr/local/bin/opencode ] || { echo "no opencode"; exit 1; }
echo "host ok"

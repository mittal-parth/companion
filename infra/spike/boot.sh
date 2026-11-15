# Usage: boot.sh N [mem_mib] [vcpus]  -- wakes microVM number N and prints ms until the daemon answers /health.
N=${1:-1}; MEM=${2:-2048}; CPU=${3:-2}
set -e
cd /spike
id=vm$N; root=/srv/jailer/firecracker/$id/root
pkill -f "id $id " 2>/dev/null || true; sleep 0.2
ip link del tap$N 2>/dev/null || true; rm -rf /srv/jailer/firecracker/$id
id -u fcuser >/dev/null 2>&1 || useradd -r -u 1001 -s /usr/sbin/nologin fcuser
t0=$(date +%s%N)
ip tuntap add tap$N mode tap user 1001 group 1001
ip addr add 172.16.$N.1/30 dev tap$N; ip link set tap$N up
mkdir -p $root
ln vmlinux $root/vmlinux; ln rootfs.ext4 $root/rootfs.ext4; chmod 644 rootfs.ext4
cp --sparse=always data-template.ext4 $root/data.ext4; chown 1001:1001 $root/data.ext4
t_prep=$(date +%s%N)
cat > $root/vm.json <<J
{"boot-source":{"kernel_image_path":"/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 pci=off ro init=/init ip=172.16.$N.2::172.16.$N.1:255.255.255.252::eth0:off random.trust_cpu=on $EXTRA"},
"drives":[{"drive_id":"rootfs","path_on_host":"/rootfs.ext4","is_root_device":true,"is_read_only":true},{"drive_id":"data","path_on_host":"/data.ext4","is_root_device":false,"is_read_only":false}],
"machine-config":{"vcpu_count":$CPU,"mem_size_mib":$MEM},
"network-interfaces":[{"iface_id":"eth0","guest_mac":"AA:FC:00:00:00:0$N","host_dev_name":"tap$N"}]}
J
nohup jailer --id $id --exec-file /usr/local/bin/firecracker --uid 1001 --gid 1001 --chroot-base-dir /srv/jailer --cgroup-version 2 -- --no-api --config-file /vm.json > /spike/$id.console 2>&1 &
t_launch=$(date +%s%N)
for i in $(seq 1 1200); do
  if curl -fsS -m 1 http://172.16.$N.2:3010/health >/dev/null 2>&1; then break; fi; sleep 0.05
done
t1=$(date +%s%N)
echo "vm$N prep_ms=$(( (t_prep-t0)/1000000 )) launch_ms=$(( (t_launch-t_prep)/1000000 )) wake_ms=$(( (t1-t0)/1000000 ))"
curl -s http://172.16.$N.2:3010/health; echo

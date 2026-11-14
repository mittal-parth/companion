#!/usr/bin/env bash
# Launches the machine image the way a user VM launches, and checks that it is
# ready and safe. Run it by hand after the pipeline builds an image:
#
#   AWS_PROFILE=companion infra/scripts/verify-image.sh ami-0123456789abcdef0
#
# A temporary copy of the machine gets the image builder's instance profile so
# SSM can run the checks inside it. A real user VM has no profile, and the first
# checks read the launch template to prove that. The machine is always deleted.
set -euo pipefail

AMI="${1:?Usage: verify-image.sh <ami-id>}"
region="${AWS_REGION:-$(aws configure get region)}"
export AWS_DEFAULT_REGION="$region"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# 1. The launch settings every user VM gets.
template="companion-user-vm"
data="$(aws ec2 describe-launch-template-versions --launch-template-name "$template" \
  --versions '$Latest' --query 'LaunchTemplateVersions[0].LaunchTemplateData' --output json)"
echo "$data" | jq -e '.MetadataOptions.HttpTokens == "required"' >/dev/null || fail "metadata v2 is not required"
ok "launch template requires IMDSv2"
echo "$data" | jq -e '.IamInstanceProfile == null' >/dev/null || fail "the launch template gives user VMs an instance profile"
ok "launch template has no instance profile"
echo "$data" | jq -e '[.BlockDeviceMappings[] | select(.DeviceName=="/dev/sdf") | .Ebs.DeleteOnTermination == false] | any' >/dev/null \
  || fail "the data disk does not outlive the machine"
ok "data disk outlives the machine"

subnet="$(aws cloudformation describe-stacks --stack-name CompanionVmNetwork \
  --query "Stacks[0].Outputs[?OutputKey=='SubnetIds'].OutputValue" --output text | cut -d, -f1)"

# 2. Launch it, with the build profile for the test only.
instance="$(aws ec2 run-instances --image-id "$AMI" --count 1 \
  --launch-template "LaunchTemplateName=$template,Version=\$Latest" \
  --subnet-id "$subnet" --iam-instance-profile Name=companion-image-builder \
  --query 'Instances[0].InstanceId' --output text)"
trap 'echo "Deleting $instance"; aws ec2 terminate-instances --instance-ids "$instance" >/dev/null; \
  aws ec2 wait instance-terminated --instance-ids "$instance" || true; \
  vol="$(aws ec2 describe-volumes --filters Name=tag:verify-image,Values="$instance" --query "Volumes[].VolumeId" --output text 2>/dev/null)"; \
  for v in $vol; do aws ec2 delete-volume --volume-id "$v" >/dev/null 2>&1 || true; done' EXIT
echo "Launched $instance"
aws ec2 wait instance-status-ok --instance-ids "$instance"
ok "instance passed its EC2 status checks"

# The data disk is left behind on termination on purpose, so this test removes it.
data_volume="$(aws ec2 describe-instances --instance-ids "$instance" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sdf'].Ebs.VolumeId" --output text)"
aws ec2 create-tags --resources "$data_volume" --tags "Key=verify-image,Value=$instance"

aws ec2 describe-instances --instance-ids "$instance" \
  --query 'Reservations[0].Instances[0].MetadataOptions.HttpTokens' --output text | grep -qx required \
  || fail "the running instance does not require IMDSv2"
ok "running instance requires IMDSv2"

# 3. Wait for the SSM agent, then check inside the machine.
for _ in $(seq 1 40); do
  online="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$online" = Online ] && break
  sleep 6
done
[ "$online" = Online ] || fail "SSM never saw the instance"

run_on_instance() {
  local id
  id="$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --parameters "commands=[\"$1\"]" --query 'Command.CommandId' --output text)"
  aws ssm wait command-executed --command-id "$id" --instance-id "$instance" 2>/dev/null || true
  aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --output json
}
expect_in_instance() { # description, command, regex the output must match
  local out
  out="$(run_on_instance "$2")"
  [ "$(echo "$out" | jq -r .Status)" = Success ] || fail "$1: $(echo "$out" | jq -r '.StandardErrorContent')"
  echo "$out" | jq -r .StandardOutputContent | grep -Eq "$3" || fail "$1: $(echo "$out" | jq -r .StandardOutputContent)"
  ok "$1"
}

# The daemon starts by itself on a data disk that was empty at launch.
for _ in $(seq 1 30); do
  run_on_instance "docker exec companion curl -fsS localhost:3010/health" \
    | jq -r .StandardOutputContent | grep -q '"status":"ok"' && break
  sleep 6
done
expect_in_instance "daemon is healthy on a fresh data disk" "docker exec companion curl -fsS localhost:3010/health" '"status":"ok"'
expect_in_instance "data disk is mounted and owned by the daemon" "stat -c '%U:%u' /data; findmnt -no LABEL /data; docker exec companion stat -c '%U' /data/threads.db" 'companion'
expect_in_instance "Chrome and a desktop app start" "docker exec companion tsx scripts/smoke-stack.ts" 'stack ok'
# Nothing listens on the host except what the operating system itself needs.
expect_in_instance "no port is exposed to the network" \
  "ss -Htln | awk '{print \$4}' | grep -vE '^(127\\.|\\[::1\\]|localhost)' | grep -vE ':(68)\$' | wc -l" '^0$'
expect_in_instance "no remote login service" "systemctl is-enabled ssh.service 2>&1 || true" 'not-found|disabled|masked'
expect_in_instance "no secret in the container's environment" \
  "docker exec companion env | grep -ciE 'api_key|secret|token' || true" '^0$'
echo "All checks passed for $AMI."

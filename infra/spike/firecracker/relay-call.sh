#!/usr/bin/env bash
# Calls a VM or the host agent through the relay: relay-call.sh <vm-id> <METHOD> <path> [json body]
# Prints "<status> <seconds>" then the body. The secret stays in the environment.
set -euo pipefail
export AWS_PROFILE=companion AWS_REGION=ap-south-1
cd "$(dirname "$0")/../../.."
: "${RELAY_SECRET:=$(aws secretsmanager get-secret-value --secret-id RelaySecretA483CA64-5QDYy3UFyCKP --query SecretString --output text)}"
export RELAY_SECRET
TOK=$(cd apps/relay && node scripts/mint-token.ts web "$1" 60)
curl -sS -m "${CALL_TIMEOUT:-30}" -X "$2" -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  ${4:+-d "$4"} -w '\n%{http_code} %{time_total}s\n' "https://companion-relay.mittalparth.dev$3"

#!/bin/sh
set -eu

required='DATABASE_URL REDIS_URL HIVE_HARNESS_TICKET_SECRET HIVE_HARNESS_RUNNER_SERVICE_SECRET HIVEMIND_CONTROL_PLANE_URL HIVEMIND_PARENT_ORIGINS'
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "hivemind-harness: required environment variable $name is missing" >&2
    exit 64
  fi
done

if [ "${#HIVE_HARNESS_TICKET_SECRET}" -lt 32 ] || [ "${#HIVE_HARNESS_RUNNER_SERVICE_SECRET}" -lt 32 ]; then
  echo "hivemind-harness: HIVE secrets must each be at least 32 bytes" >&2
  exit 64
fi
if [ "$HIVE_HARNESS_TICKET_SECRET" = "$HIVE_HARNESS_RUNNER_SERVICE_SECRET" ]; then
  echo "hivemind-harness: admission and runner service secrets must be distinct" >&2
  exit 64
fi

exec node /opt/deepseek-harness/apps/cli/lib/bin.js --profile hivemind-web --no-open

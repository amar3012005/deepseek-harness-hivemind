#!/bin/sh
set -eu

required='DATABASE_URL REDIS_URL HIVE_HARNESS_TICKET_SECRET HIVEMIND_PARENT_ORIGINS'
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "hivemind-harness: required environment variable $name is missing" >&2
    exit 64
  fi
done

exec node /opt/deepseek-harness/apps/cli/lib/bin.js --profile hivemind-web --no-open

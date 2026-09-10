#!/bin/sh
# Build and inspect the immutable runner artifact, not the source workspace.
set -eu

image="${1:-hivemind/harness-chat:profile-parity}"

if [ "$#" -eq 0 ]; then
  docker build \
    --build-arg "DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD)" \
    -f deploy/hivemind-chat/Dockerfile \
    -t "$image" \
    .
fi

docker run --rm --entrypoint sh "$image" -ec '
  profile_dir="$(mktemp -d)"
  trap "rm -rf \"$profile_dir\"" EXIT
  node /opt/deepseek-harness/apps/cli/lib/bin.js --profile hivemind-web --dump-config > "$profile_dir/hivemind-web.yml"
  node /opt/deepseek-harness/deploy/hivemind-chat/profile-smoke.mjs "$profile_dir/hivemind-web.yml"
'

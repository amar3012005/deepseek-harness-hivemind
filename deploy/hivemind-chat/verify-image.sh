#!/bin/sh
# Build and inspect the immutable runner artifact, not the source workspace.
set -eu

image="${1:-hivemind/harness-chat:profile-parity}"

if [ "$#" -eq 0 ]; then
  if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
    echo "refusing to build from a dirty checkout; use a clean detached release commit" >&2
    exit 2
  fi
  revision="$(git rev-parse HEAD)"
  docker build \
    --platform linux/amd64 \
    --build-arg "DSH_CLIENT_COMMIT_HASH=${revision}" \
    -f deploy/hivemind-chat/Dockerfile \
    -t "$image" \
    .
fi

docker run --rm --entrypoint sh "$image" -ec '
  profile_dir="$(mktemp -d)"
  trap "rm -rf \"$profile_dir\"" EXIT
  export DSH_HOME="$profile_dir/dsh"
  mkdir -p "$DSH_HOME/profiles/hivemind-web"
  cp /opt/deepseek-harness/deploy/hivemind-chat/profile.package.json "$DSH_HOME/profiles/hivemind-web/package.json"
  : > "$DSH_HOME/profiles/hivemind-web/cordis.patch.yml"
  /usr/local/bin/hivemind-harness-prepare-profile
  node /opt/deepseek-harness/apps/cli/lib/bin.js --profile hivemind-web --dump-config > "$profile_dir/hivemind-web.yml"
  node /opt/deepseek-harness/deploy/hivemind-chat/verify-profile.mjs "$profile_dir/hivemind-web.yml"
  node /opt/deepseek-harness/deploy/hivemind-chat/verify-runtime-packages.mjs
  node /opt/deepseek-harness/deploy/hivemind-chat/verify-composed-profile.mjs
'

revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
service="$(docker image inspect --format '{{ index .Config.Labels "com.singulance.service" }}' "$image")"
[ -n "$revision" ] || { echo "runner image has no source revision label" >&2; exit 1; }
[ "$service" = "harness-runner" ] || { echo "image is not labeled as the Harness runner" >&2; exit 1; }
printf 'verified image=%s revision=%s service=%s\n' "$image" "$revision" "$service"

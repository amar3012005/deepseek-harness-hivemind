#!/bin/sh
# Build and verify the immutable amd64 runner from an exact clean Git commit.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: build-image.sh <source-commit> <image-tag>" >&2
  exit 2
fi

requested="$1"
image="$2"
revision="$(git rev-parse "$requested^{commit}")"
head="$(git rev-parse HEAD)"
if [ "$revision" != "$head" ]; then
  echo "refusing to build: checkout HEAD does not match requested source commit" >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "refusing to build from a dirty checkout; use a clean detached release commit" >&2
  exit 2
fi
short="$(git rev-parse --short=12 "$revision")"
case "$image" in
  *":sha-${short}"|*":sha-${short}-"*) ;;
  *) echo "image tag must carry the source revision suffix :sha-${short}" >&2; exit 2 ;;
esac

docker build \
  --platform linux/amd64 \
  --build-arg "DSH_CLIENT_COMMIT_HASH=${revision}" \
  -f deploy/hivemind-chat/Dockerfile \
  -t "$image" \
  .
sh deploy/hivemind-chat/verify-image.sh "$image"

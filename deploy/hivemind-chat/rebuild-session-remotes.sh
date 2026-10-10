#!/bin/sh
# Run after host compilation/generation: the assembly inlines generated Remote codecs.
set -eu
cd "$(dirname "$0")/../.."
node node_modules/typescript/bin/tsc -b --force packages/api/remotes/tsconfig.json
(cd packages/api/remotes && node ../../../node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client --config tsdown.config.ts)

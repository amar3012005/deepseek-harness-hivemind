#!/bin/sh
# Run inside the immutable overlay build after installing its locked dependencies.
set -eu
cd "$(dirname "$0")/../.."
node node_modules/typescript/bin/tsc -b --force packages/client/ui-primitives/tsconfig.json
(
  cd packages/client/ui-primitives
  node ../../../node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client --config tsdown.config.ts
)
pnpm --filter @deepseek-ai/dsh-web-frontend run build
node deploy/hivemind-chat/verify-shared-shell.mjs "$PWD"

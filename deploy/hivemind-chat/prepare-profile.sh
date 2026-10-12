#!/bin/sh
# Keep profile user data intact while ensuring HIVE preset Includes resolve
# through the same in-box package used by the CLI's native runtime resolver.
set -eu

dsh_home="${1:-${DSH_HOME:-/var/lib/dsh}}"
bundle_dir="${2:-/opt/deepseek-harness/packages/bundle/hivemind-web-app}"
profile_dir="$dsh_home/profiles/hivemind-web"
manifest="$profile_dir/package.json"
modules="$profile_dir/node_modules"
scope="$modules/@deepseek-ai"
link="$scope/dsh-hivemind-web-app"

[ -f "$manifest" ] || {
  echo "hivemind-harness: existing hivemind-web profile manifest is required" >&2
  exit 64
}
[ -d "$bundle_dir" ] || {
  echo "hivemind-harness: canonical in-box HIVE bundle is missing" >&2
  exit 70
}

node - "$manifest" <<'NODE'
const fs = require('node:fs')
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bundles = profile?.dsh?.profile?.bundles
const required = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-hivemind-web-app',
]
if (!Array.isArray(bundles) || required.some((name, i) => bundles[i] !== name)) {
  throw new Error('hivemind-web profile must retain the base, web, and HIVE bundle order')
}
if (Object.keys(profile.dependencies ?? {}).length !== 0) {
  throw new Error('hivemind-web profile has private dependencies; refusing to replace its module tree')
}
NODE

if [ -L "$link" ] && [ "$(readlink -f "$link")" = "$(readlink -f "$bundle_dir")" ] \
  && [ -d "$scope" ] \
  && [ -z "$(find "$modules" -mindepth 1 -maxdepth 1 ! -name '@deepseek-ai' -print -quit)" ] \
  && [ -z "$(find "$scope" -mindepth 1 -maxdepth 1 ! -name 'dsh-hivemind-web-app' -print -quit)" ]; then
  exit 0
fi

next="$profile_dir/node_modules.native-next.$$"
[ ! -e "$next" ] && [ ! -L "$next" ] || {
  echo "hivemind-harness: profile module preparation already exists; refusing to overwrite it" >&2
  exit 70
}
mkdir -p "$next/@deepseek-ai"
ln -s "$bundle_dir" "$next/@deepseek-ai/dsh-hivemind-web-app"

backup=''
if [ -e "$modules" ] || [ -L "$modules" ]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$profile_dir/node_modules.pre-native-$stamp"
  suffix=0
  while [ -e "$backup" ] || [ -L "$backup" ]; do
    suffix=$((suffix + 1))
    backup="$profile_dir/node_modules.pre-native-$stamp-$suffix"
  done
  mv "$modules" "$backup"
fi

if ! mv "$next" "$modules"; then
  if [ -n "$backup" ] && [ ! -e "$modules" ] && [ ! -L "$modules" ]; then
    mv "$backup" "$modules"
  fi
  echo "hivemind-harness: could not publish canonical profile module link" >&2
  exit 70
fi

if [ -n "$backup" ]; then
  echo "hivemind-harness: preserved previous profile module tree at $backup" >&2
fi

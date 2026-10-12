import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../packages/bundle/hivemind-web-app/package.json', import.meta.url))
const packages = [
  '@deepseek-ai/dsh-hivemind-web-app',
  '@deepseek-ai/dsh-hivemind-connected-apps',
  '@deepseek-ai/dsh-hivemind-web-runner',
  '@deepseek-ai/dsh-hivemind-hq-runtime',
  '@deepseek-ai/dsh-client-ui-hivemind-connect',
]

for (const name of packages) {
  const entry = require.resolve(name)
  await import(pathToFileURL(entry))
  console.log(`resolved native package ${name}`)
}

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('usage: verify-profile.mjs <compiled-profile-yaml>')
const yaml = readFileSync(file, 'utf8')

const required = [
  ['hivemind-web-runner', '@deepseek-ai/dsh-hivemind-web-runner'],
  ['hivemind-hq-runtime', '@deepseek-ai/dsh-hivemind-hq-runtime'],
  ['hivemind-connected-apps', '@deepseek-ai/dsh-hivemind-connected-apps'],
  ['hivemind-artifact-renderer', '@deepseek-ai/dsh-hivemind-artifact-renderer'],
]
for (const [id, name] of required) {
  if (!yaml.includes(`- id: ${id}`) || !yaml.includes(`name: '${name}'`)) {
    throw new Error(`hivemind-web compiled profile is missing ${id}`)
  }
  console.log(`profile contains ${id}`)
}

if (!/^\s+default: hivemind-chat$/m.test(yaml)) {
  throw new Error('hivemind-web default preset is not hivemind-chat')
}
for (const id of ['hivemind-chat', 'hivemind-hq', 'hivemind-hyperagents']) {
  if (!yaml.includes(`id: ${id}`)) throw new Error(`hivemind-web is missing preset ${id}`)
  console.log(`profile contains preset ${id}`)
}

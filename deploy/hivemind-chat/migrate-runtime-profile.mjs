/** Preserve an existing opt-in fallback while moving it off the native retry executor. */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, statSync, chownSync, chmodSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const require = createRequire('/opt/deepseek-harness/packages/boot/plugin-manager/package.json')
const { parseDocument, isSeq, isMap } = require('yaml')
const [source, outputDir] = process.argv.slice(2)
if (!source || !outputDir) throw new Error('Expected existing profile patch and private output directory')
const input = readFileSync(source, 'utf8')
const document = parseDocument(input)
if (document.errors.length || !isSeq(document.contents)) throw new Error('Profile patch is not a valid array')
const before = document.toJS()
const matches = document.contents.items.map((node, index) => ({ node, index }))
  .filter(({ node }) => isMap(node) && node.get('id') === 'llm-retry')
if (matches.length !== 1) throw new Error('Expected one saved native retry configuration')
const { node, index } = matches[0]
const config = node.get('config', true)
if (!isMap(config)) throw new Error('Saved retry configuration is not a map')
const fallback = config.get('fallback', true)
if (!isSeq(fallback)) throw new Error('Saved fallback routes are not an array')
const routes = fallback.toJSON()
const primaries = new Set()
if (!routes.length || routes.length > 16) throw new Error('Invalid fallback route count')
for (const route of routes) {
  if (!route || Object.keys(route).some(key => !['fromProvider', 'provider', 'model', 'maxTokens'].includes(key))) throw new Error('Unsupported fallback route fields')
  if (['fromProvider', 'provider', 'model'].some(key => typeof route[key] !== 'string' || !route[key].trim() || route[key].length > 200)) throw new Error('Invalid fallback route identity')
  if (route.fromProvider === route.provider || primaries.has(route.fromProvider)) throw new Error('Ambiguous fallback route')
  if (route.maxTokens !== undefined && (!Number.isInteger(route.maxTokens) || route.maxTokens < 1)) throw new Error('Invalid fallback output cap')
  primaries.add(route.fromProvider)
}
config.delete('fallback')
const expected = structuredClone(before)
delete expected[index].config.fallback
if (JSON.stringify(expected) !== JSON.stringify(document.toJS())) throw new Error('Profile changed beyond the migrated fallback field')
const output = document.toString()
const reread = parseDocument(output)
if (reread.errors.length || JSON.stringify(reread.toJS()) !== JSON.stringify(expected)) throw new Error('Profile serialization changed preserved values')
const candidate = join(outputDir, 'cordis.patch.native.yml')
const receipt = join(outputDir, 'profile-migration.json')
if (existsSync(candidate) || existsSync(receipt)) throw new Error('Refusing to overwrite a prepared profile')
const original = statSync(source)
writeFileSync(candidate, output, { mode: original.mode & 0o777, flag: 'wx' })
chownSync(candidate, original.uid, original.gid)
chmodSync(candidate, original.mode & 0o777)
const digest = value => createHash('sha256').update(value).digest('hex')
writeFileSync(receipt, JSON.stringify({ sourcePath: source, candidatePath: candidate,
  sourceSha256: digest(input), candidateSha256: digest(output), routes,
  runtimeEnvironment: 'HIVE_HARNESS_STEP_FALLBACK_ROUTES',
  changedField: 'llm-retry.config.fallback', otherProfileValuesPreserved: true }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log('Prepared preserved fallback routes and native profile patch; original unchanged')

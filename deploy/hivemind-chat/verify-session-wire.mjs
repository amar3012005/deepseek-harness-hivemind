import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const root = resolve(process.argv[2] ?? '/opt/deepseek-harness')
let remotes
const context = createContext({ window: { __ModuleLoader__: { load: registration => {
  remotes = registration.factory(specifier => { throw new Error(`Unexpected remote external: ${specifier}`) })
} } } })
// The assembly embeds generated schemas; its owner alone cannot detect stale overlays.
runInContext(readFileSync(resolve(root, 'packages/api/remotes/lib/client.js'), 'utf8'), context)
const contributions = []
const dispose = await remotes.apply({ remote: { $mount: async contribution => {
  contributions.push(contribution)
  return async () => {}
} } })
const follow = contributions.flatMap(contribution => contribution.descriptors ?? [])
  .find(method => method.namespace === 'session' && method.method === 'follow')
if (!follow) throw new Error('Compiled remotes assembly has no session/follow descriptor')
const request = { address: { kind: 'session', sessionId: 'artifact-session' }, maxMessages: 50, maxTurns: 5, assistantStream: true }
const wire = follow.parameters.find(parameter => parameter.name === 'request').codec.schema.parse(request)
if (wire.maxTurns !== 5 || wire.maxMessages !== 50) throw new Error('Compiled session/follow codec strips initial history bound')
await dispose()
console.log('Compiled session/follow wire maxMessages=50 maxTurns=5 passed; zero network requests')

import { expect, it } from 'vitest'
import { approvedLocalCatalog } from '../src/approved-local-methods.ts'
import { PLAYBOOKS } from '../src/catalog.ts'
const method = { method_id: 'company-repeat-research', status: 'approved', version: 1,
  body: { title: 'Repeat research', description: 'Test a scoped improvement', content: 'Verify identity before searching.',
    domains: ['research'], intents: ['research'], parentGlobalIds: ['global-research'], limitations: 'Only for repeat entity research.' } }
it('loads an approved local version while preserving every global definition', () => {
  const catalog = approvedLocalCatalog([method])
  expect(catalog.slice(0, PLAYBOOKS.length)).toEqual(PLAYBOOKS)
  expect(catalog.at(-1)).toMatchObject({ id: method.method_id, level: 'local', version: 'company-1' })
  expect(catalog.at(-1)?.content).toContain('Only for repeat entity research.')
})
it('reads updated approved versions afresh instead of reusing earlier loaded bodies', () => {
  const updated = approvedLocalCatalog([{ ...method, version: 2, body: { ...method.body, content: 'A revised method' } }]).at(-1)
  expect(updated?.version).toBe('company-2')
  expect(updated?.content).toContain('A revised method')
  expect(approvedLocalCatalog([])).toEqual(PLAYBOOKS)
})
it('rejects pending methods, global override IDs, invalid versions and fabricated global parents', () => {
  for (const invalid of [{ ...method, status: 'pending' }, { ...method, method_id: 'global-research' },
    { ...method, version: 0 }, { ...method, body: { ...method.body, parentGlobalIds: ['unknown'] } }])
    expect(() => approvedLocalCatalog([invalid])).toThrow()
})

it('native search/load sees a later approved version and proposal does not load unpublished content', async () => {
  const { apply } = await import('../src/index.ts')
  const tools = new Map<string, import('@deepseek-ai/dsh-tools').ToolDefinition>()
  const events: Array<{ type: string; data: unknown }> = []
  let approved = method
  let proposed: unknown
  let reviewed: unknown
  let outage = false
  apply({ tools: { register(tool: import('@deepseek-ai/dsh-tools').ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    hivemindMemory: { approvedMethods: async () => { if (outage) throw new Error('Provider unavailable'); return [approved] }, proposeMethod: async (input: unknown) => {
      proposed = input; return { status: 'pending', approval_url: 'https://api.example/approve' }
    }, reviewMethod: async (input: unknown) => { reviewed = input; return { status: 'approved', version: 3 } } }, on: () => () => {},
  } as never, { maxSearchResults: 6, maxSelectedPlaybooks: 4, maxObjectiveChars: 2000, maxOperatingEmployees: 4 })
  const agent = { session: { snapshotEvents: () => events, append: (type: string, data: unknown) => events.push({ type, data }) } }
  const execution = { agent, signal: new AbortController().signal } as never
  const tool = tools.get('hivemind_playbooks')
  if (!tool) throw new Error('Playbooks tool missing')
  const search = await tool.execute({ operation: 'search', query: 'Repeat research', level: 'local' }, execution)
  expect(JSON.stringify(search)).toContain(method.method_id)
  const first = await tool.execute({ operation: 'load', playbook_ids: [method.method_id] }, execution)
  expect(JSON.stringify(first)).toContain('company-1')
  approved = { ...method, version: 2, body: { ...method.body, content: 'The approved second method.' } }
  const later = await tool.execute({ operation: 'record_plan', playbook_ids: [method.method_id], objective: 'Repeat research' }, execution)
  expect(JSON.stringify(later)).toContain('company-2')
  expect(JSON.stringify(later)).toContain('The approved second method.')
  const count = events.length
  expect(await tool.execute({ operation: 'propose_revision', method_id: method.method_id, prior_version: 2,
    method_body: { ...method.body, content: 'Pending third version' }, rationale: 'Evidence', evidence_refs: ['receipt'] }, execution))
    .toMatchObject({ status: 'pending' })
  expect(proposed).toMatchObject({ prior_version: 2, body: { content: 'Pending third version' } })
  expect(events).toHaveLength(count)
  await tool.execute({ operation: 'inspect_revision', revision_id: 'saved-revision' }, execution)
  expect(reviewed).toMatchObject({ operation: 'inspect_revision', revision_id: 'saved-revision' })
  await tool.execute({ operation: 'publish_revision', revision_id: 'saved-revision', content_hash: 'exact-hash' }, execution)
  expect(reviewed).toMatchObject({ operation: 'publish_revision', revision_id: 'saved-revision', content_hash: 'exact-hash' })
  outage = true
  const available = await tool.execute({ operation: 'search', query: 'research' }, execution)
  expect(available).toMatchObject({ company_methods_status: 'unavailable' })
  expect(JSON.stringify(await tool.execute({ operation: 'load', playbook_ids: ['global-research'] }, execution)))
    .toContain('global-research')
  await expect(tool.execute({ operation: 'load', playbook_ids: [method.method_id] }, execution))
    .rejects.toThrow('approved company catalog unavailable')
})

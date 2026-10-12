import { expect, it, vi } from 'vitest'
import { installHistoryTool } from '../src/history-tool.ts'

it('reads only the owning session and pages the full original event within the complete output budget', async () => {
  let tool: { execute: (args: unknown, execution: unknown) => Promise<string> } | undefined
  const original = { seq: 17, data: { text: '\\"\n'.repeat(20_000) } }
  const readEvent = vi.fn(async (_request: unknown) => ({ target: original }))
  installHistoryTool({
    effect: (f: () => unknown) => f(),
    tools: { register: (value: NonNullable<typeof tool>) => { tool = value } },
    get: () => ({ readEvent }),
  } as never, 2000)
  if (!tool) throw new Error('tool missing')
  const execution = { agent: { session: { id: 'own-room' } }, signal: new AbortController().signal }
  let offset = 0, joined = ''
  do {
    const output = await tool.execute({ sequence: 17, offset }, execution)
    expect(output.length).toBeLessThanOrEqual(2000)
    const value = JSON.parse(output)
    joined += value.text
    offset = value.next_offset
  } while (offset !== null)
  expect(joined).toBe(JSON.stringify(original))
  expect(readEvent.mock.calls[0]?.[0]).toEqual({ sessionId: 'own-room', seq: 17, before: 0, after: 0 })
})


it('selects first, second and third native turns and exact own-room call references without changing archived wording', async () => {
  let tool: { execute: (args: unknown, execution: unknown) => Promise<string> } | undefined
  const events = [
    { seq:0,type:'turn/start',data:{ turn:1 } },
    { seq:1,type:'user/message',data:{ source:{ kind:'user' },content:[{ type:'text',text:'  Original first words  ' }] } },
    { seq:4,type:'turn/start',data:{ turn:2 } },
    { seq:5,type:'user/message',data:{ source:{ kind:'plugin',voiceCallId:'second-call' },content:[{ type:'text',text:'user: Original second words' }] } },
    { seq:6,type:'hivemind/voice-call-ended',data:{ callId:'second-call',transcript:'Exact earlier retained transcript words' } },
    { seq:8,type:'turn/start',data:{ turn:3 } },
    { seq:9,type:'user/message',data:{ source:{ kind:'user' },content:[{ type:'text',text:'Original third words' }] } },
  ]
  const filterEvents = vi.fn(async (_room, filters) => events.filter(event => filters.every((filter: { kind:string;from?:number;to?:number }) => filter.kind !== 'seq' || event.seq >= (filter.from ?? 0) && event.seq <= (filter.to ?? Infinity))).map(event => ({ seq:event.seq,type:event.type,time:0,text:event.type === 'hivemind/voice-call-ended' ? '' : JSON.stringify(event.data) })))
  installHistoryTool({ effect:(f:()=>unknown)=>f(),
    tools:{ register:(value:NonNullable<typeof tool>)=>{ tool=value } }, get:()=>({ filterEvents }) } as never, 2000)
  const execution = { agent:{ session:{ id:'own-room',snapshotEvents:()=>events } },signal:new AbortController().signal }
  for (const [turn, text] of [[1,'Original first'],[2,'Original second'],[3,'Original third']] as const) {
    expect(await tool!.execute({ turn },execution)).toContain(text)
    expect(filterEvents.mock.calls.at(-1)?.[0]).toBe('own-room')
  }
  const call = JSON.parse(await tool!.execute({ call_id:'second-call' },execution))
  expect(call.records.map((row:{ sequence:number })=>row.sequence)).toEqual([5,6])
  expect(await tool!.execute({ query:'Exact earlier retained transcript words' },execution)).toContain('Exact earlier retained transcript words')
  expect(JSON.parse(await tool!.execute({ call_id:'foreign-call' },execution)).records).toEqual([])
  await expect(tool!.execute({ turn:4 },execution)).rejects.toThrow('saved_history_turn_unavailable')
})

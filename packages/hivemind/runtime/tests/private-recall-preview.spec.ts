import { expect, it } from 'vitest'
import { privateRecallPreview } from '../src/private-recall-preview.ts'
it('bounds repeated private recap narratives without losing note identities, states or saved evidence', () => {
  const result={ ok:true, memories:Array.from({ length:8 },(_,i)=>({ id:'memory-'+i, agent_slug:'runtime', kind:'handoff', state:'open', summary:'saved recap '.repeat(3000), content:'verbose prior tool log '.repeat(2000), supersedes_id:'prior-'+i })) }
  const saved=JSON.stringify(result), preview=privateRecallPreview(result) as typeof result & { narrativePreview:boolean }
  expect(JSON.stringify(preview).length).toBeLessThan(10000)
  expect(preview.narrativePreview).toBe(true)
  expect(preview.memories).toHaveLength(8)
  for(let i=0;i<8;i++)expect(preview.memories[i]).toMatchObject({ id:'memory-'+i,state:'open',agent_slug:'runtime',supersedes_id:'prior-'+i })
  expect(JSON.stringify(result)).toBe(saved)
})

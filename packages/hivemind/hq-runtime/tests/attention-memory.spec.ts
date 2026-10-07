import { expect,it } from 'vitest'
import { attentionMemorySnapshot,type AttentionMemoryRow } from '../src/attention-memory.ts'
const row=(id:string,key?:string):AttentionMemoryRow=>({ id,kind:'user_agenda',title:id,summary:'Confirmed direction',context:{ state:'confirmed',priority:50,...(key?{ agendaKey:key }:{}) },created_at:'2026-10-08T00:00:00Z',total:1 })
it('preserves independent confirmed directions, including legacy unkeyed records',()=>{
  expect(attentionMemorySnapshot([row('one','sales'),row('two','product'),row('three')]).ready).toBe(true)
})
it('explicit competing topic heads and unavailable overflow cannot authorize wake',()=>{
  expect(attentionMemorySnapshot([row('one','sales'),row('two','sales')]).ready).toBe(false)
  expect(attentionMemorySnapshot([{ ...row('one'),total:51 }]).ready).toBe(false)
})
it('versions include changes outside displayed top records; records stay structured and bounded',()=>{
  const rows=Array.from({ length:10 },(_,i)=>row(String(i)))
  const first=attentionMemorySnapshot(rows),next=attentionMemorySnapshot([...rows.slice(0,9),{ ...rows[9]!,summary:'Changed' }])
  expect(first.userAgenda).toHaveLength(5);expect(next.revision).not.toBe(first.revision)
  expect(first.userAgenda[0]!.summary).toBe('Confirmed direction')
})

import { expect, it } from 'vitest'
import { normalizePrivateMemoryReferences } from '../src/private-memory-references.ts'
it('records native current-room identity only in context without losing the note', () => {
  expect(normalizePrivateMemoryReferences({ room_id:'session-current' },'session-current')).toEqual({})
  expect(()=>normalizePrivateMemoryReferences({ room_id:'session-other' },'session-current')).toThrow('exact UUID')
  const id='85601c95-b367-45b4-b66b-069b68c4dfd0'
  expect(normalizePrivateMemoryReferences({ room_id:id,run_id:'trigger-'+id },'session-current')).toEqual({ room_id:id,run_id:'trigger-'+id })
  for(const field of ['run_id','trigger_id','supersedes_id']) expect(()=>normalizePrivateMemoryReferences({ [field]:'session-current' },'session-current')).toThrow('exact UUID')
})

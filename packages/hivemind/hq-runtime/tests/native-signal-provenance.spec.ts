import { expect,it } from 'vitest'
import { nativeSignalProvenanceSql } from '../src/attention.ts'
it('revalidates bound native sources without changing ordinary Composio ownership',()=>{
  const sql=nativeSignalProvenanceSql('hivemind','2026-10-08T00:00:00Z')
  for(const fragment of ["s.account_id NOT LIKE 'native:%'",'p.user_id::text=e.user_id',"p.connector_metadata->>'attention_org_id'=e.org_id","p.platform_type='slack' AND p.is_active","d.status='completed' AND ds.enabled AND ds.revision=d.revision","p.policy='org_visible' AND p.status='active'","'flashback'=ANY(m.tags)","o.receipt<>'null'::jsonb"])expect(sql).toContain(fragment)
  expect(()=>nativeSignalProvenanceSql('hivemind;DROP','2026-10-08T00:00:00Z')).toThrow('invalid_signal_schema')
})

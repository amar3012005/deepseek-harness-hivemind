
import {expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {savedTextAttachment} from '../src/review.ts'
it('reads exact saved bytes and rejects corruption without accepting a task',async()=>{
  const bytes=Buffer.from('Open Dot Runtime bridge verified.')
  const attachment={file:{attachmentId:'sha256:'+createHash('sha256').update(bytes).digest('hex'),name:'receipt.txt',bytes:bytes.length},mediaType:'text/plain',modality:'file' as const,path:null}
  const signal=new AbortController().signal
  const read=async function*(){yield bytes}
  expect(await savedTextAttachment(attachment,read,signal)).toBe('Open Dot Runtime bridge verified.')
  await expect(savedTextAttachment({...attachment,file:{...attachment.file,attachmentId:'sha256:'+'0'.repeat(64)}},read,signal)).rejects.toThrow('integrity')
  await expect(savedTextAttachment({...attachment,file:{...attachment.file,bytes:1}},read,signal)).rejects.toThrow('limit')
  expect(await savedTextAttachment({...attachment,mediaType:'application/pdf'},read,signal)).toBeUndefined()
  expect(await savedTextAttachment({...attachment,file:{...attachment.file,bytes:48001}},read,signal)).toBeUndefined()
})

import { expect, it } from 'vitest'
import { assignmentMessageText } from '../src/client/chat/assignment-message.ts'
const source = { kind: 'hivemind-agent-message', messageId: 'notice', senderId: 'root' }
const message = { id: 'notice', senderId: 'root', senderEmployee: 'runtime', kind: 'question', taskId: 'task-1',
  text: 'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"root","taskId":"task-1"}\n{"expectedOutcome":"A concise market brief"}\nOperating guidance' }
it('uses the exact subject without claiming execution or scheduling', () => {
  expect(assignmentMessageText(message, source)).toBe('I’ve assigned you this work: A concise market brief')
})
it('leaves ordinary, quoted, malformed and mismatched messages unchanged', () => {
  for (const value of [
    { ...message, text: 'Hello Ravi, please check the brief.' },
    { ...message, senderEmployee: 'another-employee' }, { ...message, taskId: 'other-task' },
    { ...message, senderId: 'other-room' }, { ...message, id: 'other-notice' },
    { ...message, text: `Someone said: ${message.text}` },
    { ...message, text: 'HQ_EMPLOYEE_ASSIGNMENT={broken}\n{}' },
  ]) expect(assignmentMessageText(value, source)).toBeUndefined()
  expect(assignmentMessageText(message, { ...source, kind: 'user' })).toBeUndefined()
})

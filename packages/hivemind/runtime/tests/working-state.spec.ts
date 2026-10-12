import { expect, it } from 'vitest'
import { foldWorkingState, workingStateText, workingStateDefinition } from '../src/working-state.ts'

it('keeps current task identity, dependencies, review and evidence across a checkpoint restore', () => {
  let state = workingStateDefinition.init({} as never, 0 as never)
  const event = (seq: number, type: string, data: unknown) => ({ seq, type, data }) as never
  state = foldWorkingState(state, event(1, 'team/task', { task: { id: 'task-17', revision: 1, status: 'pending', blockedBy: ['task-12'] } }))
  state = foldWorkingState(state, event(2, 'team/task', { task: { id: 'task-17', revision: 2, status: 'in_progress', blockedBy: ['task-12'], ownerId: 'employee-original' } }))
  state = foldWorkingState(state, event(3, 'hivemind/hq-task-review', { taskId: 'task-17', taskRevision: 2, reviewer: 'runtime', status: 'needs_revision', artifactIds: ['artifact-exact'] }))
  const restored = workingStateDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  expect(workingStateText(restored, 4000)).toContain('needs_revision')
  expect(workingStateText(restored, 4000)).toContain('artifact-exact')
  expect(workingStateText(restored, 4000)).toContain('employee-original')
  expect(workingStateText(restored, 4000)).toContain('task-12')
  expect(Object.keys(restored.records)).toHaveLength(2)
  expect(workingStateText(restored, 800).length).toBeLessThanOrEqual(800)
  expect(foldWorkingState(restored, event(4, 'tool/call', {}))).toBe(restored)
})

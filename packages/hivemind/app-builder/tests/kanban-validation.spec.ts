import { describe, expect, it } from 'vitest'
import { validateKanbanGrouping } from '../src/kanban-validation.ts'

describe('kanban cross-field validation', () => {
  const entities = [{ id: 'company', fields: [{ id: 'status', type: 'enum', options: ['Open'] }] },
    { id: 'lead', fields: [{ id: 'name', type: 'text' }] }]
  it('accepts an enum belonging to the view entity and leaves non-kanban views unchanged', () => {
    expect(() => validateKanbanGrouping({ entities, views: [{ type: 'kanban', entityId: 'company', groupByFieldId: 'status' }] })).not.toThrow()
    expect(() => validateKanbanGrouping({ entities, views: [{ type: 'table', entityId: 'lead' }] })).not.toThrow()
  })
  it('rejects missing, non-enum, and other-entity grouping with a useful repair', () => {
    for (const view of [{ type: 'kanban', entityId: 'lead' },
      { type: 'kanban', entityId: 'lead', groupByFieldId: 'name' },
      { type: 'kanban', entityId: 'lead', groupByFieldId: 'status' }]) {
      expect(() => validateKanbanGrouping({ entities, views: [view] })).toThrow('Choose an existing enum field')
    }
  })
})

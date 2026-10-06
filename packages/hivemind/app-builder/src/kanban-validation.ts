import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Check the cross-field rule the structural tool schema cannot express; Core remains authoritative. */
export function validateKanbanGrouping(spec: JsonValue): void {
  const definition = spec as {
    entities: { id: string; fields: { id: string; type: string }[] }[]
    views: { type: string; entityId: string; groupByFieldId?: string }[]
  }
  for (const [index, view] of definition.views.entries()) {
    if (view.type !== 'kanban') continue
    const entity = definition.entities.find(candidate => candidate.id === view.entityId)
    const field = entity?.fields.find(candidate => candidate.id === view.groupByFieldId)
    if (field?.type !== 'enum') throw new TypeError(
      `app-builder: INVALID_APP_SPEC views[${index}].groupByFieldId: kanban requires an enum field in its own entity. `
      + 'Choose an existing enum field or define an enum field with options; use a table view if grouping is unnecessary.',
    )
  }
}

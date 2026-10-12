import { projectedEmployee, type EmployeeOption } from './HyperagentEmployee.tsx'
export interface RoomIdentity { name: string; role: string; employee?: EmployeeOption; pending?: boolean }
/** Names come from the existing scoped owner projection; the preset selects Runtime only. */
export function roomIdentity(preset: unknown, owner: string | null | undefined, pendingRuntime = false): RoomIdentity | undefined {
  const employee = projectedEmployee(owner)
  if (employee) return { name: employee.name, role: employee.role, employee }
  if (owner) {
    try {
      const value = JSON.parse(owner) as { id?: unknown; slug?: unknown; name?: unknown; role?: unknown }
      if (value.id === null && value.slug === 'lead' && preset === 'hivemind-hq') {
        return { name: 'Runtime', role: 'AI Chief of Staff' }
      }
      if (value.id === null && value.slug === 'runtime' && typeof value.name === 'string' && typeof value.role === 'string') {
        return { name: value.name, role: value.role }
      }
    } catch { /* Wait for the authoritative projection rather than invent an employee. */ }
  }
  if (preset === 'hivemind-hq') return { name: 'Runtime', role: 'Opening our workspace…', pending: true }
  return pendingRuntime ? { name: 'Runtime', role: 'Opening our workspace…', pending: true } : undefined
}

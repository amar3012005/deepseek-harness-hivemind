// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { EmployeeJoiningMilestone, employeeJoiningReceipt } from '../src/client/employee-joining.tsx'
it('only renders the confirmed profile receipt, retaining its exact role and date',()=>{
  expect(employeeJoiningReceipt({ id:'employee',name:'Alex',role:'Specialist' })).toBeUndefined()
  const receipt=employeeJoiningReceipt({ id:'employee',name:'Alex',role:'Research',joining:{ at:'2026-10-06T12:00:00.000Z',creationHash:'a'.repeat(64),profileRevision:3 } })
  expect(receipt).toBeDefined()
  render(<EmployeeJoiningMilestone receipt={receipt!} label="Alex joined our team" />)
  expect(screen.getByRole('note').textContent).toContain('Alex joined our team')
  expect(screen.getByRole('note').textContent).toContain('Research')
  expect(screen.getByRole('note').textContent).not.toContain('a'.repeat(64))
  expect(document.querySelector('time')?.dateTime).toBe('2026-10-06T12:00:00.000Z')
})

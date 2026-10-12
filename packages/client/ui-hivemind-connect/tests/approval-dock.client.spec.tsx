// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalDock } from '../src/client/ApprovalDocks.tsx'
import type { MemorySaveItem, RuntimeApprovalItem } from '../src/client/ApprovalDocks.tsx'

afterEach(cleanup)

const t = (key: string) => key
const useApprovalEvents = ((select: (window: { entries: never[] }) => unknown) => select({ entries: [] })) as never

describe('HIVE approval input docks', () => {
  it('persists explicit memory decline with the exact save operation identity', async () => {
    let item: MemorySaveItem | undefined = {
      callId: 'call-memory-1', operationId: 'op-memory-1', tool: 'hivemind_meta', status: 'pending',
      requests: [{ title: 'Hiring plan', content: 'Private draft.' }],
    }
    const decide = vi.fn(async () => { item = { ...item!, status: 'declined' }; return true })
    render(<ApprovalDock kind="memory" sessionId={'session-1' as never} useApprovalEvents={useApprovalEvents} t={t as never}
      load={async () => item === undefined || item.status === 'declined' ? [] : [item]} decide={decide} {...({} as never)} />)

    fireEvent.click(await screen.findByRole('button', { name: 'approval.decline' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('session-1', 'call-memory-1', 'op-memory-1', 'decline'))
    await waitFor(() => expect(screen.queryByText('Hiring plan')).toBeNull())
  })

  it('routes a selected memory destination to the durable decision method', async () => {
    const decide = vi.fn(async () => true)
    const item: MemorySaveItem = {
      callId: 'call-memory-2', operationId: 'op-memory-2', tool: 'hivemind_meta', status: 'pending',
      requests: [{ title: 'Launch notes', content: 'Approved information.' }],
    }
    render(<ApprovalDock kind="memory" sessionId={'session-1' as never} useApprovalEvents={useApprovalEvents} t={t as never}
      load={async () => [item]} decide={decide} {...({} as never)} />)

    fireEvent.click(await screen.findByRole('button', { name: 'approval.personal' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('session-1', 'call-memory-2', 'op-memory-2', 'personal'))
  })

  it('approves only the exact saved generic tool call, without exposing its arguments', async () => {
    const decide = vi.fn(async () => true)
    const item: RuntimeApprovalItem = {
      approvalId: 'approval-1', callId: 'call-tool-1', rootCallId: 'root-1', toolName: 'send_email',
      reason: 'Send the approved draft to the customer.', state: 'pending',
    }
    render(<ApprovalDock kind="runtime" sessionId={'session-1' as never} useApprovalEvents={useApprovalEvents} t={t as never}
      load={async () => [item]} decide={decide} {...({} as never)} />)

    expect(await screen.findByText('Send the approved draft to the customer.')).toBeTruthy()
    expect(screen.queryByText(/arguments|recipient|body/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'approval.approve' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('session-1', 'call-tool-1', 'approval-1', 'approve'))
  })

  it('does not present decision controls for an already approved checkpoint', async () => {
    const item: RuntimeApprovalItem = {
      approvalId: 'approval-2', callId: 'call-tool-2', rootCallId: 'root-2', toolName: 'send_email', state: 'approved',
    }
    render(<ApprovalDock kind="runtime" sessionId={'session-1' as never} useApprovalEvents={useApprovalEvents} t={t as never}
      load={async () => [item]} decide={vi.fn()} {...({} as never)} />)

    expect((await screen.findByRole('status')).textContent).toBe('approval.approved')
    expect(screen.queryByRole('button', { name: 'approval.approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'approval.decline' })).toBeNull()
  })
})

/** External transaction replay reuses the durable native inbox identity. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId, createAfterScheduleRecord, createEveryScheduleRecord } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { harness, agentFor } from './harness.ts'

afterEach(() => {
  vi.useRealTimers()
})
it.each(['after', 'every'] as const)(
  'replays a failed %s task transaction without a second inbox message',
  async (kind) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
    const host = await harness()
    try {
      const agent = agentFor(host.ctx)
      host.resolve.mockResolvedValue({ agent })
      agent.followup.mockImplementation((message) => {
        agent.session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 0,
          inserted: [message],
        })
      })
      const at = Date.now() - 61_000
      let task: ScheduleTask = {
        sessionId: SessionId('original'),
        status: 'active',
        record:
          kind === 'after'
            ? createAfterScheduleRecord(ScheduleId('recover'), 'Do the work', 1, at, 'Recover')
            : createEveryScheduleRecord(ScheduleId('recover'), 'Do the work', 60, at, 'Recover'),
      }
      let failed = true
      const drive = () =>
        new ScheduleRuntime(
          host.ctx,
          () => [task],
          work => work(),
          async (value) => {
            if (failed) throw new Error('lost commit')
            task = value
          },
          { days: 30, records: 200 },
          false,
        ).driveOnce()
      await drive()
      expect(agent.followup).toHaveBeenCalledTimes(1)
      const message = agent.followup.mock.calls[0]![0]
      expect(message.source.kind).toBe('schedule')
      if (message.source.kind === 'schedule') expect(typeof message.source.deliveryKey).toBe('string')
      vi.setSystemTime(Date.now() + 120_000)
      failed = false
      await drive()
      expect(agent.followup).toHaveBeenCalledTimes(1)
      expect(task.lastDelivery?.messageId).toBe(message.id)
      if (message.source.kind === 'schedule' && kind === 'every')
        expect(task.record.scheduledAt).toBe(message.source.nextScheduledAt)
      else expect(task.status).toBe('inactive')
    } finally {
      await host.ctx.fiber.dispose()
    }
  },
)

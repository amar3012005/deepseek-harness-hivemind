import { memo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'conversation.chat.workUpdates': { kind: 'list'; scope: 'session'; owner: { turn: number } } }
}
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import css from './TurnProcessNodeView.module.css'

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t, renderSlot,
}: ChatNodeViewProps<'turn-process'> & Partial<PropsRenderSlots<'conversation.chat.workUpdates'>>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  const labels: string[] = []
  if (node.data.toolCallCount > 0) {
    labels.push(t(
      node.data.toolCallCount === 1
        ? 'message.turnProcess.toolCalls.one'
        : 'message.turnProcess.toolCalls.other',
      { count: node.data.toolCallCount },
    ))
  }
  if (node.data.messageCount > 0) {
    labels.push(t(
      node.data.messageCount === 1
        ? 'message.turnProcess.messages.one'
        : 'message.turnProcess.messages.other',
      { count: node.data.messageCount },
    ))
  }
  if (node.data.subagentCount > 0) {
    labels.push(t(
      node.data.subagentCount === 1
        ? 'message.turnProcess.subagents.one'
        : 'message.turnProcess.subagents.other',
      { count: node.data.subagentCount },
    ))
  }
  const label = labels.length === 0
    ? t('message.turnProcess.thoughtForAWhile')
    : labels.join(t('message.turnProcess.separator'))
  return (
    <>
      <button
        type="button"
        className={css.root}
        data-open={open || undefined}
        data-turn-process={node.data.turn}
        data-turn-process-messages={node.data.messageCount}
        data-turn-process-tool-calls={node.data.toolCallCount}
        data-turn-process-subagents={node.data.subagentCount}
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus()
          turnProcess.setOpen(!open)
        }}
      >
        <span className={css.label}>{turnProcess.spec.dreamSynthesis === true ? 'Exploration details' : window.location.pathname.includes('/employee/harness') ? 'Work details' : label}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </button>
      {renderSlot?.('conversation.chat.workUpdates', { turn: node.data.turn })}
    </>
  )
})

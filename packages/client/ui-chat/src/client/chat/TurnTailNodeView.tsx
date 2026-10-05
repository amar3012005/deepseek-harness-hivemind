import { memo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnTimePanel, TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.turnFooter' | 'conversation.chat.assistant-actions'>

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, renderSlotChain, t, useChat,
}: TurnTailNodeViewProps) {
  const data = node.data
  const hasLaterChatNode = useChat(snapshot =>
    snapshot.locations.getTurn(data.turn).at(-1) !== node.key)
  const isLatestTurn = useChat(snapshot => snapshot.timeline.turnOrder.at(-1) === data.turn)
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlotChain('conversation.chat.turnTail', owner)
  const agentRoom = /^\/hivemind\/app\/employee\/harness(?:\/|$)/u.test(window.location.pathname)
  // Frozen partials already show Stopped. A turn with no partial, or only
  // earlier settled narration, still needs its authoritative end surfaced.
  const stopped = agentRoom && isLatestTurn && turn.end?.data.reason.kind === 'interrupted'
    && (closing === null || closing.finalNode.messageId !== undefined)
    ? <span className={css.stopped} role="status">{t('message.stopped')}</span>
    : null
  if (closing === null) return tail === null && stopped === null
    ? null
    : <div className={css.root}>{stopped}{tail}</div>
  const runMs = turn.start === undefined || turn.end === undefined
    ? undefined
    : Math.max(0, turn.end.time - turn.start.time)
  const showTokenUsage = document.documentElement.dataset.dshMode !== 'hivemind-chat'
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal={isLatestTurn ? 'always' : 'hover'}
    >
      {stopped}
      {tail}
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        clock="end"
        onBranch={() => { forkAt(closing.finalNode.seq) }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        extraActions={assistantActions}
        usageAction={(
          <>
            {showTokenUsage && data.tokenUsage !== undefined && <TurnUsagePanel usage={data.tokenUsage} t={t} />}
            {runMs !== undefined && (
              <TurnTimePanel
                runMs={runMs}
                tokensPerSecond={data.tokensPerSecond}
                ttftMs={data.ttftMs}
                t={t}
              />
            )}
          </>
        )}
        t={t}
      />
      {renderSlot('conversation.chat.turnFooter', owner)}
    </div>
  )
})

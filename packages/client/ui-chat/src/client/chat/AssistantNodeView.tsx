import { memo, useCallback, useMemo } from 'react'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t, renderSlot,
}: ChatNodeViewProps<'assistant-step'> & Partial<import('@deepseek-ai/dsh-client-ui-slots').PropsRenderSlots<'conversation.chat.assistantAvatar'>>) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && (window.location.pathname.includes('/employee/harness')
      || (turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning)
      || (turnProcess.spec.answerStep !== null && data.step < turnProcess.spec.answerStep))
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      {renderSlot?.('conversation.chat.assistantAvatar', {})}
      <AssistantMarkdown
        blocks={data.blocks}
        streaming={data.status === 'running'}
        interrupted={data.status === 'interrupted'}
        renderMessageImages={renderMessageImages}
        reasoningHidden={reasoningHidden}
        revealProcess={revealProcess}
        mentions={mentions}
        t={t}
      />
    </div>
  )
})

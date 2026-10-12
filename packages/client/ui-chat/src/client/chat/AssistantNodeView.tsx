import { memo, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, PresentationInjected, TurnTailOwnerProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<PresentationInjected>
  & PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.assistantAvatar'>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions,
  usePresentation, renderSlot, t,
}: AssistantNodeViewProps) {
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
    && turnProcess.spec.answerStep === data.step
    && turnProcess.spec.inlineReasoning
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  const message = (
    <AssistantMarkdown
      blocks={data.blocks}
      groupPart={groupPart}
      useDisclosure={useDisclosure}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      renderMessageImages={renderMessageImages}
      reasoningHidden={reasoningHidden}
      useGroupAction={useGroupAction}
      usePresentation={usePresentation}
      renderSlot={renderSlot}
      revealProcess={revealProcess}
      mentions={mentions}
      t={t}
    />
  )
  const avatar = renderSlot('conversation.chat.assistantAvatar', {})
  return <AssistantIdentityLayout avatar={avatar}>{message}</AssistantIdentityLayout>
})

/** Optional identity chrome leaves unextended native markup untouched. */
export function AssistantIdentityLayout({ avatar, children }: { avatar?: ReactNode; children: ReactNode }) {
  return avatar == null ? children : <div data-assistant-message style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
    {avatar}<div style={{ minWidth: 0, flex: 1 }}>{children}</div>
  </div>
}

import { Fragment, memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Project valid durable Tool images for the transcript preview. Tool details
 * remain foldable; admitted media is a distinct user-visible result.
 */
function toolPreviewImages(node: ChatNode | undefined): readonly { readonly attachment: ImageAttachmentRef }[] {
  if (node?.kind !== 'tool-call') return []
  const images: { readonly attachment: ImageAttachmentRef }[] = []
  const pending = [node.data.root]
  for (const block of pending) {
    pending.push(...block.subCalls)
    if (!('kind' in block) || block.isError) continue
    for (const part of block.content) {
      if (typeof part !== 'object' || part === null) continue
      const { type, attachment } = part as { type?: unknown; attachment?: unknown }
      if (type !== 'image' || typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) continue
      const value = attachment as Record<string, unknown>
      if (typeof value.attachmentId !== 'string' || value.attachmentId === '') continue
      if (typeof value.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(value.mediaType)) continue
      if (!positiveInteger(value.bytes) || !positiveInteger(value.width) || !positiveInteger(value.height)) continue
      if (value.name !== undefined && typeof value.name !== 'string') continue
      images.push({
        attachment: {
          attachmentId: value.attachmentId as AttachmentId,
          mediaType: value.mediaType as ImageMediaType,
          bytes: value.bytes,
          width: value.width,
          height: value.height,
          ...value.name === undefined ? {} : { name: value.name },
        },
      })
    }
  }
  return images
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && processSpec.answerStep !== null
    && storedEntry?.answerStep === processSpec.answerStep
    ? storedEntry
    : undefined
  const processOpen = processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && processSpec.answerStep !== null) {
      actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open)
    }
  }, [actions, processSpec])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && processSpec.answerAnchorSeq !== null
    && processPresentation.turn === processSpec.turn
    && processPresentation.turnClosed
    && !historyIncomplete
  const processMember = routedNode !== undefined
    && processWindowReady
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && routedNode.anchorSeq < processSpec.answerAnchorSeq
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (processMember || (ownsDisclosure
      && (processPresentation.hasExternalProcess || processSpec.inlineReasoning)))
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, cwd, openFile, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  const previewImages = processHidden ? toolPreviewImages(routedNode) : []
  return (
    <Fragment>
      <div
        ref={wrapperRef}
        className={css.flowItem}
        data-chat-anchor-key={routedNode.key}
        data-chat-flow-key={routedNode.key}
        data-chat-flow-kind={routedNode.kind}
        data-chat-turn={turn}
        data-turn-process-member={processMember || undefined}
        data-turn-process-hidden={processHidden || undefined}
        data-turn-process-answer={compactAnswer || undefined}
      >
        {renderSlot('conversation.chat.node', routedOwner, {
          entryKey: routedNode.kind,
          hookContext: turnData,
          fallback: (
            <JsonBlock
              label={t('message.unknownSurface', { type: routedNode.kind })}
              payload={routedNode.data}
              truncatedLabel={total => t('json.truncated', { total })}
            />
          ),
        })}
      </div>
      {previewImages.length > 0 && (
        <div className={css.flowItem} data-chat-tool-preview={routedNode.key} data-chat-turn={turn}>
          {renderMessageImages({ images: previewImages, align: 'start' })}
        </div>
      )}
    </Fragment>
  )
})

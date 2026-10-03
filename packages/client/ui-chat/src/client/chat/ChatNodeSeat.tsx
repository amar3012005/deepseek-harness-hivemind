import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
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

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, openArtifact, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const quietWork = window.location.pathname.includes('/employee/harness')
  const disclosureStep = processSpec?.answerStep ?? -1
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && storedEntry?.answerStep === disclosureStep
    ? storedEntry
    : undefined
  const processOpen = processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined) {
      actions.setTurnProcessOpen(processSpec.turn, disclosureStep, open)
    }
  }, [actions, processSpec, disclosureStep])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && (quietWork || compactTranscript || processSpec.dreamSynthesis === true)
    && (quietWork || processSpec.answerAnchorSeq !== null)
    && processPresentation.turn === processSpec.turn
    && (quietWork || processPresentation.turnClosed)
    && (!historyIncomplete || quietWork || processSpec.dreamSynthesis === true)
  const processMember = routedNode !== undefined
    && processWindowReady
    && (!TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind) || (routedNode.kind === 'system-prompt' && (quietWork || processSpec.dreamSynthesis === true)))
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && routedNode.anchorSeq < (processSpec.answerAnchorSeq ?? Number.POSITIVE_INFINITY)
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
  // Reports may be delivered before a later receipt/status message. Folding
  // execution details must never discard these user-facing replies or artifacts.
  // Public progress text stays visible even when its message also requests
  // tools. Tool rows and reasoning have their own disclosure presentation.
  const incomingTeamReply = routedNode?.kind === 'context'
    && typeof routedNode.data.source === 'object' && routedNode.data.source !== null
    && 'kind' in routedNode.data.source && routedNode.data.source.kind === 'hivemind-agent-message'
  const preserveReply = incomingTeamReply || (routedNode?.kind === 'assistant-step'
    && processSpec?.dreamSynthesis !== true
    && hasAssistantReplyContent(routedNode.data.blocks))
  const processHidden = controllerInactive
    || (foldable && !processOpen && processMember && !preserveReply)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      ...(openArtifact === undefined ? {} : { openArtifact }),
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, cwd, openFile, openArtifact, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  // Keep internal instructions in durable history and inspection, not the room transcript.
  const dreaming = window.location.pathname.endsWith('/dreaming')
    || new URLSearchParams(window.location.search).has('dreamingParent')
  if (dreaming && (routedNode.kind === 'system-prompt' || routedNode.kind === 'context')) return null
  if (dreaming && (routedNode.kind === 'user' || routedNode.kind === 'steering')
    && routedNode.data.content.some(block => block.type === 'text'
      && (block.text.startsWith("This is the user's FIRST Dreaming introduction")
        || block.text.startsWith('Perform autonomous company dreaming.')))) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
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
  )
})

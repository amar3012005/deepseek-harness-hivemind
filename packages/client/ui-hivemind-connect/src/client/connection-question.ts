import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'

const QUESTION_PREFIX = 'hivemind-connected-app-authorization:'
const MARKER = /<!--\s*hivemind-connected-app-authorization:([^\s]+)\s*-->/

export interface ConnectionAuthorizationPresentation {
  readonly version: 1
  readonly appLabel: string
  readonly toolkit: string
  readonly redirectUrl: string
  readonly logoUrl: string
  readonly connectLabel: string
  readonly continueLabel: string
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
}

/** Recognize only the app-neutral connection question emitted by the HIVE bridge. */
export function connectionPresentationOf(
  questions: readonly AskUserQuestionItem[],
): { question: AskUserQuestionItem; presentation: ConnectionAuthorizationPresentation } | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0]
  if (question === undefined || !question.id.startsWith(QUESTION_PREFIX) || question.detail === undefined) return undefined
  const marker = MARKER.exec(question.detail)?.[1]
  if (marker === undefined) return undefined
  try {
    const value = JSON.parse(decodeURIComponent(marker)) as Record<string, unknown>
    const appLabel = boundedString(value.appLabel, 80)
    const toolkit = boundedString(value.toolkit, 100)
    const redirectUrl = safeHttpsUrl(value.redirectUrl)
    const logoUrl = safeHttpsUrl(value.logoUrl)
    const connectLabel = boundedString(value.connectLabel, 120)
    const continueLabel = boundedString(value.continueLabel, 160)
    if (value.version !== 1 || appLabel === undefined || toolkit === undefined
      || redirectUrl === undefined || logoUrl === undefined
      || connectLabel === undefined || continueLabel === undefined) return undefined
    const labels = new Set((question.options ?? []).map(option => option.label))
    if (labels.size !== 2 || !labels.has(connectLabel) || !labels.has(continueLabel)) return undefined
    return {
      question,
      presentation: { version: 1, appLabel, toolkit, redirectUrl, logoUrl, connectLabel, continueLabel },
    }
  } catch {
    return undefined
  }
}

let nextConnectionKey = 0

function connectionQuestionError(message: string, code: 'ASK_ABORTED' | 'ASK_CANCELLED'): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

function settle(settleResult: () => void): Promise<void> {
  try {
    settleResult()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('connection answer settlement failed', { cause: error }))
  }
}

/** Pending native interaction that answers the original Host waterfall in-place. */
export class PendingConnectionAuthorization {
  // Reuse the native pending-question status so the Session rail reports
  // "Waiting for answer" while this specialized presentation owns the UI.
  readonly kind = 'question'
  readonly key: string
  readonly result: Promise<AskUserQuestionAnswer>
  readonly question: AskUserQuestionItem
  readonly presentation: ConnectionAuthorizationPresentation

  readonly #resolve: (answer: AskUserQuestionAnswer) => void
  readonly #reject: (reason: unknown) => void
  readonly #delegated = Symbol('pending connection authorization delegated')
  readonly #signal: AbortSignal | undefined
  readonly #onAbort: (() => void) | undefined
  readonly #cancelTurn: (() => Promise<unknown>) | undefined
  #settled = false

  constructor(
    readonly sessionId: SessionId,
    recognized: NonNullable<ReturnType<typeof connectionPresentationOf>>,
    signal?: AbortSignal,
    cancelTurn?: () => Promise<unknown>,
  ) {
    nextConnectionKey += 1
    this.key = `hivemind-connected-app-authorization:${String(nextConnectionKey)}`
    this.question = recognized.question
    this.presentation = recognized.presentation
    const completion = Promise.withResolvers<AskUserQuestionAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    this.#signal = signal
    this.#cancelTurn = cancelTurn
    if (signal === undefined) {
      this.#onAbort = undefined
      return
    }
    const onAbort = (): void => { this.abort(signal.reason ?? new Error('connection request was aborted')) }
    this.#onAbort = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }

  continue(): Promise<void> {
    return settle(() => {
      this.finish(() => {
        this.#resolve({ answers: [{ id: this.question.id, selected: [this.presentation.continueLabel] }] })
      })
    })
  }

  delegate(): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(this.#delegated) })
  }

  isDelegation(reason: unknown): boolean { return reason === this.#delegated }

  cancel(): Promise<void> {
    const cancellation = this.#cancelTurn?.()
    return settle(() => {
      this.finish(() => {
        this.#reject(connectionQuestionError('the user cancelled connected-app authorization', 'ASK_CANCELLED'))
      })
    }).then(async () => { await cancellation })
  }

  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }

  private finish(settleResult: () => void): void {
    if (this.#settled) throw new Error(`pending connection ${this.key} is already settled`)
    this.#settled = true
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settleResult()
  }
}

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Connection authorization owned by the HIVE connected-app overlay. */
    hivemindConnectedAppAuthorization: PendingConnectionAuthorization
  }
}

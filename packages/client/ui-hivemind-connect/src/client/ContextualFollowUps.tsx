import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './ContextualFollowUps.module.css'

const FOLLOW_UPS = /<!--\s*hivemind-follow-ups:\s*(\[[\s\S]*?\])\s*-->/iu

export function selectContextualFollowUps(owner: TurnTailOwnerProps): readonly string[] | null {
  const tail = owner.turn.data.get('turn-tail')
  const blocks = tail?.closing?.blocks ?? []
  const text = blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
  const match = text.match(FOLLOW_UPS)
  if (match?.[1] === undefined) return null
  try {
    const parsed = JSON.parse(match[1]) as unknown
    if (!Array.isArray(parsed)) return null
    const prompts = parsed.filter((value): value is string => typeof value === 'string')
      .map(value => value.trim()).filter(value => value.length >= 3 && value.length <= 140).slice(0, 4)
    return prompts.length === 0 ? null : prompts
  } catch { return null }
}

export function ContextualFollowUps({ matched, send }: { matched: readonly string[]; send: (prompt: string) => void }) {
  return <div className={css.root} data-hivemind-follow-ups>
    {matched.map(prompt => <button key={prompt} type="button" className={css.chip} onClick={() => send(prompt)}>↳ {prompt}</button>)}
  </div>
}

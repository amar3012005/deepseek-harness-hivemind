import { useEffect, useState } from 'react'
import { DreamingAutomation } from './DreamingAutomation.tsx'
import { DreamingConnectors } from './DreamingConnectors.tsx'
import { DreamingSettings } from './DreamingSettings.tsx'
import css from './DreamingRoom.module.css'
/** Room controls reuse the company switch and append only a future agenda. */
export function DreamingRoom() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (window.location.pathname !== '/hivemind/app/overview/dreaming'
      && !new URLSearchParams(window.location.search).has('dreamingParent')) return
    const controller = new AbortController()
    void fetch('/hivemind/dreamer/agenda', { credentials: 'include', signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('load'); const value = await response.json() as { text: string }; setText(value.text) })
      .catch(() => { if (!controller.signal.aborted) setMessage('Agenda could not be loaded.') })
    return () =>{  controller.abort() }
  }, [])
  if (window.location.pathname !== '/hivemind/app/overview/dreaming'
    && !new URLSearchParams(window.location.search).has('dreamingParent')) return null
  async function save() {
    setBusy(true)
    try {
      const response = await fetch('/hivemind/dreamer/agenda', { method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: string }
        const reason = value.error?.includes('already owned') ? 'Dreaming is busy. Your draft is kept; try again shortly.'
          : response.status === 401 ? 'Your session expired. Reload Dreaming and try again.'
            : `Agenda could not be saved (request ${response.status}). Please try again.`
        throw new Error(reason)
      }
      const value = await response.json() as { text: string }
      setText(value.text)
      window.dispatchEvent(new CustomEvent('hivemind:dream-agenda-saved', { detail: { text: value.text } }))
      setMessage('Saved for the next dream.'); setOpen(false)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Agenda could not be saved. Please try again.') }
    finally { setBusy(false) }
  }
  return <div className={css.root} data-dreaming-room-controls>
    <span className={css.activityButton}>🌙 Nightly Dreaming</span><DreamingSettings compact />
    <div className={css.activity}><DreamingAutomation room /><DreamingConnectors />
      <button type="button" className={css.goalButton} onClick={() => { setOpen(value => !value) }} aria-expanded={open}>Add goal for next dreams</button>
      {open && <div className={css.agenda}><label>Agenda for future dreams<textarea maxLength={4000} value={text}
        onChange={(event) =>{  setText(event.target.value) }} /></label>
      <p>A suggestion for the next exploration. Saving does not start a run.</p>
      <button type="button" disabled={busy} onClick={() => void save()}>Save agenda</button>
      {message && <p role="status">{message}</p>}</div>}
    </div>
    {message && <span role="status" className={css.status}>{message}</span>}
  </div>
}

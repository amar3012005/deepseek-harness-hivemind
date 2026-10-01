import { useEffect, useState } from 'react'
import { DreamingAutomation } from './DreamingAutomation.tsx'
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
      if (!response.ok) throw new Error('save')
      setMessage('Saved for the next dream.'); setOpen(false)
    } catch { setMessage('Agenda could not be saved. Please try again.') }
    finally { setBusy(false) }
  }
  return <div className={css.root} data-dreaming-room-controls>
    <span className={css.activityButton}>🌙 Nightly Dreaming</span><DreamingSettings compact />
    <div className={css.activity}><DreamingAutomation room />
      <button type="button" className={css.goalButton} onClick={() => { setOpen(value => !value) }} aria-expanded={open}>Add goal for next dreams</button>
    </div>
    {open && <div className={css.agenda}><label>Agenda for future dreams<textarea maxLength={4000} value={text}
      onChange={(event) =>{  setText(event.target.value) }} /></label>
    <p>A suggestion for the next exploration. Saving does not start a run.</p>
    <button type="button" disabled={busy} onClick={() => void save()}>Save agenda</button>
    {message && <p role="status">{message}</p>}</div>}
    {message && <span role="status" className={css.status}>{message}</span>}
  </div>
}

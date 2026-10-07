import { SingulanceMark } from './SingulanceMark.tsx'
import { ChatgptMark } from './ChatgptMark.tsx'
import { useEffect, useState } from 'react'
import css from './ChatgptPlanConnection.module.css'

export function ChatgptPlanConnection() {
  const brain = /^\/hivemind\/app\/overview(?:\/(?:new|session\/[^/]+))?\/?$/u.test(window.location.pathname)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!brain) return
    // Discard old callback material without activating the unavailable connection flow.
    const params = new URLSearchParams(window.location.search)
    if (!params.has('code') && !params.has('state')) return
    params.delete('code'); params.delete('state'); params.delete('scope')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }, [brain])
  if (!brain) return null
  return <div className={css.root}>
    <button type="button" className={css.link} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={css.connectionMarks} aria-hidden="true">
        <SingulanceMark size={30} />
        <span className={css.connectionDots}><i /><i /><i /><i /><i /></span>
        <ChatgptMark />
      </span>
      <span>Connect to your ChatGPT</span>
    </button>
    {open && <p className={css.notice} role="status">Coming soon</p>}
  </div>
}

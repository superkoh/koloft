import { useLayoutEffect, useRef, useState, type JSX } from 'react'

const CAPTURE_BEFORE_XTERM = true

export interface BrowserDialog {
  id: string
  kind: 'alert' | 'confirm' | 'prompt' | 'auth'
  origin: string
  message?: string
  defaultValue?: string
  realm?: string
  guestId?: number
}

export interface BrowserDialogAnswer {
  ok: boolean
  value?: string
  username?: string
  password?: string
}

export function BrowserModal({
  dialog,
  onAnswer
}: {
  dialog: BrowserDialog
  onAnswer: (id: string, answer: BrowserDialogAnswer) => void
}): JSX.Element {
  const [value, setValue] = useState(dialog.kind === 'prompt' ? (dialog.defaultValue ?? '') : '')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const firstField = useRef<HTMLInputElement>(null)
  const safeButton = useRef<HTMLButtonElement>(null)

  // PLATFORM§25
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(firstField.current ?? safeButton.current)?.focus()
    return () => before?.focus()
  }, [dialog.id])

  const accept = (): void => {
    if (dialog.kind === 'auth') onAnswer(dialog.id, { ok: true, username: user, password: pass })
    else if (dialog.kind === 'prompt') onAnswer(dialog.id, { ok: true, value })
    else onAnswer(dialog.id, { ok: true })
  }
  const cancel = (): void => onAnswer(dialog.id, { ok: false })
  const latestCancel = useRef(cancel)
  latestCancel.current = cancel

  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      latestCancel.current()
    }
    window.addEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
    return () => window.removeEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
  }, [])

  return (
    <div className="bmodal-backdrop" onMouseDown={cancel}>
      <div
        className="bmodal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) accept()
        }}
      >
        <div className="bmodal-head">
          <span className="bmodal-origin">{dialog.origin}</span>
          {dialog.realm && <span className="bmodal-realm">{dialog.realm}</span>}
        </div>
        <div className="bmodal-body">
          {dialog.kind === 'auth' ? (
            <>
              <div className="bmodal-msg">This site is asking for a username and password.</div>
              <input
                ref={firstField}
                className="bmodal-field"
                placeholder="Username"
                autoComplete="off"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
              <input
                className="bmodal-field"
                type="password"
                placeholder="Password"
                autoComplete="off"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </>
          ) : (
            <>
              <div className="bmodal-msg">{dialog.message}</div>
              {dialog.kind === 'prompt' && (
                <input
                  ref={firstField}
                  className="bmodal-field"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </>
          )}
        </div>
        <div className="bmodal-foot">
          {dialog.kind !== 'alert' && (
            <button className="mini" ref={safeButton} onClick={cancel}>
              Cancel
            </button>
          )}
          <button
            className="btn-primary"
            ref={dialog.kind === 'alert' ? safeButton : undefined}
            onClick={accept}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

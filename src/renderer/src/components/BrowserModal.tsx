import { useEffect, useRef, useState, type JSX } from 'react'

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

  useEffect(() => {
    firstField.current?.focus()
  }, [dialog.id])

  const accept = (): void => {
    if (dialog.kind === 'auth') onAnswer(dialog.id, { ok: true, username: user, password: pass })
    else if (dialog.kind === 'prompt') onAnswer(dialog.id, { ok: true, value })
    else onAnswer(dialog.id, { ok: true })
  }
  const cancel = (): void => onAnswer(dialog.id, { ok: false })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="bmodal-backdrop" onMouseDown={cancel}>
      <div
        className="bmodal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') accept()
          else if (e.key === 'Escape') cancel()
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
            <button className="mini" onClick={cancel}>
              Cancel
            </button>
          )}
          <button className="btn-primary" onClick={accept}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

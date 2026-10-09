import { useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { LuX } from 'react-icons/lu'
import { workbenchDoc } from '../workbenchHost'

export function CommitDialog({
  branch,
  onCancel,
  onCommit
}: {
  branch: string | null
  onCancel: () => void
  onCommit: (message: string) => Promise<boolean>
}): JSX.Element {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = message.trim() !== '' && !busy
  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    if (!(await onCommit(message))) setBusy(false)
  }
  // ADR-0013
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Commit changes
          <span className="modal-close" onClick={onCancel} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Message</span>
            <input
              autoFocus
              aria-label="Commit message"
              placeholder="What changed, in one line"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
          </label>
          <div className="field-hint">
            Commits every change in this checkout
            {branch && (
              <>
                {' on '}
                <code>{branch}</code>
              </>
            )}
            , new files included (<code>git add -A</code>).
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ready} onClick={() => void submit()}>
            Commit
          </button>
        </div>
      </div>
    </div>,
    workbenchDoc().body
  )
}

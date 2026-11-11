import type { JSX } from 'react'
import { isComposing } from '../keys'
import '../changesView.css'

export function CommentBox({
  on,
  head,
  blocked,
  note,
  setNote,
  onClose,
  onPut
}: {
  on: 'hunk' | 'passage'
  head?: string
  blocked: string | null
  note: string
  setNote: (note: string) => void
  onClose: () => void
  onPut: () => void
}): JSX.Element {
  const put = (): void => {
    if (!blocked) onPut()
  }
  return (
    <form
      className="cv-comment"
      aria-label={`Comment on this ${on}`}
      onSubmit={(e) => {
        e.preventDefault()
        put()
      }}
    >
      {head && (
        <div className="cv-hunk">
          <span className="cv-hunk-hd">{head}</span>
        </div>
      )}
      <textarea
        className="ed-area"
        rows={3}
        autoFocus
        placeholder={`Your note on this ${on}…`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key !== 'Enter' || e.shiftKey || isComposing(e)) return
          e.preventDefault()
          put()
        }}
      />
      <div className="cv-comment-row">
        <span className="cv-comment-hint">
          {blocked ??
            `Lands in the session’s input box with the ${on} — you press ⏎ there to send it. ⏎ here · ⇧⏎ new line · Esc closes`}
        </span>
        <button type="button" className="cv-retry" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!!blocked}>
          Put in session
        </button>
      </div>
    </form>
  )
}

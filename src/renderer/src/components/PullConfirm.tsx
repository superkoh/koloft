import type { JSX } from 'react'
import { LuX } from 'react-icons/lu'

export function PullConfirm({
  count,
  onCancel,
  onConfirm
}: {
  count: number
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Pull into main?
          <span className="modal-close" onClick={onCancel} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="field-hint">
            {count} Koloft session{count === 1 ? ' is' : 's are'} running in this checkout — pulling
            will change files under {count === 1 ? 'it' : 'them'}. Worktree sessions are not
            affected.
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" autoFocus onClick={onConfirm}>
            Pull anyway
          </button>
        </div>
      </div>
    </div>
  )
}

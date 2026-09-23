import type { JSX } from 'react'
import { LuX } from 'react-icons/lu'

/**
 * The running-session guard (workspace-git-pull §03 M3 / D4): a pull changes files
 * under whatever agents are working in the root checkout, so it is confirmed once —
 * a reminder, not a veto. Structure copied from the remove-workspace confirm: one
 * hint line with the COUNT only, never a list.
 *
 * Presentational: both entry points (the sidebar popover and the C7 dialog, where it
 * stacks above the new-session modal) own their own Esc handling, so this binds none.
 * It does take FOCUS, though: the callers' own key handlers all refuse while the confirm
 * is stacked, so without this the Return key does nothing at all until the user clicks.
 */
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

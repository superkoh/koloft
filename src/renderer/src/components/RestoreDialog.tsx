import { SessionBackendIcon } from './SessionBackendIcon'
import { useEffect, useState, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import type { SessionRow } from '@shared/types'
import { basename } from '@shared/preview'
import { mixesBackends, relTime } from '../sessionRows'
import { mayBeRunningElsewhere } from '../resumeFlow'

/**
 * C9 — "Restore from history" as an entrance of its own (D9). ⌘N launches straight
 * into a session now, so the list that used to hang off the C7 dialog moved to the
 * low-frequency door it belongs to: the workspace context menu. The list itself is
 * unchanged (the lifecycle contract D5 §3.2) — a workspace's sessions that are not working-set
 * members, newest first, each hedged when its transcript was just touched.
 */
export function RestoreDialog({
  wsPath,
  onClose,
  onRestore
}: {
  wsPath: string
  onClose: () => void
  /** D5: pull one of the workspace's non-member sessions back into the list. The row
   *  may have a vanished cwd — that is the rebuild branch of the resume tree (D6), so
   *  it is offered like any other. */
  onRestore: (row: SessionRow) => void
}): JSX.Element {
  const [history, setHistory] = useState<SessionRow[]>([])

  // read once on open: the list is a snapshot of what is missing from the sidebar,
  // and a rows push while the dialog is up would only shuffle it under the cursor
  useEffect(() => {
    let live = true
    window.api.workspace
      .historyRows(wsPath)
      .then((h) => {
        if (live) setHistory(h)
      })
      // a workspace that vanished under the dialog leaves it empty rather than stuck
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wsPath])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const now = Date.now()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal restoresess"
        role="dialog"
        aria-label={'Restore session · ' + basename(wsPath)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>Restore session · {basename(wsPath)}</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          {/* Each row is a real button, so ⏎ on the focused one restores it without
              any key plumbing of ours. */}
          <div className="restore">
            <div className="restore-list">
              {history.map((r) => (
                <button key={r.id} className="restore-row" onClick={() => onRestore(r)}>
                  <span className="restore-title">{r.title}</span>
                  <span className="restore-meta">
                    {mixesBackends(history) && <SessionBackendIcon backend={r.backendId} />}
                    <span>
                      {r.worktree} · {relTime(r.mtime, now)}
                    </span>
                    {/* D9 honest boundary: Koloft cannot see claude processes it did not
                        launch, so a just-touched transcript gets a hedge, not a lock */}
                    {mayBeRunningElsewhere(r.mtime, now) && (
                      <span className="restore-tag">may be running elsewhere</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

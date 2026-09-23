import { SessionBackendIcon } from './SessionBackendIcon'
import { useEffect, useState, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import type { SessionRow } from '@shared/types'
import { basename } from '@shared/preview'
import { mixesBackends, relTime } from '../sessionRows'
import { mayBeRunningElsewhere } from '../resumeFlow'

export function RestoreDialog({
  wsPath,
  onClose,
  onRestore
}: {
  wsPath: string
  onClose: () => void
  onRestore: (row: SessionRow) => void
}): JSX.Element {
  const [history, setHistory] = useState<SessionRow[]>([])

  useEffect(() => {
    let live = true
    window.api.workspace
      .historyRows(wsPath)
      .then((h) => {
        if (live) setHistory(h)
      })
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

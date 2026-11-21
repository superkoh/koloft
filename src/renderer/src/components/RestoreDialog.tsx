import { SessionBackendIcon } from './SessionBackendIcon'
import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import { IconClose } from '../icons'
import type { SessionRow } from '@shared/types'
import { basename } from '@shared/preview'
import { mixesBackends, relTime } from '../sessionRows'
import { mayBeRunningElsewhere } from '../resumeFlow'
import '../restoreDialog.css'

export function useHistoryRows(wsPath: string, opts?: { quiet: boolean }): SessionRow[] {
  const [history, setHistory] = useState<SessionRow[]>([])
  const quiet = opts?.quiet ?? false
  useEffect(() => {
    let live = true
    window.api.workspace
      .historyRows(wsPath, { quiet })
      .then((h) => {
        if (live) setHistory(h)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wsPath, quiet])
  return history
}

export function HistoryRowMeta({
  row,
  now,
  showBackend
}: {
  row: SessionRow
  now: number
  showBackend: boolean
}): JSX.Element {
  return (
    <>
      {showBackend && <SessionBackendIcon backend={row.backendId} />}
      <span>
        {row.worktree} · {relTime(row.mtime, now)}
      </span>
      {mayBeRunningElsewhere(row.mtime, now) && (
        <span className="restore-tag">may be running elsewhere</span>
      )}
    </>
  )
}

export function RestoreDialog({
  wsPath,
  onClose,
  onRestore
}: {
  wsPath: string
  onClose: () => void
  onRestore: (row: SessionRow) => void
}): JSX.Element {
  const history = useHistoryRows(wsPath)

  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const now = Date.now()
  const mixed = mixesBackends(history)

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
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="restore">
            <div className="restore-list">
              {history.map((r) => (
                <button key={r.id} className="restore-row" onClick={() => onRestore(r)}>
                  <span className="restore-title">{r.title}</span>
                  <span className="restore-meta">
                    <HistoryRowMeta row={r} now={now} showBackend={mixed} />
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

import { useEffect, useState, type JSX } from 'react'
import type { SessionRow } from '@shared/types'
import { SessionBackendIcon } from './SessionBackendIcon'
import { mixesBackends, relTime } from '../sessionRows'
import { mayBeRunningElsewhere } from '../resumeFlow'
import '../restoreDialog.css'

const PAST_SESSIONS_SHOWN = 3

export function PastSessions({
  wsPath,
  onRestore,
  onShowAll
}: {
  wsPath: string
  onRestore: (row: SessionRow) => void
  onShowAll: () => void
}): JSX.Element | null {
  const [history, setHistory] = useState<SessionRow[]>([])

  useEffect(() => {
    let live = true
    window.api.workspace
      .historyRows(wsPath, { quiet: true })
      .then((h) => {
        if (live) setHistory(h)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wsPath])

  if (!history.length) return null
  const now = Date.now()
  return (
    <div className="recent-list">
      <div className="recent-hd">Past sessions</div>
      {history.slice(0, PAST_SESSIONS_SHOWN).map((r) => (
        <div
          key={r.id}
          className="recent-row"
          title="click to restore"
          onClick={() => onRestore(r)}
        >
          <div className="ws-tab-main">
            <span className="ws-tab-title">{r.title}</span>
          </div>
          <div className="ws-tab-sub">
            {mixesBackends(history) && <SessionBackendIcon backend={r.backendId} />}
            <span>
              {r.worktree} · {relTime(r.mtime, now)}
            </span>
            {mayBeRunningElsewhere(r.mtime, now) && (
              <span className="restore-tag">may be running elsewhere</span>
            )}
          </div>
        </div>
      ))}
      {history.length > PAST_SESSIONS_SHOWN && (
        <button className="mini" style={{ alignSelf: 'flex-start' }} onClick={onShowAll}>
          All {history.length} past sessions…
        </button>
      )}
    </div>
  )
}

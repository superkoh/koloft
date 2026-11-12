import type { JSX } from 'react'
import type { SessionRow } from '@shared/types'
import { HistoryRowMeta, useHistoryRows } from './RestoreDialog'
import { mixesBackends } from '../sessionRows'

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
  const history = useHistoryRows(wsPath, { quiet: true })
  if (!history.length) return null
  const shown = history.slice(0, PAST_SESSIONS_SHOWN)
  const mixed = mixesBackends(shown)
  const now = Date.now()
  return (
    <div className="recent-list">
      <div className="recent-hd">Past sessions</div>
      {shown.map((r) => (
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
            <HistoryRowMeta row={r} now={now} showBackend={mixed} />
          </div>
        </div>
      ))}
      {history.length > shown.length && (
        <button className="mini recent-more" onClick={onShowAll}>
          All {history.length} past sessions…
        </button>
      )}
    </div>
  )
}

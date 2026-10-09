import { SessionBackendIcon } from './SessionBackendIcon'
import { useEffect, useState, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import type { SessionSearchHit } from '@shared/types'
import { basename } from '@shared/preview'
import { parseRemoteKey } from '@shared/remoteKey'
import { relTime } from '../sessionRows'

let lastSearchId = 0

function workspaceLabel(wsPath: string): string {
  const key = parseRemoteKey(wsPath)
  return key ? `${basename(key.path)} (${key.host})` : basename(wsPath)
}

function countLine(n: number): string {
  if (!n) return 'No matches'
  return n === 1 ? '1 session' : `${n} sessions`
}

export function SearchSessionsDialog({
  onClose,
  onOpen
}: {
  onClose: () => void
  onOpen: (hit: SessionSearchHit) => void
}): JSX.Element {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done'>('idle')
  useEffect(() => {
    const off = window.api.sessions.onSearchHits((found) => {
      if (found.searchId !== lastSearchId) return
      if (found.hits.length)
        setHits((had) => [...had, ...found.hits].sort((a, b) => b.row.mtime - a.row.mtime))
      if (found.done) setPhase('done')
    })
    return () => {
      off()
      window.api.sessions.search(++lastSearchId, '')
    }
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const search = (): void => {
    setHits([])
    setPhase(term.trim() ? 'searching' : 'idle')
    window.api.sessions.search(++lastSearchId, term)
  }

  const now = Date.now()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal restoresess"
        role="dialog"
        aria-label="Search sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>Search sessions</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="restore">
            <input
              className="find-input"
              value={term}
              placeholder="Words from any conversation, then ⏎"
              spellCheck={false}
              autoFocus
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search()
              }}
            />
            {phase !== 'idle' && (
              <div className="field-hint">
                {phase === 'searching' ? 'Searching…' : countLine(hits.length)}
              </div>
            )}
            <div className="restore-list">
              {hits.map((h) => (
                <button key={h.row.id} className="restore-row" onClick={() => onOpen(h)}>
                  <span className="restore-title">{h.row.title}</span>
                  {h.snippet && (
                    <span className="restore-snippet">
                      {h.snippet.before}
                      <b>{h.snippet.match}</b>
                      {h.snippet.after}
                    </span>
                  )}
                  <span className="restore-meta">
                    <SessionBackendIcon backend={h.row.backendId} />
                    <span>
                      {workspaceLabel(h.workspacePath)} · {h.row.worktree} ·{' '}
                      {h.row.running ? 'running' : relTime(h.row.mtime, now)}
                    </span>
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

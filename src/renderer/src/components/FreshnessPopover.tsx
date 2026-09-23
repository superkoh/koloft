import { useEffect, useState, type JSX } from 'react'
import { LuDownload, LuRefreshCw } from 'react-icons/lu'
import type { SessionRow, WorkspaceFreshness } from '@shared/types'
import { canPull } from '@shared/freshnessOps'
import { useStore } from '../store'
import { headAge, pullNote, pullToast, type PullNote } from '../freshnessView'
import { mainRunningCount } from '../newSession'
import { PullConfirm } from './PullConfirm'

export function FreshnessPopover({
  wsPath,
  f,
  rows,
  left,
  top,
  onClose,
  onBusy,
  onMouseEnter,
  onMouseLeave
}: {
  wsPath: string
  f: WorkspaceFreshness
  rows: SessionRow[]
  left: number
  top: number
  onClose: () => void
  onBusy: (busy: boolean) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const showToast = useStore((s) => s.showToast)
  const [fetching, setFetching] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<number | null>(null)

  useEffect(() => {
    if (pulling) return
    if (confirm !== null) {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setConfirm(null)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [confirm, pulling, onClose])

  useEffect(() => {
    onBusy(pulling)
    return () => onBusy(false)
  }, [pulling, onBusy])

  const doFetch = async (): Promise<void> => {
    setFetching(true)
    setFailed(null)
    try {
      await window.api.workspace.fetchFreshness(wsPath)
    } finally {
      setFetching(false)
    }
  }

  const doPull = async (): Promise<void> => {
    setConfirm(null)
    setPulling(true)
    setFailed(null)
    const res = await window.api.workspace
      .pull(wsPath, { branch: f.branch, head: f.head })
      .catch(() => ({ ok: false as const, reason: 'pull failed' }))
    setPulling(false)
    if (!res.ok) {
      setFailed(res.reason)
      return
    }
    showToast(pullToast(wsPath, f.branch, res.summary))
    onClose()
  }

  const inMain = mainRunningCount(rows)
  const eligible = canPull(f)
  const note: PullNote = failed ? { text: failed, tone: 'alarm' } : pullNote(f)

  return (
    <>
      {confirm === null && (
        <div
          className="tbu-pop fx"
          style={{ left, top }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={onMouseEnter}
          onMouseLeave={failed ? undefined : onMouseLeave}
        >
          <div className="tbu-pop-head">
            <span>
              {f.branch} · {f.defRef}
            </span>
            <span className="age">{headAge(f, Date.now())}</span>
          </div>
          <div className="tbu-row">
            <div className="fx-counts">
              <span className="b">↓ {f.behind} behind</span>
              <span>↑ {f.ahead} ahead</span>
            </div>
            <div className={'fx-note' + (note.tone === 'warn' ? ' warn' : '')}>
              {note.tone === 'alarm' ? <span className="tbu-alarm">{note.text}</span> : note.text}
            </div>
            {note.extra && <div className="fx-note">{note.extra}</div>}
          </div>
          <div className="tbu-sep" />
          <button
            className="tbu-act pull"
            disabled={!eligible || pulling}
            onClick={() => {
              if (inMain > 0) {
                setConfirm(inMain)
                return
              }
              void doPull()
            }}
          >
            <LuDownload size={14} />
            {pulling ? 'Pulling…' : 'Pull · fast-forward'}
            {eligible && !pulling && (
              <span className="k">
                {f.behind} commit{f.behind === 1 ? '' : 's'}
              </span>
            )}
          </button>
          <button className="tbu-act" disabled={fetching} onClick={() => void doFetch()}>
            <LuRefreshCw size={14} />
            {fetching ? 'Fetching…' : 'Fetch now'}
          </button>
        </div>
      )}
      {confirm !== null && (
        <PullConfirm
          count={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doPull()}
        />
      )}
    </>
  )
}

import { useEffect, useState, type JSX } from 'react'
import { LuDownload, LuLogIn, LuRefreshCw } from 'react-icons/lu'
import type { SessionRow, WorkspaceFreshness, WorkspaceGithub } from '@shared/types'
import { canPull } from '@shared/freshnessOps'
import { parseRemoteKey } from '@shared/remoteKey'
import { useStore } from '../store'
import {
  headAge,
  openIssuesLabel,
  openPullsLabel,
  pullNote,
  pullToast,
  type PullNote
} from '../freshnessView'
import { mainRunningCount } from '../newSession'
import { useGhAuthState, useGhSignIn } from '../ghSignIn'
import { PullConfirm } from './PullConfirm'

function MachineGhSignIn({
  machine,
  onClose
}: {
  machine: string
  onClose: () => void
}): JSX.Element | null {
  const auth = useGhAuthState(machine)
  const signIn = useGhSignIn(machine)
  if (auth !== 'signed-out') return null
  return (
    <>
      <div className="tbu-sep" />
      <div className="tbu-pop-head">
        <span>gh on {machine} · not signed in</span>
      </div>
      <button
        className="tbu-act"
        onClick={() => {
          onClose()
          void signIn()
        }}
      >
        <LuLogIn size={14} />
        Sign in to GitHub on {machine}
      </button>
    </>
  )
}

export function FreshnessPopover({
  wsPath,
  f,
  github,
  rows,
  left,
  top,
  onClose,
  onBusy,
  onMouseEnter,
  onMouseLeave
}: {
  wsPath: string
  f?: WorkspaceFreshness
  github?: WorkspaceGithub
  rows: SessionRow[]
  left: number
  top: number
  onClose: () => void
  onBusy: (busy: boolean) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const showToast = useStore((s) => s.showToast)
  const ghSignIn = useGhSignIn()
  const machine = parseRemoteKey(wsPath)?.host
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
    if (!f) return
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
  const eligible = !!f && canPull(f)
  const note: PullNote | null = failed ? { text: failed, tone: 'alarm' } : f ? pullNote(f) : null

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
          {f && note && (
            <>
              <div className="tbu-pop-head">
                <span>
                  {f.branch} · {f.defRef}
                </span>
                <span className="age">{headAge(f, Date.now())}</span>
              </div>
              <div className="tbu-row">
                <div className="fx-counts">
                  <span className={f.behind > 0 ? 'b' : undefined}>↓ {f.behind} behind</span>
                  <span>↑ {f.ahead} ahead</span>
                </div>
                <div className={'fx-note' + (note.tone === 'warn' ? ' warn' : '')}>
                  {note.tone === 'alarm' ? (
                    <span className="tbu-alarm">{note.text}</span>
                  ) : (
                    note.text
                  )}
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
            </>
          )}
          {f && github && <div className="tbu-sep" />}
          {github && (
            <>
              <div className="tbu-pop-head">
                <span>GitHub · {github.repo}</span>
              </div>
              {github.signedOut ? (
                <button
                  className="tbu-act"
                  onClick={() => {
                    onClose()
                    void ghSignIn()
                  }}
                >
                  <LuLogIn size={14} />
                  Sign in to GitHub to see counts
                </button>
              ) : (
                <div className="tbu-row">
                  <div className="fx-counts">
                    <span>{openIssuesLabel(github.issues)}</span>
                    <span>{openPullsLabel(github.prs)}</span>
                  </div>
                </div>
              )}
              {machine && <MachineGhSignIn machine={machine} onClose={onClose} />}
            </>
          )}
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

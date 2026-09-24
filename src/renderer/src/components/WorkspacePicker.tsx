import { BACKEND_LABEL } from '@shared/sessionBackend'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { LuLoaderCircle, LuTriangleAlert, LuX } from 'react-icons/lu'
import type { BackendId, WorkspaceRows } from '@shared/types'
import { basename } from '@shared/preview'
import { hostOf } from '@shared/remoteKey'
import {
  escPeel,
  freshLineCopy,
  mainRunningCount,
  primaryLabel,
  pullFailedReason,
  type PullPhase
} from '../newSession'
import { pullToast } from '../freshnessView'
import { useStore } from '../store'
import {
  digitPick,
  pickerRows,
  preselectIndex,
  pullable,
  rowNote,
  type PickerMode
} from '../workspacePicker'
import { PullConfirm } from './PullConfirm'
import { SessionLaunchButtons, SessionLaunchStatus, useSessionLaunch } from './SessionLaunchButtons'

export function WorkspacePicker({
  mode,
  rows,
  lastWsPath,
  pinned,
  onClose,
  onConfirm,
  launchLock
}: {
  mode: PickerMode
  rows: WorkspaceRows[]
  lastWsPath: string | null
  pinned?: WorkspaceRows
  onClose: () => void
  onConfirm: (ws: WorkspaceRows, backend: BackendId) => Promise<void>
  launchLock: { current: boolean }
}): JSX.Element {
  const visible = useMemo(() => pickerRows(rows, mode), [rows, mode])
  const [hot, setHot] = useState(() => preselectIndex(rows, mode, lastWsPath))
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [failReason, setFailReason] = useState('')
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<number | null>(null)
  const [confirmWs, setConfirmWs] = useState<WorkspaceRows | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const showToast = useStore((s) => s.showToast)

  const at = Math.min(hot, Math.max(0, visible.length - 1))
  const target = pinned ?? visible[at]?.ws
  const sessionLaunch = useSessionLaunch(
    hostOf(target?.workspace.path ?? ''),
    async (opts, backend) => {
      const ws =
        rows.find((w) => w.workspace.path === opts.cwd) ??
        (pinned?.workspace.path === opts.cwd ? pinned : undefined)
      if (!ws) throw new Error('The workspace is no longer available.')
      await onConfirm(ws, backend)
    },
    onClose
  )
  const confirmBackend = useRef<BackendId>(sessionLaunch.methods.defaultBackend)
  const backends = sessionLaunch.usable
  const other =
    backends.length > 1
      ? backends.find((b) => b !== sessionLaunch.methods.defaultBackend)
      : undefined
  const locked = phase === 'pulling' || sessionLaunch.starting
  useEffect(() => {
    launchLock.current = locked
    return () => {
      launchLock.current = false
    }
  }, [locked, launchLock])
  const failedHere = phase === 'failed' && !!target && failedFor === target.workspace.path
  const morph =
    mode === 'main' &&
    (phase === 'idle' || (phase === 'failed' && !failedHere)) &&
    !!target &&
    pullable(target)
  const kind = locked ? 'pulling' : morph ? 'pull' : 'start'

  const doPull = async (ws: WorkspaceRows, backend: BackendId): Promise<void> => {
    const f = ws.workspace.freshness
    if (!f) return
    setConfirm(null)
    setConfirmWs(null)
    setPhase('pulling')
    const r = await window.api.workspace
      .pull(ws.workspace.path, { branch: f.branch, head: f.head })
      .catch((e: Error) => ({ ok: false as const, reason: e.message }))
    if (!r.ok) {
      setFailReason(r.reason)
      setFailedFor(ws.workspace.path)
      setPhase('failed')
      return
    }
    showToast(pullToast(ws.workspace.path, f.branch, r.summary))
    setPhase('idle')
    void sessionLaunch.launch({ cwd: ws.workspace.path }, backend)
  }

  const submit = (
    ws: WorkspaceRows | undefined,
    backend = sessionLaunch.methods.defaultBackend
  ): void => {
    if (!ws || locked || confirm !== null) return
    if (mode === 'worktree') {
      void onConfirm(ws, backend)
      return
    }
    if (sessionLaunch.issue(backend, hostOf(ws.workspace.path))) return
    const failedForThis = phase === 'failed' && failedFor === ws.workspace.path
    if (!(mode === 'main' && !failedForThis && pullable(ws))) {
      void sessionLaunch.launch({ cwd: ws.workspace.path }, backend)
      return
    }
    const count = mainRunningCount(ws.rows)
    if (count > 0) {
      confirmBackend.current = backend
      setConfirmWs(ws)
      setConfirm(count)
    } else void doPull(ws, backend)
  }

  const close = (): void => {
    if (!locked) onClose()
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const layer = escPeel({ locked, confirmOpen: confirm !== null })
        if (layer === 'none') return
        e.preventDefault()
        if (layer === 'confirm') setConfirm(null)
        else onClose()
        return
      }
      if (locked || confirm !== null || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return
      if (e.key === 'Enter') {
        e.preventDefault()
        submit(target, e.shiftKey && other ? other : undefined)
        return
      }
      if (pinned) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHot((h) => Math.min(h + 1, visible.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHot((h) => Math.max(h - 1, 0))
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        const i = digitPick(visible, Number(e.key))
        if (i === null) return
        setHot(i)
        submit(visible[i].ws)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (locked || confirm !== null) return
    boxRef.current?.focus()
  }, [locked, confirm])

  const now = Date.now()
  const home = window.api.home

  const freshLine = (): JSX.Element | null => {
    const f = target?.workspace.freshness
    if (locked) {
      return (
        <div className="fresh-line busy">
          <span className="fico-l">
            <LuLoaderCircle size={14} />
          </span>
          <span>
            {sessionLaunch.starting ? 'Starting…' : f ? `Pulling ${f.defRef}…` : 'Pulling…'}
          </span>
        </div>
      )
    }
    if (failedHere) {
      return (
        <p className="field-hint bad">
          Pull failed: {pullFailedReason(failReason)} The button is back to <b>Start</b> — starting
          uses the current HEAD.
        </p>
      )
    }
    if (!morph || !f) return null
    const copy = freshLineCopy('stale-pullable', f, now)
    if (!copy) return null
    return (
      <div className="fresh-line stale">
        <span className="fico-l">
          <LuTriangleAlert size={14} />
        </span>
        <span>
          <b>{copy.strong}</b>
          {copy.rest}
        </span>
      </div>
    )
  }

  const title = mode === 'main' ? 'New Session in…' : 'New Worktree Session in…'

  return (
    <>
      <div className="modal-backdrop" onClick={close}>
        <div
          className="modal wspicker"
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          ref={boxRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <span>{title}</span>
            <span className="modal-close" onClick={close} aria-label="Close">
              <LuX size={16} />
            </span>
          </div>
          <div className="modal-body">
            <div
              className="wsp-list"
              role={pinned ? undefined : 'listbox'}
              aria-label={pinned ? undefined : 'Workspaces'}
            >
              {pinned ? (
                <div className="cb-row hot">
                  <span className="wsp-name">{basename(pinned.workspace.path)}</span>
                  <span className="note">{rowNote(pinned, home, now)}</span>
                </div>
              ) : (
                visible.map((r, i) => (
                  <div
                    key={r.ws.workspace.path}
                    className={'cb-row' + (i === at ? ' hot' : '')}
                    role="option"
                    aria-selected={i === at}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setHot(i)
                      submit(r.ws)
                    }}
                  >
                    <span className="wsp-num">{r.digit ?? ''}</span>
                    <span className="wsp-name">{basename(r.ws.workspace.path)}</span>
                    <span className="note">{rowNote(r.ws, home, now)}</span>
                  </div>
                ))
              )}
            </div>
            {freshLine()}
            {mode === 'main' && <SessionLaunchStatus launch={sessionLaunch} />}
            {!pinned && (
              <p className="field-hint">
                ↓↑ move · digit picks · ⏎ confirm
                {other && ` · ⇧⏎ ${BACKEND_LABEL[other]}`} · Esc cancel
              </p>
            )}
          </div>
          <div className="modal-foot">
            <button
              className="mini"
              disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={close}
            >
              Cancel
            </button>
            {mode === 'worktree' ? (
              <button
                className="btn-primary"
                disabled={!target || locked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submit(target)}
              >
                Next <span className="k">⏎</span>
              </button>
            ) : (
              <SessionLaunchButtons
                launch={sessionLaunch}
                backends={backends}
                busy={locked}
                disabled={!target || locked || confirm !== null}
                label={(backend, isDefault) => {
                  if (sessionLaunch.starting) return 'Starting…'
                  if (kind === 'pulling' || backends.length === 1) return primaryLabel(kind)
                  return isDefault
                    ? primaryLabel(kind, undefined, BACKEND_LABEL[backend])
                    : `${primaryLabel(kind)} ${BACKEND_LABEL[backend]}`
                }}
                onStart={(backend) => submit(target, backend)}
              />
            )}
          </div>
        </div>
      </div>
      {confirm !== null && (
        <PullConfirm
          count={confirm}
          onCancel={() => {
            setConfirm(null)
            setConfirmWs(null)
          }}
          onConfirm={() => void (confirmWs && doPull(confirmWs, confirmBackend.current))}
        />
      )}
    </>
  )
}

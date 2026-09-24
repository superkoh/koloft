import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuCheck, LuLoaderCircle, LuTriangleAlert, LuX } from 'react-icons/lu'
import type { BackendId, WorkspaceFreshness, WorkspaceRows, WorktreeInfo } from '@shared/types'
import { basename } from '@shared/preview'
import { hostOf } from '@shared/remoteKey'
import { freshLineState } from '@shared/freshnessOps'
import {
  escPeel,
  freshLineCopy,
  isDimmed,
  mainRunningCount,
  moveHot,
  primaryKind,
  primaryLabel,
  pullFailedReason,
  resolveLaunch,
  sortWorktrees,
  worktreeAim,
  worktreeBaseMode,
  type PullPhase,
  type WtAction,
  type WtAim,
  type WtHot
} from '../newSession'
import { backendLabel } from '../agentUi'
import { shortenHome } from '../browseModel'
import { pullToast } from '../freshnessView'
import { isComposing } from '../keys'
import { useStore } from '../store'
import { PullConfirm } from './PullConfirm'
import {
  SessionLaunchButtons,
  SessionLaunchStatus,
  useSessionLaunch,
  type StartSession
} from './SessionLaunchButtons'

export function WorktreeSessionDialog({
  ws,
  launchLock,
  onClose,
  onStart
}: {
  ws: WorkspaceRows
  launchLock: { current: boolean }
  onClose: () => void
  onStart: StartSession
}): JSX.Element {
  const { path: wsPath, isGit, remote } = ws.workspace
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [hot, setHot] = useState<WtHot>({ where: 'field' })
  const [checking, setChecking] = useState(false)
  const [fetched, setFetched] = useState<WorkspaceFreshness | null>(null)
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [failReason, setFailReason] = useState('')
  const [confirm, setConfirm] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowsAtOpen = useRef(ws.rows)
  const showToast = useStore((s) => s.showToast)
  const gitAutoFetch = useStore((s) => s.settings.gitAutoFetch)
  const sessionLaunch = useSessionLaunch(hostOf(wsPath), onStart, onClose)
  const confirmBackend = useRef<BackendId>(sessionLaunch.methods.defaultBackend)

  useEffect(() => {
    let live = true
    void window.api.workspace.worktrees(wsPath).then(
      (w) => {
        if (live) {
          setWorktrees(w)
          setLoaded(true)
        }
      },
      () => {
        if (live) setLoadError('Could not load worktrees.')
      }
    )
    return () => {
      live = false
    }
  }, [wsPath])

  useEffect(() => {
    if (!isGit || remote || !gitAutoFetch) return
    let live = true
    setChecking(true)
    void window.api.workspace.fetchFreshness(wsPath).then(
      (f) => {
        if (!live) return
        setFetched(f)
        setChecking(false)
      },
      () => {
        if (live) setChecking(false)
      }
    )
    return () => {
      live = false
    }
  }, [wsPath, isGit, remote, gitAutoFetch])

  const listed = useMemo(() => sortWorktrees(worktrees, rowsAtOpen.current), [worktrees])
  const names = useMemo(() => listed.map((w) => w.name), [listed])
  const running = useMemo(
    () => new Set(ws.rows.filter((r) => r.running).map((r) => r.worktree)),
    [ws.rows]
  )

  const aim = worktreeAim(listed, query, hot)
  const actionable =
    loaded && (aim.kind === 'create' || aim.kind === 'open' || aim.kind === 'recover')
  const freshness = ws.workspace.freshness ?? fetched
  const now = Date.now()
  const line = freshLineState(freshness, checking, worktreeBaseMode(aim), now)
  const primary = primaryKind(line, phase)
  const action: WtAction = {
    verb: aim.kind === 'open' ? 'Open' : aim.kind === 'recover' ? 'Recover' : 'Create',
    name: 'name' in aim ? aim.name : null,
    ref: freshness?.defRef
  }
  const locked = phase === 'pulling' || sessionLaunch.starting
  useEffect(() => {
    launchLock.current = locked
    return () => {
      launchLock.current = false
    }
  }, [locked, launchLock])
  const backends =
    aim.kind === 'recover'
      ? sessionLaunch.usable.filter((b) => b === 'codex')
      : sessionLaunch.usable
  const other =
    backends.length > 1
      ? backends.find((b) => b !== sessionLaunch.methods.defaultBackend)
      : undefined

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const layer = escPeel({
        locked,
        confirmOpen: confirm !== null,
        inList: hot.where === 'list',
        hasText: query.length > 0
      })
      if (layer === 'none') return
      if (layer === 'confirm') setConfirm(null)
      else if (layer === 'list') setHot({ where: 'field' })
      else if (layer === 'clear') setQuery('')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, confirm, hot, query, onClose])

  useEffect(() => {
    if (locked || confirm !== null) return
    inputRef.current?.focus()
  }, [locked, confirm])

  const close = (): void => {
    if (!locked) onClose()
  }

  const launch = (target: WtAim, backend = sessionLaunch.methods.defaultBackend): void => {
    if (locked || sessionLaunch.issue(backend)) return
    const method = target.kind === 'recover' ? 'codex' : backend
    if (target.kind === 'recover') {
      void sessionLaunch.launch(resolveLaunch(target, wsPath), method)
    } else if (target.kind === 'open') {
      const row = {
        kind: 'existing' as const,
        name: target.name,
        dir: target.dir,
        inUse: running.has(target.name)
      }
      void sessionLaunch.launch(resolveLaunch(row, wsPath), method)
    } else if (target.kind === 'create') {
      void sessionLaunch.launch(
        resolveLaunch({ kind: 'create', name: target.name }, wsPath),
        method
      )
    }
  }

  const doPull = async (backend: BackendId): Promise<void> => {
    if (!freshness) return
    const { branch, head } = freshness
    setConfirm(null)
    setPhase('pulling')
    const r = await window.api.workspace
      .pull(wsPath, { branch, head })
      .catch((e: Error) => ({ ok: false as const, reason: e.message }))
    if (!r.ok) {
      setFailReason(r.reason)
      setPhase('failed')
      return
    }
    showToast(pullToast(wsPath, branch, r.summary))
    setPhase('idle')
    launch(aim, backend)
  }

  const submit = (backend = sessionLaunch.methods.defaultBackend): void => {
    if (!actionable || locked || confirm !== null || sessionLaunch.issue(backend)) return
    if (primary !== 'pull') {
      launch(aim, backend)
      return
    }
    const count = mainRunningCount(ws.rows)
    confirmBackend.current = backend
    if (count > 0) setConfirm(count)
    else void doPull(backend)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (confirm !== null || locked) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHot((h) => moveHot(h, names, query, 'down'))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHot((h) => moveHot(h, names, query, 'up'))
    } else if (e.key === 'Enter' && !isComposing(e)) {
      e.preventDefault()
      submit(e.shiftKey && other ? other : undefined)
    }
  }

  const hint = (): JSX.Element | null => {
    if (aim.kind === 'none') return null
    if (aim.kind === 'reserved') {
      return <p className="field-hint bad">“main” is the main checkout — pick another name</p>
    }
    if (aim.kind === 'invalid') return <p className="field-hint bad">Only letters, digits, . _ -</p>
    if (aim.kind === 'recover') {
      return (
        <p className="field-hint">
          Recover the saved worktree at <code>{shortenHome(aim.dir, window.api.home)}</code> and
          start Codex.
        </p>
      )
    }
    if (aim.kind === 'create') {
      return (
        <p className="field-hint">
          Create a worktree named <code>{aim.name}</code> from the repo root.
        </p>
      )
    }
    return (
      <p className="field-hint">
        Start a session at <code>{shortenHome(aim.dir, window.api.home)}</code>.
      </p>
    )
  }

  const busyLine = (text: string): JSX.Element => (
    <div className="fresh-line busy">
      <span className="fico-l">
        <LuLoaderCircle size={14} />
      </span>
      <span>{text}</span>
    </div>
  )

  const freshLine = (): JSX.Element | null => {
    if (sessionLaunch.starting) return busyLine('Starting…')
    if (phase === 'pulling' && freshness) return busyLine(`Pulling ${freshness.defRef}…`)
    if (line === 'hidden') return null
    if (phase === 'failed') {
      return (
        <p className="field-hint bad">
          Pull failed: {pullFailedReason(failReason)} The button is back to <b>Create</b> — the new
          worktree branches from the current HEAD.
        </p>
      )
    }
    if (line === 'checking') return busyLine('Checking origin…')
    const copy = freshness && freshLineCopy(line, freshness, now)
    if (!copy) return null
    const good = line === 'ok'
    return (
      <div className={'fresh-line ' + (good ? 'okv' : 'stale')}>
        <span className="fico-l">
          {good ? <LuCheck size={14} /> : <LuTriangleAlert size={14} />}
        </span>
        <span>
          <b>{copy.strong}</b>
          {copy.rest}
        </span>
      </div>
    )
  }

  const title = 'New Worktree Session · ' + basename(wsPath)

  return (
    <>
      <div className="modal-backdrop" onClick={close}>
        <div
          className="modal worktreesess"
          role="dialog"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <span>{title}</span>
            <span className="modal-close" onClick={close} aria-label="Close">
              <LuX size={16} />
            </span>
          </div>
          <div className="modal-body">
            <span className="flabel">Worktree</span>
            <div className={'cb-input' + (hot.where === 'field' ? ' focus' : '')}>
              <input
                ref={inputRef}
                className="cb-field"
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  listed.length > 0 ? 'name a new worktree, or pick below…' : 'name a new worktree'
                }
                aria-label="Worktree"
                disabled={locked}
                value={query}
                onChange={(e) => {
                  if (confirm !== null) return
                  setQuery(e.target.value)
                  setHot({ where: 'field' })
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            {loaded ? (
              hint()
            ) : (
              <p className={'field-hint' + (loadError ? ' bad' : '')}>
                {loadError || 'Loading worktrees…'}
              </p>
            )}
            {freshLine()}
            <SessionLaunchStatus launch={sessionLaunch} />
            {listed.length > 0 && (
              <div className="wt-list">
                <div className="cb-hd">Worktrees</div>
                {listed.map((w, i) => (
                  <div
                    key={w.name}
                    className={
                      'cb-row' +
                      (isDimmed(w.name, query) ? ' dim' : '') +
                      (hot.where === 'list' && hot.index === i ? ' hot' : '')
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!locked && confirm === null) {
                        setHot({ where: 'list', index: i })
                        launch(worktreeAim(listed, '', { where: 'list', index: i }))
                      }
                    }}
                  >
                    <span className="wt-name">{w.name}</span>
                    <span className="note">
                      {w.recoveryResourceId ? 'Recover worktree · ' : ''}
                      {w.branch ? `branch ${w.branch}` : 'detached'}
                      {running.has(w.name) && (
                        <>
                          {' · '}
                          <span className="inuse">in use</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
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
            <SessionLaunchButtons
              launch={sessionLaunch}
              backends={backends}
              busy={locked}
              disabled={!actionable || locked || confirm !== null}
              label={(backend, isDefault) => {
                if (sessionLaunch.starting) return 'Starting…'
                if (primary === 'pulling') return primaryLabel(primary, action)
                if (isDefault)
                  return primaryLabel(
                    primary,
                    action,
                    backends.length > 1 || aim.kind === 'recover'
                      ? backendLabel(backend)
                      : undefined
                  )
                return `${primary === 'pull' ? 'Pull & ' : ''}${action.verb} · ${backendLabel(backend)}`
              }}
              onStart={submit}
            />
          </div>
        </div>
      </div>
      {confirm !== null && (
        <PullConfirm
          count={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doPull(confirmBackend.current)}
        />
      )}
    </>
  )
}

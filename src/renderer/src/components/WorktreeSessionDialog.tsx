import { BACKEND_LABEL } from '@shared/sessionBackend'
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuCheck, LuLoaderCircle, LuTriangleAlert, LuX } from 'react-icons/lu'
import type {
  BackendId,
  GithubItem,
  GithubOpenItems,
  WorkspaceFreshness,
  WorkspaceRows,
  WorktreeInfo
} from '@shared/types'
import { basename } from '@shared/preview'
import { hostOf } from '@shared/remoteKey'
import { ageLabel, freshLineState } from '@shared/freshnessOps'
import {
  actionText,
  escPeel,
  freshLineCopy,
  isDimmed,
  itemAim,
  itemFilterText,
  itemLabel,
  itemLaunchExtras,
  mainRunningCount,
  moveHot,
  primaryKind,
  primaryLabel,
  pullFailedReason,
  resolveLaunch,
  sortWorktrees,
  worktreeAim,
  worktreeBaseMode,
  worktreeInUse,
  type PullPhase,
  type WtAction,
  type WtAim,
  type WtHot
} from '../newSession'
import { ipcErrorText } from '../agentUi'
import { shortenHome } from '../browseModel'
import { pullToast } from '../freshnessView'
import { isComposing } from '../keys'
import { useStore } from '../store'
import { PullConfirm } from './PullConfirm'
import {
  SessionLaunchButtons,
  SessionLaunchStatus,
  useSessionLaunch,
  type SessionLaunchOptions,
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
  const [items, setItems] = useState<GithubOpenItems | null>(null)
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

  useEffect(() => {
    if (!isGit) return
    let live = true
    void window.api.github.openItems(wsPath).then(
      (r) => {
        if (live) setItems(r)
      },
      () => {
        if (live) setItems({ state: 'failed' })
      }
    )
    return () => {
      live = false
    }
  }, [wsPath, isGit])

  const listed = useMemo(() => sortWorktrees(worktrees, rowsAtOpen.current), [worktrees])
  const ghItems = useMemo(
    () => (items?.state === 'items' ? [...items.issues, ...items.prs] : []),
    [items]
  )
  const names = useMemo(
    () => [...listed.map((w) => w.name), ...ghItems.map(itemFilterText)],
    [listed, ghItems]
  )

  const picked = hot.where === 'list' ? ghItems[hot.index - listed.length] : undefined
  const aim: WtAim = picked ? itemAim(picked, listed) : worktreeAim(listed, query, hot)
  const actionable =
    loaded &&
    (aim.kind === 'create' || aim.kind === 'open' || aim.kind === 'recover' || aim.kind === 'item')
  const freshness = ws.workspace.freshness ?? fetched
  const now = Date.now()
  const line = freshLineState(freshness, checking, worktreeBaseMode(aim), now)
  const primary = primaryKind(line, phase)
  const action: WtAction = {
    verb:
      aim.kind === 'open' || (aim.kind === 'item' && aim.dir)
        ? 'Open'
        : aim.kind === 'recover'
          ? 'Recover'
          : 'Create',
    name: 'name' in aim ? aim.name : null,
    ref: freshness?.defRef,
    item: aim.kind === 'item' ? aim.item.number : undefined
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
      void sessionLaunch.launch(
        resolveLaunch({ kind: 'existing', name: target.name, dir: target.dir }, wsPath),
        method
      )
    } else if (target.kind === 'create') {
      void sessionLaunch.launch(
        resolveLaunch({ kind: 'create', name: target.name }, wsPath),
        method
      )
    } else if (target.kind === 'item') {
      const { item, name, dir } = target
      const extras = itemLaunchExtras(item)
      const open = (at: string): SessionLaunchOptions => ({
        ...resolveLaunch({ kind: 'existing', name, dir: at }, wsPath),
        ...extras
      })
      if (dir) void sessionLaunch.launch(open(dir), method)
      else if (item.kind === 'issue')
        void sessionLaunch.launch(
          { ...resolveLaunch({ kind: 'create', name }, wsPath), ...extras },
          method
        )
      else
        void sessionLaunch.launch(async () => {
          const made = await window.api.github.prWorktree(wsPath, item.number, item.branch ?? '')
          if (!made.ok) throw new Error(made.reason)
          return open(made.dir)
        }, method)
    }
  }

  const doPull = async (backend: BackendId): Promise<void> => {
    if (!freshness) return
    const { branch, head } = freshness
    setConfirm(null)
    setPhase('pulling')
    const r = await window.api.workspace
      .pull(wsPath, { branch, head })
      .catch((e: Error) => ({ ok: false as const, reason: ipcErrorText(e) }))
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
    if (aim.kind === 'item') {
      const n = `#${aim.item.number}`
      const send = `send ${n}'s title and link as the first message.`
      if (aim.dir)
        return (
          <p className="field-hint">
            Open the worktree <code>{aim.name}</code>
            {aim.item.branch && aim.name !== `pr-${aim.item.number}` && (
              <>
                {' '}
                — it is already on {n}'s branch <code>{aim.item.branch}</code> —
              </>
            )}{' '}
            and {send}
          </p>
        )
      if (aim.item.kind === 'issue')
        return (
          <p className="field-hint">
            Create a worktree named <code>{aim.name}</code> from the repo root, and {send}
          </p>
        )
      return (
        <p className="field-hint">
          Create a worktree named <code>{aim.name}</code> on {n}'s branch{' '}
          <code>{aim.item.branch}</code>, fetched from GitHub if it is not here yet, and {send}
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

  const isHot = (i: number): boolean => hot.where === 'list' && hot.index === i
  const keepInView = (i: number) =>
    isHot(i) ? (el: HTMLDivElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined

  const itemRow = (item: GithubItem, i: number): JSX.Element => (
    <div
      key={`${item.kind}-${item.number}`}
      ref={keepInView(i)}
      className={
        'cb-row' + (isDimmed(itemFilterText(item), query) ? ' dim' : '') + (isHot(i) ? ' hot' : '')
      }
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!locked && confirm === null) {
          setHot({ where: 'list', index: i })
          launch(itemAim(item, listed))
        }
      }}
    >
      <span className="wt-name">{itemLabel(item)}</span>
      <span className="note">
        {item.branch ? `branch ${item.branch}` : ageLabel(Date.parse(item.updatedAt), now)}
      </span>
    </div>
  )

  const githubBox = (): JSX.Element | null => {
    if (!isGit || items?.state === 'no-repo') return null
    if (!items) return <p className="field-hint">Loading issues and pull requests…</p>
    if (items.state !== 'items')
      return (
        <p className="field-hint">
          {items.state === 'no-gh' ? (
            <>
              No issue or PR list — <code>gh</code> is not installed on this Mac.
            </>
          ) : items.state === 'signed-out' ? (
            <>
              No issue or PR list — run <code>gh auth login</code> on this Mac.
            </>
          ) : (
            'Could not load issues and pull requests from GitHub.'
          )}
        </p>
      )
    if (ghItems.length === 0)
      return <p className="field-hint">No open issues or pull requests in {items.repo}.</p>
    const firstPr = listed.length + items.issues.length
    return (
      <div className="wt-list gh-items">
        {items.issues.length > 0 && <div className="cb-hd">Open issues · {items.repo}</div>}
        {items.issues.map((item, j) => itemRow(item, listed.length + j))}
        {items.prs.length > 0 && (
          <div className="cb-hd">
            Open pull requests{items.issues.length > 0 ? '' : ` · ${items.repo}`}
          </div>
        )}
        {items.prs.map((item, j) => itemRow(item, firstPr + j))}
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
                  ghItems.length > 0
                    ? 'name a new worktree, or pick a worktree, issue or PR below…'
                    : listed.length > 0
                      ? 'name a new worktree, or pick below…'
                      : 'name a new worktree'
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
                    ref={keepInView(i)}
                    className={
                      'cb-row' + (isDimmed(w.name, query) ? ' dim' : '') + (isHot(i) ? ' hot' : '')
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
                      {worktreeInUse(w, ws.rows) && (
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
            {githubBox()}
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
                      ? BACKEND_LABEL[backend]
                      : undefined
                  )
                return `${primary === 'pull' ? 'Pull & ' : ''}${actionText(action, false)} · ${BACKEND_LABEL[backend]}`
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

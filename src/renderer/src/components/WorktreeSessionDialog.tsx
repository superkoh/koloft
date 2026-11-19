import { BACKEND_LABEL } from '@shared/sessionBackend'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { IconCheck, IconClose, IconWarning } from '../icons'
import type { BackendId, WorkspaceFreshness, WorkspaceRows, WorktreeInfo } from '@shared/types'
import { basename } from '@shared/preview'
import { hostOf } from '@shared/remoteKey'
import { freshLineState } from '@shared/freshnessOps'
import {
  escPeel,
  freshLineCopy,
  isDimmed,
  itemAim,
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
  type RunChoice,
  type WtAction,
  type WtAim,
  type WtHot,
  type WorktreeItem
} from '../newSession'
import { fillsOf } from '../pluginUi'
import { WORKTREE_ITEMS } from '../slots'
import { ipcErrorText } from '../agentUi'
import { shortenHome } from '../browseModel'
import { busyInCheckout, pullToast } from '@shared/freshnessOps'
import { isComposing } from '../keys'
import { useStore } from '../store'
import { PullConfirm } from './PullConfirm'
import { startOrList } from '../agentChoice'
import {
  BusyLine,
  SessionLaunchButtons,
  SessionLaunchStatus,
  useLaunchLock,
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
  const { path: wsPath, isGit } = ws.workspace
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [hot, setHot] = useState<WtHot>({ where: 'field' })
  const [checking, setChecking] = useState(false)
  const [fetched, setFetched] = useState<WorkspaceFreshness | null>(null)
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [pullingAs, setPullingAs] = useState<BackendId | null>(null)
  const [failReason, setFailReason] = useState('')
  const [confirm, setConfirm] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowsAtOpen = useRef(ws.rows)
  const showToast = useStore((s) => s.showToast)
  const gitAutoFetch = useStore((s) => s.settings.gitAutoFetch)
  const sessionLaunch = useSessionLaunch(hostOf(wsPath), onStart, onClose)
  const [listOpen, setListOpen] = useState(false)

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
    if (!isGit || !gitAutoFetch) return
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
  }, [wsPath, isGit, gitAutoFetch])

  const itemViews = fillsOf(WORKTREE_ITEMS).map((useItems) => useItems(wsPath, isGit))

  const listed = useMemo(() => sortWorktrees(worktrees, rowsAtOpen.current), [worktrees])
  const viewItems = itemViews.map((v) => v.items)
  const pickItems = useMemo(() => (loaded ? viewItems.flat() : []), [loaded, ...viewItems])
  const names = useMemo(
    () => [...listed.map((w) => w.name), ...pickItems.map((item) => item.filterText)],
    [listed, pickItems]
  )

  const aimAt = (i: number): WtAim => {
    const item = pickItems[i - listed.length]
    return item ? itemAim(item, listed) : worktreeAim(listed, '', { where: 'list', index: i })
  }
  const aim = hot.where === 'list' ? aimAt(hot.index) : worktreeAim(listed, query, hot)
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
    itemRef: aim.kind === 'item' ? aim.item.ref : undefined
  }
  const locked = phase === 'pulling' || sessionLaunch.starting
  useLaunchLock(launchLock, locked)
  const choice =
    aim.kind === 'recover'
      ? sessionLaunch.choice({ backends: [aim.backend], chosen: aim.backend })
      : sessionLaunch.choice()
  const confirmBackend = useRef<BackendId>(choice.lead)

  // PLATFORM§25
  useLayoutEffect(() => {
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

  // PLATFORM§25
  useLayoutEffect(() => {
    if (locked || confirm !== null) return
    inputRef.current?.focus()
  }, [locked, confirm])

  const close = (): void => {
    if (!locked) onClose()
  }

  const launch = (target: WtAim, backend = choice.lead): void => {
    const method = target.kind === 'recover' ? target.backend : backend
    if (locked || sessionLaunch.issue(method)) return
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
      const withItem = (c: RunChoice): SessionLaunchOptions => ({
        ...resolveLaunch(c, wsPath),
        ...item.launch
      })
      const makeWorktree = item.makeWorktree
      if (dir) void sessionLaunch.launch(withItem({ kind: 'existing', name, dir }), method)
      else if (!makeWorktree) void sessionLaunch.launch(withItem({ kind: 'create', name }), method)
      else
        void sessionLaunch.launch(
          async () => withItem({ kind: 'existing', name, dir: await makeWorktree() }),
          method
        )
    }
  }

  const doPull = async (backend: BackendId): Promise<void> => {
    if (!freshness) return
    const { branch, head } = freshness
    setConfirm(null)
    setPullingAs(backend)
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

  const submit = (backend = choice.lead): void => {
    if (!actionable || locked || confirm !== null || sessionLaunch.issue(backend)) return
    if (primary !== 'pull') {
      launch(aim, backend)
      return
    }
    const count = busyInCheckout(useStore.getState().sessions, wsPath)
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
      startOrList(e.shiftKey, choice, submit, () => actionable && setListOpen(true))
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
          start {BACKEND_LABEL[aim.backend]}.
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
    if (aim.kind === 'item') return <p className="field-hint">{aim.item.hint(aim.name, aim.dir)}</p>
    return (
      <p className="field-hint">
        Start a session at <code>{shortenHome(aim.dir, window.api.home)}</code>.
      </p>
    )
  }

  const freshLine = (): JSX.Element | null => {
    if (sessionLaunch.starting) return <BusyLine>Starting…</BusyLine>
    if (phase === 'pulling' && freshness) return <BusyLine>Pulling {freshness.defRef}…</BusyLine>
    if (line === 'hidden') return null
    if (phase === 'failed') {
      return (
        <p className="field-hint bad">
          Pull failed: {pullFailedReason(failReason)} The button is back to <b>Create</b> — the new
          worktree branches from the current HEAD.
        </p>
      )
    }
    if (line === 'checking') return <BusyLine>Checking origin…</BusyLine>
    const copy = freshness && freshLineCopy(line, freshness, now)
    if (!copy) return null
    const good = line === 'ok'
    return (
      <div className={'fresh-line ' + (good ? 'okv' : 'stale')}>
        <span className="fico-l">{good ? <IconCheck size={14} /> : <IconWarning size={14} />}</span>
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

  const row = (i: number, key: string, label: string, note: ReactNode): JSX.Element => (
    <div
      key={key}
      ref={keepInView(i)}
      className={'cb-row' + (isDimmed(names[i], query) ? ' dim' : '') + (isHot(i) ? ' hot' : '')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!locked && confirm === null) {
          setHot({ where: 'list', index: i })
          launch(aimAt(i))
        }
      }}
    >
      <span className="wt-name">{label}</span>
      <span className="note">{note}</span>
    </div>
  )

  const itemRow = (item: WorktreeItem): JSX.Element =>
    row(listed.length + pickItems.indexOf(item), item.key, item.label, item.note(now))

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
              <IconClose size={16} />
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
                  pickItems.length > 0
                    ? `name a new worktree, or pick a worktree, ${itemViews.find((v) => v.items.length > 0)?.pickWhat} below…`
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
                {listed.map((w, i) =>
                  row(
                    i,
                    w.name,
                    w.name,
                    <>
                      {w.recoveryResourceId ? 'Recover worktree · ' : ''}
                      {w.branch ? `branch ${w.branch}` : 'detached'}
                      {worktreeInUse(w, ws.rows) && (
                        <>
                          {' · '}
                          <span className="inuse">in use</span>
                        </>
                      )}
                    </>
                  )
                )}
              </div>
            )}
            {itemViews.map((view, k) => (
              <Fragment key={k}>{view.box({ loaded, row: itemRow })}</Fragment>
            ))}
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
              choice={phase === 'pulling' && pullingAs ? { ...choice, lead: pullingAs } : choice}
              open={listOpen}
              onOpen={setListOpen}
              busy={locked}
              disabled={!actionable || locked || confirm !== null}
              label={(backend) => {
                if (sessionLaunch.starting) return 'Starting…'
                if (primary === 'pulling') return primaryLabel(primary, action)
                return primaryLabel(
                  primary,
                  action,
                  choice.listed.length > 1 || aim.kind === 'recover'
                    ? BACKEND_LABEL[backend]
                    : undefined
                )
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

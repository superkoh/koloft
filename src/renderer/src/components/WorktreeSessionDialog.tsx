import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuCheck, LuLoaderCircle, LuTriangleAlert, LuX } from 'react-icons/lu'
import type { BackendId, WorkspaceFreshness, WorkspaceRows, WorktreeInfo } from '@shared/types'
import { basename } from '@shared/preview'
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

/**
 * C8 — the worktree entrance (new-session-entrances design) §04). The gesture that
 * opened it already said "a worktree", so this asks one question only: which one. The
 * field is a NAME, not a search box: a name that does not exist yet is created (D5,
 * which reverses the "⏎ lands on the match" rule), an exact one opens its
 * checkout. What used to make that ambiguous — a dropdown that only appeared mid-typing
 * — is replaced by a list that is always on screen and only dims as you type (D6), so a
 * name colliding with an existing worktree is visible at the moment it is typed.
 *
 * A new worktree's base is frozen the instant it is created, so the whole M4 freshness
 * apparatus lives here (§04C); an existing checkout does not fork from the root HEAD and
 * shows none of it.
 */
export function WorktreeSessionDialog({
  ws,
  launchLock,
  onClose,
  onStart
}: {
  /** the target workspace and its rows — activity orders the list, running rows mark
   *  a worktree "in use" */
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
  /** the freshness fetch this dialog kicked off — 'checking' is renderer-local and
   *  never travels in the pushed rows (§05) */
  const [checking, setChecking] = useState(false)
  /** the invoke's own answer, standing in until the matching rows push lands */
  const [fetched, setFetched] = useState<WorkspaceFreshness | null>(null)
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [failReason, setFailReason] = useState('')
  /** how many root-checkout sessions the D4 confirm is warning about; null = closed */
  const [confirm, setConfirm] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** D6: the order is a snapshot taken at open — rows keep arriving while the dialog
   *  is up, and re-sorting would move a row out from under the keyboard */
  const rowsAtOpen = useRef(ws.rows)
  const showToast = useStore((s) => s.showToast)
  const gitAutoFetch = useStore((s) => s.settings.gitAutoFetch)
  const sessionLaunch = useSessionLaunch(!!remote, onStart, onClose)
  const confirmBackend = useRef<BackendId>(sessionLaunch.methods.defaultBackend)

  // read once on open (A9): a worktree born under the open dialog stays absent, and
  // its name stays creatable
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

  // Opening the dialog is a fetch trigger (§04C), on C7's own rule: the one setting
  // gates it, the field's state does not — the field is always empty at open.
  // a remote checkout has no freshness at all — the engine only fetches local
  // repos, so asking would leave the line stuck on "Checking origin…"
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
  // "in use" is information, never a gate (A5) — and it is read live, unlike the order
  const running = useMemo(
    () => new Set(ws.rows.filter((r) => r.running).map((r) => r.worktree)),
    [ws.rows]
  )

  const aim = worktreeAim(listed, query, hot)
  const actionable =
    loaded && (aim.kind === 'create' || aim.kind === 'open' || aim.kind === 'recover')
  // the pushed rows are the live truth; the invoke's answer only covers the gap
  // before its own push arrives
  const freshness = ws.workspace.freshness ?? fetched
  const now = Date.now()
  // §04C: an existing checkout does not fork from the root HEAD, so it gets no line —
  // every other state is about to branch off it, empty field included
  const line = freshLineState(freshness, checking, worktreeBaseMode(aim), now)
  const primary = primaryKind(line, phase)
  /** what the button acts on, in the words it uses (D12) */
  const action: WtAction = {
    verb: aim.kind === 'open' ? 'Open' : aim.kind === 'recover' ? 'Recover' : 'Create',
    name: 'name' in aim ? aim.name : null,
    ref: freshness?.defRef
  }
  /** a pull in flight locks the whole dialog (D6): no cancel, no escape, ≤60s */
  const locked = phase === 'pulling' || sessionLaunch.starting
  useEffect(() => {
    launchLock.current = locked
    return () => {
      launchLock.current = false
    }
  }, [locked, launchLock])
  // a saved worktree is rebuilt by Codex alone, so Claude gets no button here at all —
  // the hint line under the field is where that is said
  const backends =
    aim.kind === 'recover'
      ? sessionLaunch.usable.filter((b) => b === 'codex')
      : sessionLaunch.usable
  /** the method ⇧⏎ starts — the keyboard's only way to the one that is not the default */
  const other =
    backends.length > 1
      ? backends.find((b) => b !== sessionLaunch.methods.defaultBackend)
      : undefined

  // Esc peels one layer per press; which one is escPeel's call, so the ladder both
  // dialogs share is pinned by a unit test rather than by this effect.
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

  // the field owns the keyboard the whole time (rows and buttons decline the focus), so
  // ⇧⌘N ⏎ types straight into it. It re-runs when the pull lock releases or the confirm
  // closes: both take the focus away, and a failed pull or a cancelled confirm leaves
  // the dialog standing with ⏎ dead until the user clicks back in.
  useEffect(() => {
    if (locked || confirm !== null) return
    inputRef.current?.focus()
  }, [locked, confirm])

  const close = (): void => {
    if (!locked) onClose()
  }

  /** The same three-branch resolver C7 uses (A4): an existing checkout is a cd, a new
   *  name is `-w` at the repo root, where Claude does the creating. */
  const launch = (target: WtAim, backend = sessionLaunch.methods.defaultBackend): void => {
    if (locked || sessionLaunch.issue(backend)) return
    // rebuilding a saved worktree is Codex's job, whatever the row was clicked with
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

  /** D4: a pull changes files under whatever agents are working in the root checkout,
   *  so it is confirmed once — Cancel leaves the dialog exactly as it was. */
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

  /** the confirm on top owns the keyboard: the field keeps focus behind it, so every
   *  mutation it can trigger has to be refused — a keystroke that changed the name
   *  would create something else than the one "Pull anyway" was read against */
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

  /** M4's six states, in the order they outrank each other — the whole apparatus, since
   *  a worktree's base is frozen at creation and no later pull can fix it (§04C). */
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
                  // typing is a statement about the NAME, so the keyboard comes back
                  // to the field and the primary speaks for it again
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
            {/* nothing to pick from = no list at all (§04A), not an empty box */}
            {listed.length > 0 && (
              <div className="wt-list">
                <div className="cb-hd">Worktrees</div>
                {listed.map((w, i) => (
                  <div
                    key={w.name}
                    // C7's row vocabulary (§04 mockup), plus the dimming that replaces
                    // its filtering
                    className={
                      'cb-row' +
                      (isDimmed(w.name, query) ? ' dim' : '') +
                      (hot.where === 'list' && hot.index === i ? ' hot' : '')
                    }
                    // the field must keep the focus: a blur would take the keyboard
                    // away from the only thing that types a name
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
                // the primary spells the whole action out (D12) and names its method; the
                // second button keeps the verb, so it never reads as a bare noun
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

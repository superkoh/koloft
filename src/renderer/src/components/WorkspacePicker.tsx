import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { LuLoaderCircle, LuTriangleAlert, LuX } from 'react-icons/lu'
import type { BackendId, WorkspaceRows } from '@shared/types'
import { basename } from '@shared/preview'
import {
  escPeel,
  freshLineCopy,
  mainRunningCount,
  primaryLabel,
  pullFailedReason,
  type PullPhase
} from '../newSession'
import { pullToast } from '../freshnessView'
import { backendLabel } from '../agentUi'
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

/**
 * C10 — the mini workspace picker (new-session-entrances design) §03). Both global
 * gestures come here first, because "which workspace" is the one question a keystroke
 * cannot answer on its own (D13): the last-touched workspace is preselected, ⏎ takes it,
 * a digit takes any row in a single press. It has no text field, ever — that is what
 * keeps the digits free (fuzzy jumping belongs to the command palette).
 *
 * Two forms, one component (§03B):
 *  - LIST — the global keys, one row per offered workspace;
 *  - GATE — a per-workspace direct launch (workspace context menu, welcome primary)
 *    whose target is behind-and-pullable: the same dialog with its list pinned to that
 *    one workspace, so the D6a gate has no back door.
 * The morph is the gate: on a behind-and-pullable row the primary becomes Pull & Start
 * and the pull runs BEFORE the launch. Every other freshness state renders nothing at
 * all and starts straight away (D14).
 */
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
  /** the live pushed rows — the list, the notes and the morph all read from them */
  rows: WorkspaceRows[]
  lastWsPath: string | null
  /** gate form: the single workspace this dialog is guarding */
  pinned?: WorkspaceRows
  onClose: () => void
  /** what the confirmed workspace is for — a launch (⌘N) or C8 (⇧⌘N); in the pullable
   *  case it fires only once the pull has landed */
  onConfirm: (ws: WorkspaceRows, backend: BackendId) => Promise<void>
  launchLock: { current: boolean }
}): JSX.Element {
  const visible = useMemo(() => pickerRows(rows, mode), [rows, mode])
  // the preselection is where the keyboard STARTS: a later rows push must not move it
  // out from under the user (same stance as C8's snapshot order)
  const [hot, setHot] = useState(() => preselectIndex(rows, mode, lastWsPath))
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [failReason, setFailReason] = useState('')
  /** the workspace a pull FAILED for — the M4 failed-degrade ("Start on the current
   *  HEAD is the honest option") only carries for that row; any other pullable row
   *  keeps its D6a morph (rev-verify fix: a dialog-wide brake let a sibling row
   *  launch on its old base after an unrelated failure) */
  const [failedFor, setFailedFor] = useState<string | null>(null)
  /** how many root-checkout sessions the D4 confirm is warning about; null = closed */
  const [confirm, setConfirm] = useState<number | null>(null)
  /** the workspace that confirm was raised FOR (captured at submit — review #2) */
  const [confirmWs, setConfirmWs] = useState<WorkspaceRows | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const showToast = useStore((s) => s.showToast)

  const at = Math.min(hot, Math.max(0, visible.length - 1))
  /** what the primary acts on: the pinned workspace in gate form, else the hot row */
  const target = pinned ?? visible[at]?.ws
  const sessionLaunch = useSessionLaunch(
    !!target?.workspace.remote,
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
  /** the method ⇧⏎ starts — the keyboard's only way to the one that is not the default */
  const other =
    backends.length > 1
      ? backends.find((b) => b !== sessionLaunch.methods.defaultBackend)
      : undefined
  /** a pull in flight locks the whole dialog (D6): no cancel, no escape, ≤60s */
  const locked = phase === 'pulling' || sessionLaunch.starting
  useEffect(() => {
    launchLock.current = locked
    return () => {
      launchLock.current = false
    }
  }, [locked, launchLock])
  /** the failed-degrade applies to the row the pull failed FOR, nobody else */
  const failedHere = phase === 'failed' && !!target && failedFor === target.workspace.path
  // D3: ⌘N morphs only on the one state Koloft can safely fix, and only until a pull has
  // failed for THIS row — after that, starting on the current HEAD is the honest
  // option (M4 failed); a sibling row's failure never unguards this one (D6a)
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
    // the badge is already gone: main re-stamps and pushes the fresh rows before this
    // resolves, so the session row can only appear on the new base
    setPhase('idle')
    void sessionLaunch.launch({ cwd: ws.workspace.path }, backend)
  }

  /** D4: a pull changes files under whatever agents are working in the root checkout,
   *  so it is confirmed once — Cancel leaves the dialog exactly as it was. */
  const submit = (
    ws: WorkspaceRows | undefined,
    backend = sessionLaunch.methods.defaultBackend
  ): void => {
    if (!ws || locked || confirm !== null) return
    if (mode === 'worktree') {
      void onConfirm(ws, backend)
      return
    }
    if (sessionLaunch.issue(backend, !!ws.workspace.remote)) return
    const failedForThis = phase === 'failed' && failedFor === ws.workspace.path
    if (!(mode === 'main' && !failedForThis && pullable(ws))) {
      void sessionLaunch.launch({ cwd: ws.workspace.path }, backend)
      return
    }
    const count = mainRunningCount(ws.rows)
    if (count > 0) {
      // capture the workspace the confirm DESCRIBES — a rows push while it is open
      // must not retarget "Pull anyway" through the re-clamped hot index (review #2)
      confirmBackend.current = backend
      setConfirmWs(ws)
      setConfirm(count)
    } else void doPull(ws, backend)
  }

  const close = (): void => {
    if (!locked) onClose()
  }

  // The dialog owns the keyboard while it is up — it has nothing focusable to type into,
  // so the keys are read from the window and the box itself takes the focus away from
  // whatever TUI was behind it. Esc peels one layer per press through the shared ladder.
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
      // the gate form has no list to walk or number
      if (pinned) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHot((h) => Math.min(h + 1, visible.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHot((h) => Math.max(h - 1, 0))
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        // D13 × D6a: a digit is "pick AND confirm", so it confirms whatever the row's
        // primary says — including its Pull & Start morph
        const i = digitPick(visible, Number(e.key))
        if (i === null) return
        setHot(i)
        submit(visible[i].ws)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // no dependency list: every key answer depends on where the cursor is right now
  })

  // …and it re-takes the focus when the pull lock releases or the confirm closes, both
  // of which hand it elsewhere (the confirm's primary autofocuses)
  useEffect(() => {
    if (locked || confirm !== null) return
    boxRef.current?.focus()
  }, [locked, confirm])

  const now = Date.now()
  const home = window.api.home

  /** D14: the freshness apparatus appears for the pullable state alone — checking, ok,
   *  offline, dirty and diverged can last for hours, and a box per ⌘N is pure noise. */
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
                // gate form: the target is not a choice, so it is not an option row
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
                    // No hover-follows-selection: ⏎ must mean the row the keyboard is on,
                    // never wherever the pointer came to rest. Mousedown is declined so
                    // the box keeps the focus — a blur would take Esc with it.
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
                {other && ` · ⇧⏎ ${backendLabel(other)}`} · Esc cancel
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
                  // the primary spells the whole action and names its method; the second
                  // button keeps the verb, because a bare "Codex" beside it reads as a noun
                  return isDefault
                    ? primaryLabel(kind, undefined, backendLabel(backend))
                    : `${primaryLabel(kind)} ${backendLabel(backend)}`
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

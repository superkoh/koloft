import { identityOf, SESSION_CAPABILITIES } from '@shared/sessionBackend'
import { SessionBackendIcon } from './SessionBackendIcon'
import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { GoGitBranch } from 'react-icons/go'
import { LuAlarmClock, LuFolder, LuFolderOpen, LuGitBranchPlus, LuPlus, LuX } from 'react-icons/lu'
import type { BackendId, SessionRow } from '@shared/types'
import type { DirtyTab } from '../unsavedGuard'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { popoverX } from '@shared/accountUsage'
import { slugOf } from '@shared/cronNames'
import { describeWhen } from '@shared/schedule'
import { backendLabel } from '../agentUi'
import { forecastFor } from '../cronForm'
import { useStore } from '../store'
import {
  isOrphanRow,
  marqueeAnim,
  mixesBackends,
  sessionActivityBadge,
  relTime,
  rowStateClass
} from '../sessionRows'
import { releaseSettledResumes, resumeInFlight, resumeSession } from '../resumeFlow'
import { adoptionSettled } from '../adoption'
import { behindBadge } from '../freshnessView'
import { FreshnessPopover } from './FreshnessPopover'
import { basename } from '@shared/preview'
import { parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { workspaceMenuCount } from '../remoteWorkspace'
import {
  discardAll,
  dirtyInWorkspace,
  labelPaths,
  removeJobsNote,
  removePlan,
  removeUnsavedNote,
  saveAll
} from '../unsavedGuard'

/** F7: nothing was bound to the session in main, so nothing was killed — the
 *  transcript is being kept fresh by a claude Koloft does not own. */
const FORCE_CLOSE_FAILED_NOTICE =
  'Could not force close — the session may be running outside Koloft.'

/** How often the ⏰ forecast row re-reads the clock. The row says "today 21:00",
 *  so it only ever changes on the minute — half a minute of lag costs nothing and the
 *  timer stays out of the render path. */
const CRON_BADGE_MS = 30_000

/** What the remove-workspace confirm says. Sessions come back when the folder is
 *  re-added; jobs do not, which is the whole reason the confirm now appears for a
 *  workspace with no running session at all (§7.7). */
function removeConfirmText(running: number, jobs: number): string {
  const s = `${running} running session${running === 1 ? '' : 's'} will be closed`
  const j = `${jobs} scheduled job${jobs === 1 ? '' : 's'} will be deleted`
  const kept =
    'Sessions are kept by Claude or Codex — re-adding the folder brings them back as resumable.'
  if (jobs === 0) return `${s}. ${kept}`
  if (running === 0) return removeJobsNote(jobs)
  return `${s}, and ${j}. ${kept} Jobs do not come back.`
}

/** How long a row must be hovered before its menu flies out (C2 hover-intent). */
const HOVER_MENU_MS = 350
/** Grace window for the pointer to travel from the row onto the fly-out. */
const MENU_LEAVE_MS = 140
const MENU_W = 190
const FRESH_POP_W = 300
/** height budget of the freshness card — only used to flip it up near the bottom */
const FRESH_POP_H = 170

/** The workspace path says which machine a row lives on (`ssh://host/path`), so
 *  nothing here carries the host separately. A row's own `cwd` cannot: it is a plain
 *  absolute path over there, indistinguishable from one of ours. */
type MenuTarget =
  | { kind: 'session'; wsPath: string; row: SessionRow }
  | {
      kind: 'workspace'
      wsPath: string
      missing: boolean
      isGit: boolean
      hasHistory: boolean
    }

/** the machine a workspace lives on, or undefined for a local folder */
const hostOf = (wsPath: string): string | undefined => parseRemoteKey(wsPath)?.host ?? undefined

interface MenuState {
  target: MenuTarget
  left: number
  top: number
}

/** Anchor a fly-out at the row's right edge (−6px overlap, row-top aligned),
 *  flipping to the left edge when the screen right border is too close. */
function menuPosFor(el: HTMLElement, itemCount: number): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  let left = r.right - 6
  if (left + MENU_W > window.innerWidth - 4) left = Math.max(4, r.left - MENU_W + 6)
  const estH = itemCount * 31 + 10
  const top = Math.min(r.top, Math.max(4, window.innerHeight - estH - 4))
  return { left, top }
}

/** A badge's card (freshness, parked) hangs under its badge, centred on it — same
 *  clamping idea as the fly-out, applied to a wider card that also has to fit above
 *  the bottom edge. */
function cardPosFor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  return {
    left: popoverX(r.left + r.width / 2, FRESH_POP_W, window.innerWidth),
    top: Math.min(r.bottom + 6, Math.max(4, window.innerHeight - FRESH_POP_H - 4))
  }
}

/**
 * The left dock's Sessions island (workspace → session tree, C2). The Files island it
 * used to sit above retired with the sidebar file tree — directory browsing and the
 * change set are the Workbench's pinned `files` tab now (FR-44…FR-50). The session
 * list is the aggregation main pushes
 * over workspace:rows — Claude's own storage is the truth, Koloft only pins the
 * workspaces (agent-centric A1/A2). Running rows map onto live tabs through the
 * sessions stream; cold rows resume via sessions.resume. Rendered as fragments —
 * the dock column (width, gaps) belongs to App.
 */
export function WorkspaceSidebar({
  onNewSession,
  namedMethods,
  onNewWorktreeSession,
  onRestoreSession,
  onScheduledJobs
}: {
  /** start a main session in that workspace (D1): the menu item and a plain (non-git)
   *  head's hover ＋ name their own target, so nothing is asked — App puts C10's gate
   *  in front of a pullable one */
  onNewSession: (wsPath: string, backend?: BackendId) => void
  /** both session methods, the default first, when this Mac has two to offer — a menu
   *  item each, naming them. Never on the head's hover ＋: that button is one button
   *  (BB-M10). */
  namedMethods: [BackendId, BackendId] | null
  /** raise the C8 worktree dialog for a workspace (D7) — the menu item and a git
   *  head's hover ⑂ are its per-workspace doors; neither exists on a non-git
   *  workspace (D10) */
  onNewWorktreeSession: (wsPath: string) => void
  /** raise the C9 Restore dialog for a workspace (D9) — the menu is its only door */
  onRestoreSession: (wsPath: string) => void
  /** raise the Scheduled jobs dialog for a workspace. The menu opens it on
   *  whichever card the dialog picks itself; the forecast row names the job it just
   *  said would run next, so that one is already selected when the dialog appears. */
  onScheduledJobs: (wsPath: string, jobId?: string) => void
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  // the welcome's step 2 already says how to add a folder — two copies of it read
  // as two different instructions
  const welcomeActive = useStore((s) => s.welcomeActive)
  const cron = useStore((s) => s.cron)
  const sessions = useStore((s) => s.sessions)
  const storeTabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const resumeLaunch = useStore((s) => s.resumeLaunch)
  const activateTab = useStore((s) => s.activateTab)
  const selectedWs = useStore((s) => s.selectedWs)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const showToast = useStore((s) => s.showToast)
  // collapse is per-run UI state; a workspace re-expands on restart
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  // marquee arms only for the hovered row whose title actually overflows, and it
  // scrolls that measured overflow — never a fixed distance (C2)
  const [mq, setMq] = useState<{ id: string; overflow: number } | null>(null)
  const mqRef = useRef<HTMLElement | null>(null)
  // pending remove-workspace confirmation (DOM modal, A1 — never a native dialog).
  // B-31: `dirty` is the unsaved work the removal would take with it, captured when the
  // question goes up — empty is the ordinary removal, word for word as it always was.
  const [confirmRemove, setConfirmRemove] = useState<{
    path: string
    running: number
    /** scheduled jobs the removal deletes with the workspace */
    jobs: number
    dirty: DirtyTab[]
  } | null>(null)
  // a save can take a moment; a second click would remove the workspace twice
  const [removing, setRemoving] = useState(false)
  const removeCancelRef = useRef<HTMLButtonElement>(null)
  // session id of the orphaned row awaiting its force-close confirmation (F7)
  const [confirmOrphan, setConfirmOrphan] = useState<string | null>(null)
  // the open freshness card, anchored under the badge being hovered
  const [fresh, setFresh] = useState<{ path: string; left: number; top: number } | null>(null)
  /** the ⏸ badge's card, keyed by the row whose badge was clicked */
  const [parkedPop, setParkedPop] = useState<{ rowId: string; left: number; top: number } | null>(
    null
  )
  /** the card has a pull in flight — nothing may take it down under the failure line.
   *  A ref, not state: only timers and event handlers read it, and a timer armed
   *  before the pull started must still see the pull. */
  const freshBusy = useRef(false)
  // stable on purpose: the card's effect re-runs whenever this identity changes
  const setFreshBusy = useCallback((busy: boolean) => {
    freshBusy.current = busy
  }, [])
  /** bumped every 30 s purely to bring the render back, so the ⏰ badge's words keep up
   *  with the clock. The number itself is never read — the badge reads `new Date()`. */
  const [, bumpCronClock] = useState(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** the behind-badge card's own leave grace */
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // the session stream is the sessionId → live-tab link for running rows. The tab's own
  // resume id is the second link, and isOrphanRow already counts a row reachable through
  // it: a Codex run parked on its native "resume this thread?" prompt has opened no
  // thread yet, so it publishes no session entry for as long as the user takes to answer.
  const sessionByIdEntries = sessions.filter((s) => s.sessionId)
  const tabIdFor = (sessionId: string): string | undefined =>
    sessionByIdEntries.find((s) => s.sessionId === sessionId && s.alive)?.tabId ??
    storeTabs.find((t) => t.alive && t.sessionId === sessionId)?.id

  // one timer for every ⏰ badge on the list — the work per tick is one nextRun per
  // switched-on job, which is a handful of Date sums
  useEffect(() => {
    const t = setInterval(() => bumpCronClock((n) => n + 1), CRON_BADGE_MS)
    return () => clearInterval(t)
  }, [])

  // B-31: the unsaved form of the removal question kills processes AND loses typing, so
  // it follows CloseSessionDialog's rule and parks the focus on Cancel. The ordinary
  // removal is left exactly as it was, focus included.
  useEffect(() => {
    if (confirmRemove && confirmRemove.dirty.length > 0) removeCancelRef.current?.focus()
  }, [confirmRemove])

  // a resumed id has landed as running (or vanished) — release its resume dedupe
  useEffect(() => {
    const cold = new Set<string>()
    for (const w of rows) for (const r of w.rows) if (!r.running) cold.add(r.id)
    releaseSettledResumes(cold)
  }, [rows])

  // The marquee runs off measured geometry, so it is driven here rather than by a
  // CSS keyframe with a baked-in distance: scroll the overflow, hold, loop.
  useEffect(() => {
    const el = mqRef.current
    if (!mq || !el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const spec = marqueeAnim(mq.overflow)
    if (!spec) return
    const anim = el.animate(spec.frames, spec.timing)
    return () => anim.cancel()
  }, [mq])

  const clearTimers = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    hoverTimer.current = null
    leaveTimer.current = null
  }

  // dismiss the fly-out on any outside click / Escape
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /** What a running row keeps parked (SessionInfo.parked): its ⏸ badge and the
   *  card behind it. */
  const parkedFor = (row: SessionRow): ReturnType<typeof sessionActivityBadge> => {
    const sess = row.running ? sessions.find((s) => s.tabId === tabIdFor(row.id)) : undefined
    return sessionActivityBadge(sess)
  }

  // the parked card closes like the fly-out: any outside click / blur / Escape
  useEffect(() => {
    if (!parkedPop) return
    const close = (): void => setParkedPop(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setParkedPop(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [parkedPop])

  const menuItemCount = (t: MenuTarget): number =>
    t.kind === 'workspace'
      ? workspaceMenuCount({ missing: t.missing, isGit: t.isGit, remote: !!hostOf(t.wsPath) })
      : t.row.pending
        ? 1
        : t.row.running
          ? 2 // Reveal + Copy — the menu never ends a session (⌘W does, D3)
          : 5 // head + Resume + Reveal + Copy + Remove from list

  const openMenuAt = (el: HTMLElement, target: MenuTarget): void => {
    const pos = menuPosFor(el, menuItemCount(target))
    setMenu({ target, ...pos })
  }

  // hover-intent: arm a 350ms timer on row enter; leaving the row gives the
  // pointer a short grace window to land on the fly-out before it closes
  const armMenu = (el: HTMLElement, target: MenuTarget): void => {
    hoverTimer.current = setTimeout(() => openMenuAt(el, target), HOVER_MENU_MS)
  }
  const armHoverMenu = (e: MouseEvent, target: MenuTarget): void => {
    clearTimers()
    armMenu(e.currentTarget as HTMLElement, target)
  }
  const scheduleClose = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setMenu(null), MENU_LEAVE_MS)
  }
  const keepMenu = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }
  const openMenuNow = (e: MouseEvent, target: MenuTarget): void => {
    e.preventDefault()
    e.stopPropagation()
    clearTimers()
    openMenuAt(e.currentTarget as HTMLElement, target)
  }

  // The behind-badge's card has a grace timer of its own, so the fly-out's clearTimers
  // and the card's close never cancel each other. Leaving the count re-arms the head's
  // countdown because a parent's mouseenter does not fire again for a move between
  // its children. Mid-pull the card stays put.
  const keepCard = (): void => {
    if (cardTimer.current) clearTimeout(cardTimer.current)
    cardTimer.current = null
  }
  const enterCard = (): void => {
    clearTimers()
    keepCard()
  }
  const openCard = (el: HTMLElement, path: string): void => {
    enterCard()
    setMenu(null)
    if (freshBusy.current) return
    setFresh({ path, ...cardPosFor(el) })
  }
  const leaveCard = (): void => {
    keepCard()
    cardTimer.current = setTimeout(() => {
      if (!freshBusy.current) setFresh(null)
    }, MENU_LEAVE_MS)
  }

  // ---- actions --------------------------------------------------------------

  const clickRow = (row: SessionRow, wsPath: string): void => {
    const remoteHost = hostOf(wsPath)
    if (row.pending) {
      // while pending the row's id IS the launching pty's tab — clicking it shows
      // the boot output; there is no session id to resume yet (§4)
      activateTab(row.id)
      return
    }
    if (row.running) {
      // F7: main kept the pty but this renderer has no tab to show for it. The click
      // would otherwise be a silent no-op on a row that can't be archived either, so
      // offer the only way out it has — but only once boot adoption has settled
      // (in the sub-second window before the inventory lands EVERY
      // running row reads as orphaned, and the tab is about to come back), and after
      // re-reading the binding from main: the rows push can outrun the throttled
      // session stream right after a bind, and a healthy session must never be
      // offered for the kill.
      // on a remote machine "running with no tab here" is the ordinary state after
      // Koloft restarts — the claude is alive inside tmux over there. Clicking it
      // re-attaches (main's resume plan answers `direct`), so the local orphan question,
      // whose only answer is "force close", never applies.
      if (isOrphanRow(row, sessions, storeTabs)) {
        if (remoteHost) {
          void resumeSession(row)
          return
        }
        void adoptionSettled.then(() => {
          const st = useStore.getState()
          if (!isOrphanRow(row, st.sessions, st.tabs)) return // adoption brought it back
          void window.api.sessions.list().then((live) => {
            if (isOrphanRow(row, live, useStore.getState().tabs)) setConfirmOrphan(row.id)
          })
        })
        return
      }
      const tabId = tabIdFor(row.id)
      if (tabId) {
        // an explicit sidebar visit consumes the attention marker even when the
        // tab is already active (App's activeTabId effect can't re-fire then)
        window.api.attention.visit(tabId)
        activateTab(tabId)
      }
      return
    }
    if (resumeInFlight(row.id)) {
      // mid-resume: a second click means "show me" — focus the live resume tab
      // (the flow's own dedupe still blocks a second pty)
      const t = useStore.getState().tabs.find((x) => x.sessionId === row.id && x.alive)
      if (t) activateTab(t.id)
      return
    }
    // the lifecycle contract §4: an invalidCwd row goes in here too — the decision tree owns
    // "the worktree is gone" (rebuild, D6), so pre-gating it would close off D6
    void resumeSession(row)
  }

  const forceCloseSession = async (id: string): Promise<void> => {
    const r = await window.api.sessions.forceClose(id)
    if (!r.ok) showToast(FORCE_CLOSE_FAILED_NOTICE)
  }

  const removeWorkspace = async (path: string): Promise<void> => {
    const dirty = dirtyInWorkspace(path)
    // B-31: `workspace.remove` unpins as a side effect of counting running sessions, so
    // with unsaved work at stake the count has to come from the rows instead — main
    // counts the very same two flags off the very same cache (workspaces.ts
    // `runningTabsOf`), which is what makes reading them here equivalent rather than a
    // second opinion.
    const running = (rows.find((w) => w.workspace.path === path)?.rows ?? []).filter(
      (r) => r.running || r.pending
    ).length
    // the scheduled jobs the removal deletes too. Main answers with the count when
    // it is asked; on the routes that never ask main, the renderer's copy of the job
    // list is the same list.
    const jobsHere = useStore.getState().cron.jobs.filter((j) => j.workspacePath === path).length
    const plan = removePlan(running, dirty.length)
    if (plan === 'remove') {
      const r = await window.api.workspace.remove(path)
      if (!r.removed) {
        setRemoving(false)
        setConfirmRemove({ path, running: r.running, jobs: r.jobs, dirty: [] })
      }
      return
    }
    if (plan === 'confirm-running') {
      setRemoving(false)
      setConfirmRemove({ path, running, jobs: jobsHere, dirty })
      return
    }
    // nothing running, so the sessions are not the story — the files are, and the jobs,
    // which this route deletes just as silently as the other two would
    useStore.getState().setUnsavedPrompt({
      files: labelPaths(dirty),
      jobs: jobsHere,
      onCancel: () => {},
      onDiscard: () => {
        discardAll(dirty)
        void window.api.workspace.removeConfirmed(path)
      },
      onSave: async () => {
        const ok = await saveAll(dirty)
        // down either way — a refused save has put the offending tab in front of the
        // user, and this modal would be covering it
        useStore.getState().setUnsavedPrompt(null)
        if (ok) void window.api.workspace.removeConfirmed(path)
      }
    })
  }

  const copy = (text: string): void => {
    navigator.clipboard?.writeText(text).catch(() => {})
  }

  // ---- render ----------------------------------------------------------------

  /** The row menu's "where is it" item. A local row reveals the folder in Finder; a
   *  remote one has nothing this Mac can open, so it hands over `machine:/path` instead
   * the string that gets you there from a terminal.
   *
   *  R11/R14: the folder is `revealDir` — where the session is NOW, which follows
   *  claude into and out of a worktree — and it is the same folder the greying is decided
   *  by, because main hands it over only when there is something there to open. */
  const revealOrCopyPath = (t: Extract<MenuTarget, { kind: 'session' }>): JSX.Element => {
    const remoteHost = hostOf(t.wsPath)
    const label = remoteHost ? 'Copy path' : 'Reveal in Finder'
    const dir = t.row.revealDir
    if (!dir) return <div className="mi disabled">{label}</div>
    return (
      <div
        className="mi"
        onClick={() => {
          setMenu(null)
          if (remoteHost) copy(remoteCopyText(remoteHost, dir))
          else window.api.fs.reveal(dir)
        }}
      >
        {label}
      </div>
    )
  }

  const renderMenu = (): JSX.Element | null => {
    if (!menu) return null
    const { target } = menu
    const style = { left: menu.left, top: menu.top }
    if (target.kind === 'workspace') {
      const remote = hostOf(target.wsPath)
      return (
        <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
          {!target.missing && (
            <>
              <div
                className="mi"
                onClick={() => {
                  setMenu(null)
                  onNewSession(target.wsPath)
                }}
              >
                {namedMethods ? `New ${backendLabel(namedMethods[0])} session` : 'New session'}
                <span className="k">⌘N</span>
              </div>
              {/* A1: the other method, named outright. No ellipsis — like the item above
                  it starts straight away, and it is here only where there IS another
                  method on this Mac to choose between. */}
              {namedMethods && (
                <div
                  className="mi"
                  onClick={() => {
                    setMenu(null)
                    onNewSession(target.wsPath, namedMethods[1])
                  }}
                >
                  New {backendLabel(namedMethods[1])} session
                </div>
              )}
              {/* C8 (D7): the second creation action, per-workspace. A non-git
                  workspace has no worktrees to speak of, so the item is not there at
                  all (D10) — the same gate the Fetch origin item sits behind */}
              {target.isGit && (
                <div
                  className="mi"
                  onClick={() => {
                    setMenu(null)
                    onNewWorktreeSession(target.wsPath)
                  }}
                >
                  New worktree session…<span className="k">⇧⌘N</span>
                </div>
              )}
              {/* C9 (D9): history's only entrance. A workspace with nothing to restore
                  keeps the item — greyed, so the door stays where the user learned it */}
              <div
                className={'mi' + (target.hasHistory ? '' : ' disabled')}
                onClick={() => {
                  setMenu(null)
                  onRestoreSession(target.wsPath)
                }}
              >
                Restore session…
              </div>
              {/* the resident manual fetch (D9): it is here even when no badge
                  is showing, and it is what still works with gitAutoFetch off */}
              {target.isGit && !remote && (
                <div
                  className="mi"
                  onClick={() => {
                    setMenu(null)
                    void window.api.workspace.fetchFreshness(target.wsPath)
                  }}
                >
                  Fetch origin
                </div>
              )}
              {/* the one door to a workspace's scheduled jobs. A plain folder
                  can have them too — a run just works in the folder itself. a
                  remote workspace has none — the runner only takes local paths. */}
              {!remote && (
                <div
                  className="mi"
                  onClick={() => {
                    setMenu(null)
                    onScheduledJobs(target.wsPath)
                  }}
                >
                  Scheduled jobs…
                </div>
              )}
              <div className="sep" />
            </>
          )}
          <div
            className="mi danger"
            onClick={() => {
              setMenu(null)
              void removeWorkspace(target.wsPath)
            }}
          >
            Remove workspace
          </div>
        </div>
      )
    }
    const { row } = target
    if (row.pending) {
      // the escape hatch for a launch that hangs: killing the pty drops the row
      // (main's exit path removes it) — nothing else applies before a session binds
      return (
        <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
          <div
            className="mi"
            onClick={() => {
              setMenu(null)
              window.api.terminal.kill(row.id)
            }}
          >
            Cancel
          </div>
        </div>
      )
    }
    if (row.running) {
      // no Close item: ending a running session is ⌘W's job (the lifecycle contract D3, which
      // asks first when it is mid-turn), never a menu entry two pixels from Reveal.
      // Remove from list is likewise off the table while it runs — a live session is
      // always a list member.
      return (
        <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
          {revealOrCopyPath(target)}
          <div
            className="mi"
            onClick={() => {
              setMenu(null)
              copy(row.nativeSessionId ?? identityOf(row.id).nativeSessionId)
            }}
          >
            Copy session ID
          </div>
        </div>
      )
    }
    return (
      <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
        <div className="mi head">{relTime(row.mtime, Date.now())}</div>
        <div className="sep" />
        {/* offered even with the cwd gone (the lifecycle contract D6): the decision tree turns
            that into a rebuild, so hiding the item is what would strand the session */}
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            clickRow(row, target.wsPath)
          }}
        >
          Resume<span className="k">↩</span>
        </div>
        {revealOrCopyPath(target)}
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            copy(row.nativeSessionId ?? identityOf(row.id).nativeSessionId)
          }}
        >
          Copy session ID
        </div>
        {/* deregister only: the row leaves the working set, the jsonl stays in Claude's
            storage and "Restore from history" brings it back (the lifecycle contract D4 — copy
            only; the channel is still sessions:archive) */}
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            void window.api.sessions.archive(row.id)
          }}
        >
          Remove from list
        </div>
      </div>
    )
  }

  /** The card is a live view of the pushed rows: it reads its workspace back out of
   *  them each render, and a freshness that vanished takes the card with it. */
  /** The ⏸ badge's card (the badge is its only door, like the workspace row's fetch
   *  badge): what the session keeps parked, and how to release it. Same look as the
   *  freshness card. A native tooltip never got the chance — the row's hover-intent
   *  menu opens first (live,). */
  const renderParked = (): JSX.Element | null => {
    if (!parkedPop) return null
    const row = rows.flatMap((w) => w.rows).find((r) => r.id === parkedPop.rowId)
    const badge = row ? parkedFor(row) : null
    if (!badge) return null // released meanwhile: nothing left to name
    return (
      <div
        className="tbu-pop parked"
        style={{ left: parkedPop.left, top: parkedPop.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tbu-pop-head">
          <span>{badge.heading}</span>
        </div>
        <div className="tbu-row">
          {badge.lines.map((line, index) => (
            <div key={`${index}:${line}`} className="parked-line">
              {line}
            </div>
          ))}
        </div>
        <div className="tbu-sep" />
        <div className="tbu-row parked-hint">{badge.hint}</div>
      </div>
    )
  }

  const renderFresh = (): JSX.Element | null => {
    if (!fresh) return null
    const w = rows.find((r) => r.workspace.path === fresh.path)
    if (!w?.workspace.freshness) return null
    return (
      <FreshnessPopover
        // one mousemove can swap the card from A's badge to B's in a single render;
        // B must not inherit A's failure line or in-flight fetch flag
        key={fresh.path}
        wsPath={fresh.path}
        f={w.workspace.freshness}
        rows={w.rows}
        left={fresh.left}
        top={fresh.top}
        onClose={() => setFresh(null)}
        onBusy={setFreshBusy}
        onMouseEnter={enterCard}
        onMouseLeave={leaveCard}
      />
    )
  }

  return (
    <>
      <div className="island flat isl-sessions">
        <div
          className="ws-list"
          onScroll={() => {
            setMenu(null)
            setParkedPop(null)
            if (!freshBusy.current) setFresh(null)
          }}
        >
          {rows.length === 0 && !welcomeActive && (
            <div className="hint">
              No workspaces yet.
              <br />
              Press ⇧⌘O to add a folder — its sessions appear here.
            </div>
          )}

          {rows.map(({ workspace: ws, rows: sessionRows }) => {
            const open = !collapsed[ws.path]
            const wsTarget: MenuTarget = {
              kind: 'workspace',
              wsPath: ws.path,
              missing: ws.missing,
              isGit: ws.isGit,
              hasHistory: ws.hasHistory
            }
            const badge = behindBadge(ws.freshness, Date.now())
            // D7/D10, in ONE place: a repo's new-session door branches a worktree, a plain
            // folder's starts in the folder itself. The head's hover button and an empty
            // group's row are the same door and must never drift apart.
            const door = ws.isGit
              ? {
                  title: 'New worktree session · ⇧⌘N',
                  label: 'New worktree…',
                  Icon: LuGitBranchPlus
                }
              : { title: 'New session', label: 'New session', Icon: LuPlus }
            const openDoor = (): void => {
              // a hover-armed fly-out must not pop up over the dialog this opens
              clearTimers()
              setMenu(null)
              if (ws.isGit) onNewWorktreeSession(ws.path)
              else onNewSession(ws.path)
            }
            // what the forecast row above the sessions says. Read fresh each
            // render — the 30 s tick above is what brings the render back. A folder
            // that is gone gets no row, for the same reason it gets no git mark:
            // nothing can run there, and the row already says the folder was
            // deleted. A folded workspace gets none either — nothing of it is on
            // screen but the head, and the head is the one place this must not grow.
            const cronNow = new Date()
            const soon =
              ws.missing || !open || ws.remote ? null : forecastFor(cron.jobs, ws.path, cronNow)
            return (
              <div className="ws" key={ws.path}>
                <div
                  className={
                    'ws-head' +
                    (ws.missing ? ' missing' : '') +
                    (selectedWs === ws.path && activeTabId === null ? ' active' : '')
                  }
                  title={ws.missing ? 'folder deleted' : ws.path}
                  // D7 — clicking the head PICKS this workspace; the folder icon
                  // below is what folds the group now. The workspace itself has to be
                  // pickable so its own panel can be reached when nothing is running in
                  // it, and it makes "a session is picked" and "nothing is picked" one
                  // rule: the current workspace is the selection's workspace. A vanished
                  // folder cannot be the current one, so its head only opens its menu.
                  onClick={() => {
                    if (ws.missing) return
                    selectWorkspace(ws.path)
                  }}
                  onContextMenu={(e) => openMenuNow(e, wsTarget)}
                  onMouseEnter={(e) => armHoverMenu(e, wsTarget)}
                  onMouseLeave={scheduleClose}
                >
                  <span
                    className="fico"
                    title={open ? 'Fold' : 'Unfold'}
                    onClick={(e) => {
                      // like the badge and the hover button below: folding must never
                      // also pick the workspace
                      e.stopPropagation()
                      setCollapsed((c) => ({ ...c, [ws.path]: !c[ws.path] }))
                    }}
                  >
                    {open ? <LuFolderOpen size={15} /> : <LuFolder size={15} />}
                  </span>
                  {/* the group's name is the last part of the directory either way —
                      for a remote one that is the path INSIDE the key, so the head never
                      reads "ssh:". */}
                  <span className="ws-name">{basename(ws.remote?.path ?? ws.path)}</span>
                  {ws.remote && (
                    <span
                      className="ws-remote"
                      title={remoteCopyText(ws.remote.host, ws.remote.path)}
                    >
                      {ws.remote.host}
                      <span
                        className={'ws-conn' + (ws.remote.connected ? ' on' : '')}
                        title={
                          ws.remote.connected ? 'connected' : 'not connected — status may be stale'
                        }
                      />
                    </span>
                  )}
                  {/* a plain folder wears nothing: its worktree entrances are already off the row (D10) */}
                  {ws.isGit && !ws.missing && (
                    <span
                      className="ws-git"
                      // with a count showing, icon and count together are the card's
                      // door — and the empty title is load-bearing: without it the head
                      // row's path tooltip inherits onto this area and pops over the card
                      title={badge ? '' : 'git repository'}
                      onMouseEnter={
                        badge ? (e) => openCard(e.currentTarget as HTMLElement, ws.path) : undefined
                      }
                      onMouseLeave={
                        badge
                          ? (e) => {
                              leaveCard()
                              const head = (e.currentTarget as HTMLElement).closest('.ws-head')
                              armMenu(head as HTMLElement, wsTarget)
                            }
                          : undefined
                      }
                    >
                      <GoGitBranch size={12} />
                      {badge && (
                        <button
                          className={badge.cls}
                          aria-label={badge.name}
                          onClick={(e) => {
                            // the keyboard's door; it must never reach the head row's
                            // own click (which picks the workspace)
                            e.stopPropagation()
                            openCard((e.currentTarget as HTMLElement).parentElement!, ws.path)
                          }}
                        >
                          {badge.label}
                        </button>
                      )}
                    </span>
                  )}
                  {/* ONE hover button per head, never two: the old ＋/⑂ pair sat side
                      by side and the wrong one got hit (retired, restored 2026-09-06
                      as a single button). A git workspace offers only the worktree door
                      (D7/D10); a plain folder offers only the main-session door. The
                      fly-out menu and ⌘N/⇧⌘N stay as they were. */}
                  {!ws.missing && (
                    <button
                      className="hact"
                      title={door.title}
                      aria-label={door.title}
                      onClick={(e) => {
                        // like the badge above: acting on the row must not pick the workspace
                        e.stopPropagation()
                        openDoor()
                      }}
                    >
                      <door.Icon size={16} />
                    </button>
                  )}
                </div>

                {open && (soon || sessionRows.length > 0 || !ws.missing) && (
                  <div className="ws-tabs">
                    {/* the next run, as a row of its own above the sessions. It
                        used to be a badge on the head, where it crowded the name out
                        on a narrow sidebar. Clicking it
                        opens that job's card. */}
                    {soon && (
                      <div
                        className="ws-next"
                        title={soon.title}
                        onClick={(e) => {
                          // like the head's other buttons: acting on it must not fold
                          // the workspace or leave a hover-armed fly-out behind
                          e.stopPropagation()
                          clearTimers()
                          setMenu(null)
                          onScheduledJobs(ws.path, soon.id)
                        }}
                      >
                        <LuAlarmClock size={12} className="ws-next-ico" />
                        <span className="ws-next-name">{soon.name}</span>
                        {soon.more > 0 && <span className="ws-next-more">{`+${soon.more}`}</span>}
                        <span className="ws-next-dot">·</span>
                        <span className={'ws-next-at' + (soon.soon ? ' soon' : '')}>
                          {describeWhen(soon.at, cronNow)}
                        </span>
                      </div>
                    )}
                    {sessionRows.map((row) => {
                      // a pending row's id is already its pty tab; a running row
                      // reaches its tab through the bound session id
                      const tabId = row.pending
                        ? row.id
                        : row.running
                          ? tabIdFor(row.id)
                          : undefined
                      const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
                      const stateCls =
                        sess?.observation === 'degraded'
                          ? ''
                          : rowStateClass(row.running, sess?.status, row.pending)
                      // what the session keeps open without working on it (a dev
                      // server, a Monitor, idle teammates) — never a run-state,
                      // always worth a glance: the user is the one who releases it
                      const badge = sessionActivityBadge(sess)
                      // the cold row just clicked, while main is still on its plan and
                      // spawn: the click has to read at once, so this row is the
                      // selected one from the click on — and the tab that WAS active
                      // hands the highlight over now rather than when the pty lands
                      const launching = resumeLaunch?.id === row.id
                      // a cold row has no tab (its pty exit closed it), so it is never
                      // the selected one — same as after an app restart
                      const active =
                        launching || (!resumeLaunch && !!tabId && tabId === activeTabId)
                      // resume window (bug reported): the resume pty is alive but
                      // the hook hasn't bound, so the aggregation still says cold —
                      // wear the launch treatment (flowing bar) instead of playing
                      // dead. Visual only: menu and click semantics stay the row's.
                      const resumingNow =
                        !row.running &&
                        !row.pending &&
                        (launching || storeTabs.some((t) => t.sessionId === row.id && t.alive))
                      const shownCls = resumingNow
                        ? rowStateClass(false, undefined, true)
                        : stateCls
                      const rowTarget: MenuTarget = {
                        kind: 'session',
                        wsPath: ws.path,
                        row
                      }
                      // the ⏰ mark. While a run is live main names it outright —
                      // by its tab (always a live one: a dead session IS a cold row since
                      //, its tab is gone) or by its session id; once it is cold the
                      // run folder's name is what is left to go on, so a job's old runs
                      // keep the mark and a hand-made folder with the same prefix wears
                      // one too (an accepted limit).
                      const isCronRow =
                        SESSION_CAPABILITIES[row.backendId ?? 'claude'].scheduledTasks &&
                        (cron.live.some(
                          (l) => (!!tabId && l.tabId === tabId) || l.sessionId === row.id
                        ) ||
                          (row.worktree !== 'main' &&
                            cron.jobs.some(
                              (j) =>
                                j.workspacePath === ws.path &&
                                row.worktree.startsWith(slugOf(j.name) + '-')
                            )))
                      return (
                        <div
                          key={row.id}
                          // D6: a deleted worktree is no longer a dead row — it is the
                          // rebuild branch of the resume tree, so it keeps the live
                          // treatment and only the tooltip says what will happen
                          className={'ws-tab ' + shownCls + (active ? ' active' : '')}
                          // Layer B anchors a hint card here (`rowSelector`)
                          data-tab-id={tabId}
                          // a live row had the directory the session STARTED in
                          // here, which goes stale the moment claude moves it. There is
                          // nothing a tooltip must say about a running session, so the
                          // live branch is gone; the cold one still offers the resume.
                          title={
                            row.running || row.pending
                              ? undefined
                              : relTime(row.mtime, Date.now()) +
                                (row.invalidCwd
                                  ? ' — worktree deleted; click to rebuild and resume'
                                  : ' — click to resume')
                          }
                          onClick={() => clickRow(row, ws.path)}
                          onContextMenu={(e) => openMenuNow(e, rowTarget)}
                          onMouseEnter={(e) => {
                            armHoverMenu(e, rowTarget)
                            const t = (e.currentTarget as HTMLElement).querySelector(
                              '.ws-tab-title'
                            )
                            // measured before .mq lands, i.e. while the title is
                            // still the truncated single line
                            const overflow = t ? t.scrollWidth - t.clientWidth : 0
                            if (overflow > 0) setMq({ id: row.id, overflow })
                          }}
                          onMouseLeave={() => {
                            scheduleClose()
                            setMq((m) => (m?.id === row.id ? null : m))
                          }}
                        >
                          <div className="ws-tab-main">
                            {isCronRow && (
                              <span className="ws-tab-cron" title="started by a scheduled job">
                                <LuAlarmClock size={12} />
                              </span>
                            )}
                            <span className={'ws-tab-title' + (mq?.id === row.id ? ' mq' : '')}>
                              {/* a fresh/rebinding session carries PLACEHOLDER_SESSION_TITLE
                                  until its jsonl yields a real one — the aggregated row title
                                  (same fallback chain, already on disk) must win over it, or
                                  the row text flickers to the placeholder during ⇧⌘R restarts */}
                              <i ref={mq?.id === row.id ? mqRef : undefined}>
                                {sess?.title && sess.title !== PLACEHOLDER_SESSION_TITLE
                                  ? sess.title
                                  : row.title}
                              </i>
                            </span>
                            {badge && (
                              <button
                                className="ws-tab-parked"
                                title={badge.lines.join('\n')}
                                aria-label={badge.heading}
                                onClick={(e) => {
                                  // the badge is the card's only door — it must never
                                  // reach the row's select/resume click
                                  e.stopPropagation()
                                  clearTimers()
                                  setMenu(null)
                                  setParkedPop({
                                    rowId: row.id,
                                    ...cardPosFor(e.currentTarget as HTMLElement)
                                  })
                                }}
                              >
                                {badge.text}
                              </button>
                            )}
                          </div>
                          <div className="ws-tab-sub">
                            {mixesBackends(sessionRows) && (
                              <SessionBackendIcon backend={row.backendId} />
                            )}
                            <span>{row.worktree}</span>
                          </div>
                        </div>
                      )
                    })}
                    {/* an empty workspace's row IS the door. Keep the label short: 11px
                        mono fits ~19 characters at the sidebar's 200px minimum, and the
                        sentence that used to sit here ran the list sideways. */}
                    {sessionRows.length === 0 && !ws.missing && (
                      <div className="ws-empty" title={door.title} onClick={openDoor}>
                        <door.Icon size={12} />
                        <span>{door.label}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {renderMenu()}
      {renderFresh()}
      {renderParked()}

      {confirmRemove && (
        <div className="modal-backdrop" onClick={() => !removing && setConfirmRemove(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              Remove workspace
              <span
                className="modal-close"
                onClick={() => !removing && setConfirmRemove(null)}
                aria-label="Close"
              >
                <LuX size={16} />
              </span>
            </div>
            <div className="modal-body">
              <div className="field-hint">
                {removeConfirmText(confirmRemove.running, confirmRemove.jobs)}
                {confirmRemove.dirty.length > 0 &&
                  ' ' + removeUnsavedNote(confirmRemove.dirty.length)}
              </div>
            </div>
            <div className="modal-foot">
              <button
                ref={removeCancelRef}
                className="mini"
                disabled={removing}
                onClick={() => setConfirmRemove(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={removing}
                onClick={() => {
                  // B-31: Discard is the ordinary removal with the typing thrown away
                  // first — the buffers would die with their sessions either way, so
                  // this only makes that explicit
                  discardAll(confirmRemove.dirty)
                  const p = confirmRemove.path
                  setConfirmRemove(null)
                  void window.api.workspace.removeConfirmed(p)
                }}
              >
                {confirmRemove.dirty.length > 0 ? 'Discard & remove' : 'Close & remove'}
              </button>
              {confirmRemove.dirty.length > 0 && (
                <button
                  className="btn-primary"
                  disabled={removing}
                  onClick={() => {
                    // a file that never reached the disk cancels the removal outright:
                    // the buffer is the only copy of that work and the sessions holding
                    // it are what this button would kill
                    const { path: p, dirty } = confirmRemove
                    setRemoving(true)
                    void saveAll(dirty).then((ok) => {
                      setRemoving(false)
                      // down either way: a refused save has brought the offending tab
                      // forward and this modal would be sitting on top of it
                      setConfirmRemove(null)
                      if (ok) void window.api.workspace.removeConfirmed(p)
                    })
                  }}
                >
                  Save &amp; remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmOrphan && (
        <div className="modal-backdrop" onClick={() => setConfirmOrphan(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              Session unreachable
              <span
                className="modal-close"
                onClick={() => setConfirmOrphan(null)}
                aria-label="Close"
              >
                <LuX size={16} />
              </span>
            </div>
            <div className="modal-body">
              <div className="field-hint">
                This session is running but its tab could not be re-adopted. Force close it to make
                the row resumable — its in-flight work will stop.
              </div>
            </div>
            <div className="modal-foot">
              <button className="mini" onClick={() => setConfirmOrphan(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  const id = confirmOrphan
                  setConfirmOrphan(null)
                  void forceCloseSession(id)
                }}
              >
                Force Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

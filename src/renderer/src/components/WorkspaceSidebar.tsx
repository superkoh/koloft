import {
  BACKEND_LABEL,
  capabilitiesFor,
  identityOf,
  unsupportedPairMessage
} from '@shared/sessionBackend'
import { SessionBackendIcon } from './SessionBackendIcon'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type MouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { GoGitBranch, GoGitPullRequest, GoIssueOpened } from 'react-icons/go'
import {
  LuAlarmClock,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuFileText,
  LuFolder,
  LuFolderOpen,
  LuGitBranchPlus,
  LuPin,
  LuPlus,
  LuX
} from 'react-icons/lu'
import type { BackendId, SessionRow } from '@shared/types'
import type { DirtyTab } from '../unsavedGuard'
import { ATTENTION_REASON } from '@shared/types'
import { popoverX } from '@shared/accountUsage'
import { slugOf } from '@shared/cronNames'
import { describeWhen } from '@shared/schedule'
import { forecastFor } from '../cronForm'
import { useStore } from '../store'
import {
  attentionOnRow,
  isOrphanRow,
  liveTabOf,
  marqueeAnim,
  mixesBackends,
  sessionActivityBadge,
  leftoverLabel,
  relTime,
  rowStateClass,
  rowsUnder,
  sessionsInside,
  sessionsNeedYou,
  sessionTree,
  shownTitle,
  statusUnavailable,
  tabOfRow,
  workspaceName,
  type RowNode
} from '../sessionRows'
import { releaseSettledResumes } from '../resumeFlow'
import { offerForceCloseUnlessMainHasBoundIt, openSessionRow } from '../sessionClick'
import { requestCloseTab } from '../closeFlow'
import { freshnessShown } from '@shared/freshnessOps'
import { behindBadge, countLabel, openIssuesLabel, openPullsLabel } from '../freshnessView'
import { fitGithubCounts } from '../wsHeadFit'
import { FreshnessPopover } from './FreshnessPopover'
import { basename } from '@shared/preview'
import { hostOf, parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { remoteDotTitle, workspaceMenuCount } from '../remoteWorkspace'
import {
  discardAll,
  dirtyInWorkspace,
  labelPaths,
  removeJobsNote,
  removePlan,
  removeUnsavedNote,
  saveAll
} from '../unsavedGuard'

const FORCE_CLOSE_FAILED_NOTICE =
  'Could not force close — the session may be running outside Koloft.'

const CRON_BADGE_MS = 30_000

function removeConfirmText(running: number, jobs: number): string {
  const s = `${running} running session${running === 1 ? '' : 's'} will be closed`
  const j = `${jobs} scheduled job${jobs === 1 ? '' : 's'} will be deleted`
  const kept =
    'Sessions are kept by Claude or Codex — re-adding the folder brings them back as resumable.'
  if (jobs === 0) return `${s}. ${kept}`
  if (running === 0) return removeJobsNote(jobs)
  return `${s}, and ${j}. ${kept} Jobs do not come back.`
}

const HOVER_MENU_MS = 350
const MENU_LEAVE_MS = 140
const MENU_W = 190
const MENU_ITEM_H = 31
const MENU_PAD_H = 10
const NO_INHERITED_TOOLTIP = ''
const FRESH_POP_W = 300
const FRESH_POP_H = 250

type MenuTarget =
  | { kind: 'session'; wsPath: string; row: SessionRow }
  | {
      kind: 'workspace'
      wsPath: string
      missing: boolean
      isGit: boolean
    }

// ADR-0025
const machineOf = (wsPath: string): string | undefined => parseRemoteKey(wsPath)?.host ?? undefined

interface MenuState {
  target: MenuTarget
  left: number
  top: number
}

export function useDismissOnOutside(open: boolean, dismiss: (none: null) => void): void {
  useEffect(() => {
    if (!open) return
    const close = (): void => dismiss(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, dismiss])
}

export function menuPosFor(el: HTMLElement, itemCount: number): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  let left = r.right - 6
  if (left + MENU_W > window.innerWidth - 4) left = Math.max(4, r.left - MENU_W + 6)
  const estH = itemCount * MENU_ITEM_H + MENU_PAD_H
  const top = Math.min(r.top, Math.max(4, window.innerHeight - estH - 4))
  return { left, top }
}

function cardPosFor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  return {
    left: popoverX(r.left + r.width / 2, FRESH_POP_W, window.innerWidth),
    top: Math.min(r.bottom + 6, Math.max(4, window.innerHeight - FRESH_POP_H - 4))
  }
}

function UnseenFileMark({ tabId }: { tabId: string }): JSX.Element | null {
  const src = useStore((s) => (s.openFiles[tabId]?.unseen ? s.openFiles[tabId]?.src : undefined))
  if (!src) return null
  return (
    <span
      className="ws-tab-opened"
      title={`${basename(src)} was opened here — select this session to see it`}
    >
      <LuFileText size={12} />
    </span>
  )
}

export function WorkspaceSidebar({
  onNewSession,
  namedMethods,
  onNewWorktreeSession,
  onRestoreSession,
  onScheduledJobs
}: {
  onNewSession: (wsPath: string, backend?: BackendId) => void
  namedMethods: [BackendId, BackendId] | null
  onNewWorktreeSession: (wsPath: string) => void
  onRestoreSession: (wsPath: string) => void
  onScheduledJobs: (wsPath: string, jobId?: string) => void
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const welcomeActive = useStore((s) => s.welcomeActive)
  const cron = useStore((s) => s.cron)
  const sessions = useStore((s) => s.sessions)
  const leftovers = useStore((s) => s.leftovers)
  const attention = useStore((s) => s.attention)
  const storeTabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const resumeLaunch = useStore((s) => s.resumeLaunch)
  const selectedWs = useStore((s) => s.selectedWs)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const showToast = useStore((s) => s.showToast)
  const conductorBindings = useStore((s) => s.settings.discord.bindings)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const canBind = (wsPath: string): boolean => !conductorBindings.some((b) => b.scope === wsPath)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [foldedRows, setFoldedRows] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [drag, setDrag] = useState<{ path: string; over: number | null } | null>(null)
  const [mq, setMq] = useState<{ id: string; overflow: number } | null>(null)
  const mqRef = useRef<HTMLElement | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{
    path: string
    running: number
    jobs: number
    dirty: DirtyTab[]
  } | null>(null)
  const [removing, setRemoving] = useState(false)
  const removeCancelRef = useRef<HTMLButtonElement>(null)
  const confirmOrphan = useStore((s) => s.orphanConfirm)
  const setConfirmOrphan = useStore((s) => s.setOrphanConfirm)
  const [fresh, setFresh] = useState<{ path: string; left: number; top: number } | null>(null)
  const [parkedPop, setParkedPop] = useState<{ rowId: string; left: number; top: number } | null>(
    null
  )
  const freshBusy = useRef(false)
  const setFreshBusy = useCallback((busy: boolean) => {
    freshBusy.current = busy
  }, [])
  const closeFloating = (): void => {
    setMenu(null)
    setParkedPop(null)
    if (!freshBusy.current) setFresh(null)
  }
  const sidebarHidden = useStore((s) => s.settings.sidebarHidden)
  useEffect(() => {
    if (sidebarHidden) closeFloating()
  }, [sidebarHidden])
  const [, bumpCronClock] = useState(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tabIdFor = (sessionId: string): string | undefined =>
    liveTabOf(sessionId, sessions, storeTabs)
  const tabIdOfRow = (row: SessionRow): string | undefined => tabOfRow(row, sessions, storeTabs)
  const callingAmong = (rows: SessionRow[]): number =>
    rows.filter((r) => attentionOnRow(r.id, tabIdOfRow(r), attention)).length

  useEffect(() => {
    const t = setInterval(() => bumpCronClock((n) => n + 1), CRON_BADGE_MS)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (confirmRemove && confirmRemove.dirty.length > 0) removeCancelRef.current?.focus()
  }, [confirmRemove])

  useEffect(() => {
    const cold = new Set<string>()
    for (const w of rows) for (const r of w.rows) if (!r.running) cold.add(r.id)
    releaseSettledResumes(cold)
  }, [rows])

  useEffect(() => {
    const el = mqRef.current
    if (!mq || !el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const spec = marqueeAnim(mq.overflow)
    if (!spec) return
    const anim = el.animate(spec.frames, spec.timing)
    return () => anim.cancel()
  }, [mq])

  const marqueeIfClipped = (host: HTMLElement, selector: string, id: string): void => {
    const t = host.querySelector(selector)
    const overflow = t ? t.scrollWidth - t.clientWidth : 0
    if (overflow > 0) setMq({ id, overflow })
  }
  const stopMarquee = (id: string): void => setMq((m) => (m?.id === id ? null : m))

  const listRef = useRef<HTMLDivElement>(null)
  const fitHeads = useCallback((): void => {
    listRef.current?.querySelectorAll<HTMLElement>('.ws-head').forEach(fitGithubCounts)
  }, [])
  useLayoutEffect(fitHeads, [rows, fitHeads])
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(fitHeads)
    ro.observe(list)
    return () => ro.disconnect()
  }, [fitHeads])

  const clearTimers = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    hoverTimer.current = null
    leaveTimer.current = null
  }

  useDismissOnOutside(!!menu, setMenu)

  const parkedFor = (row: SessionRow): ReturnType<typeof sessionActivityBadge> => {
    const sess = row.running ? sessions.find((s) => s.tabId === tabIdFor(row.id)) : undefined
    return sessionActivityBadge(sess, leftovers[row.id])
  }

  useDismissOnOutside(!!parkedPop, setParkedPop)

  const menuItemCount = (t: MenuTarget): number =>
    t.kind === 'workspace'
      ? workspaceMenuCount({ missing: t.missing, isGit: t.isGit, canBind: canBind(t.wsPath) })
      : t.row.pending
        ? 1
        : t.row.running
          ? 3
          : 5

  const openMenuAt = (el: HTMLElement, target: MenuTarget): void => {
    const pos = menuPosFor(el, menuItemCount(target))
    setMenu({ target, ...pos })
  }

  const armMenu = (e: MouseEvent, el: HTMLElement, target: MenuTarget): void => {
    const draggingThrough = e.buttons !== 0
    if (draggingThrough) return
    hoverTimer.current = setTimeout(() => openMenuAt(el, target), HOVER_MENU_MS)
  }
  const armHoverMenu = (e: MouseEvent, target: MenuTarget): void => {
    clearTimers()
    armMenu(e, e.currentTarget as HTMLElement, target)
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

  const wsPaths = rows.map((r) => r.workspace.path)
  const startWorkspaceDrag = (e: DragEvent<HTMLElement>, path: string): void => {
    clearTimers()
    closeFloating()
    e.dataTransfer.effectAllowed = 'move'
    // PLATFORM§10
    e.dataTransfer.setData('text/plain', path)
    setDrag({ path, over: null })
  }
  const dragOverWorkspaces = (e: DragEvent<HTMLElement>): void => {
    if (!drag) return
    e.preventDefault()
    const block = (e.target as Element).closest<HTMLElement>('.ws[data-ws-path]')
    let over: number | null = null
    if (block) {
      const box = block.getBoundingClientRect()
      const below = e.clientY >= box.top + box.height / 2
      const slot = wsPaths.indexOf(block.dataset.wsPath ?? '') + (below ? 1 : 0)
      const from = wsPaths.indexOf(drag.path)
      if (slot !== from && slot !== from + 1) over = slot
    }
    if (drag.over !== over) setDrag({ ...drag, over })
  }
  const dropWorkspace = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault()
    setDrag(null)
    if (drag?.over == null) return
    void window.api.workspace.move(drag.path, wsPaths[drag.over] ?? null)
  }

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

  const forceCloseSession = async (id: string): Promise<void> => {
    const r = await window.api.sessions.forceClose(id)
    if (!r.ok) showToast(FORCE_CLOSE_FAILED_NOTICE)
  }

  const removeWorkspace = async (path: string): Promise<void> => {
    const dirty = dirtyInWorkspace(path)
    const running = (rows.find((w) => w.workspace.path === path)?.rows ?? []).filter(
      (r) => r.running || r.pending
    ).length
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
        useStore.getState().setUnsavedPrompt(null)
        if (ok) void window.api.workspace.removeConfirmed(path)
      }
    })
  }

  const copy = (text: string): void => {
    navigator.clipboard?.writeText(text).catch(() => {})
  }

  const revealOrCopyPath = (t: Extract<MenuTarget, { kind: 'session' }>): JSX.Element => {
    const remoteHost = machineOf(t.wsPath)
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

  const keepRunningItem = (row: SessionRow): JSX.Element => (
    <div
      className="mi"
      onClick={() => {
        setMenu(null)
        window.api.sessions.setResident(row.id, !row.resident)
      }}
    >
      Keep running
      {row.resident && (
        <span className="k on">
          <LuCheck size={14} />
        </span>
      )}
    </div>
  )

  const renderMenu = (): JSX.Element | null => {
    if (!menu) return null
    const { target } = menu
    const style = { left: menu.left, top: menu.top }
    if (target.kind === 'workspace') {
      const newSessionItem = (label: string, backend?: BackendId, key?: string): JSX.Element => {
        const refusal = backend ? unsupportedPairMessage(backend, hostOf(target.wsPath)) : undefined
        return (
          <div
            className={'mi' + (refusal ? ' disabled' : '')}
            title={refusal}
            onClick={() => {
              if (refusal) return
              setMenu(null)
              onNewSession(target.wsPath, backend)
            }}
          >
            {label}
            {key && <span className="k">{key}</span>}
          </div>
        )
      }
      const hasHistory = rows.some(
        (r) => r.workspace.path === target.wsPath && r.workspace.hasHistory
      )
      return (
        <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
          {!target.missing && (
            <>
              {namedMethods
                ? newSessionItem(
                    `New ${BACKEND_LABEL[namedMethods[0]]} session`,
                    namedMethods[0],
                    '⌘N'
                  )
                : newSessionItem('New session', undefined, '⌘N')}
              {namedMethods &&
                newSessionItem(`New ${BACKEND_LABEL[namedMethods[1]]} session`, namedMethods[1])}
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
              <div
                className={'mi' + (hasHistory ? '' : ' disabled')}
                onClick={() => {
                  setMenu(null)
                  onRestoreSession(target.wsPath)
                }}
              >
                Restore session…
              </div>
              <div
                className="mi"
                onClick={() => {
                  setMenu(null)
                  onScheduledJobs(target.wsPath)
                }}
              >
                Scheduled jobs…
              </div>
              {canBind(target.wsPath) && (
                <div
                  className="mi"
                  onClick={() => {
                    setMenu(null)
                    setBindConductor({ scope: target.wsPath })
                  }}
                >
                  Bind Discord channel…
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
          {keepRunningItem(row)}
          <div
            className="mi"
            onClick={() => {
              setMenu(null)
              if (isOrphanRow(row, sessions, storeTabs)) offerForceCloseUnlessMainHasBoundIt(row)
              else requestCloseTab(tabIdFor(row.id) ?? null)
            }}
          >
            Close
          </div>
        </div>
      )
    }
    return (
      <div className="menu" style={style} onMouseEnter={keepMenu} onMouseLeave={scheduleClose}>
        <div className="mi head">{relTime(row.mtime, Date.now())}</div>
        <div className="sep" />
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            openSessionRow(row, target.wsPath)
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
        {keepRunningItem(row)}
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

  const renderParked = (): JSX.Element | null => {
    if (!parkedPop) return null
    const row = rows.flatMap((w) => w.rows).find((r) => r.id === parkedPop.rowId)
    const badge = row ? parkedFor(row) : null
    if (!badge) return null
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
        {(leftovers[parkedPop.rowId] ?? []).map((p) => (
          <button
            key={p.pid}
            className="tbu-act"
            title={p.command}
            onClick={() => void window.api.sessions.stopLeftover(parkedPop.rowId, p.pid)}
          >
            Stop {leftoverLabel(p)}
          </button>
        ))}
      </div>
    )
  }

  const renderFresh = (): JSX.Element | null => {
    if (!fresh) return null
    const w = rows.find((r) => r.workspace.path === fresh.path)
    if (!w) return null
    const f = freshnessShown(w.workspace.freshness) ? w.workspace.freshness : undefined
    if (!f && !w.workspace.github) return null
    return (
      <FreshnessPopover
        key={fresh.path}
        wsPath={fresh.path}
        f={f}
        github={w.workspace.github}
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
          ref={listRef}
          className="ws-list"
          onScroll={closeFloating}
          onDragOver={dragOverWorkspaces}
          onDrop={dropWorkspace}
        >
          {rows.length === 0 && !welcomeActive && (
            <div className="hint">
              No workspaces yet.
              <br />
              Press ⇧⌘O to add a folder — its sessions appear here.
            </div>
          )}

          {rows.map(({ workspace: ws, rows: sessionRows }, wsIndex) => {
            const open = !collapsed[ws.path]
            const wsTarget: MenuTarget = {
              kind: 'workspace',
              wsPath: ws.path,
              missing: ws.missing,
              isGit: ws.isGit
            }
            const badge = behindBadge(ws.freshness, Date.now())
            const gitPanel = freshnessShown(ws.freshness) || !!ws.github
            const nameMq = `ws:${ws.path}`
            const door = ws.isGit
              ? {
                  title: 'New worktree session · ⇧⌘N',
                  label: 'New worktree…',
                  Icon: LuGitBranchPlus
                }
              : { title: 'New session', label: 'New session', Icon: LuPlus }
            const openDoor = (): void => {
              clearTimers()
              setMenu(null)
              if (ws.isGit) onNewWorktreeSession(ws.path)
              else onNewSession(ws.path)
            }
            const callingInside = open ? 0 : callingAmong(sessionRows)
            const cronNow = new Date()
            const soon = ws.missing || !open ? null : forecastFor(cron.jobs, ws.path, cronNow)
            const sessionRow = (node: RowNode<SessionRow>): JSX.Element => {
              const { row } = node
              const tabId = tabIdOfRow(row)
              const calling = attentionOnRow(row.id, tabId, attention)
              const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
              const stateCls = statusUnavailable(sess)
                ? ''
                : rowStateClass(row.running, sess?.status, row.pending, sess?.turnOver)
              const badge = sessionActivityBadge(sess, leftovers[row.id])
              const launching = resumeLaunch?.id === row.id
              const active = launching || (!resumeLaunch && !!tabId && tabId === activeTabId)
              const resumingNow =
                !row.running &&
                !row.pending &&
                (launching || storeTabs.some((t) => t.sessionId === row.id && t.alive))
              const shownCls = resumingNow ? rowStateClass(false, undefined, true) : stateCls
              const rowTarget: MenuTarget = {
                kind: 'session',
                wsPath: ws.path,
                row
              }
              const isCronRow =
                capabilitiesFor(row.backendId, row.host).scheduledTasks === true &&
                (cron.live.some((l) => (!!tabId && l.tabId === tabId) || l.sessionId === row.id) ||
                  (row.worktree !== 'main' &&
                    cron.jobs.some(
                      (j) =>
                        j.workspacePath === ws.path && row.worktree.startsWith(slugOf(j.name) + '-')
                    )))
              const folded = node.children.length > 0 && !!foldedRows[row.id]
              const hidden = folded ? rowsUnder(node) : []
              const callingHidden = callingAmong(hidden)
              return (
                <Fragment key={row.id}>
                  <div
                    className={'ws-tab ' + shownCls + (active ? ' active' : '')}
                    data-tab-id={tabId}
                    title={
                      row.running || row.pending
                        ? undefined
                        : relTime(row.mtime, Date.now()) +
                          (row.invalidCwd
                            ? ' — worktree deleted; click to rebuild and resume'
                            : ' — click to resume')
                    }
                    onClick={() => openSessionRow(row, ws.path)}
                    onContextMenu={(e) => openMenuNow(e, rowTarget)}
                    onMouseEnter={(e) => {
                      armHoverMenu(e, rowTarget)
                      marqueeIfClipped(e.currentTarget, '.ws-tab-title', row.id)
                    }}
                    onMouseLeave={() => {
                      scheduleClose()
                      stopMarquee(row.id)
                    }}
                  >
                    <div className="ws-tab-main">
                      {isCronRow && (
                        <span className="ws-tab-cron" title="started by a scheduled job">
                          <LuAlarmClock size={12} />
                        </span>
                      )}
                      {row.resident && (
                        <span
                          className="ws-tab-resident"
                          title="Keep running — starts again each time Koloft opens"
                        >
                          <LuPin size={12} />
                        </span>
                      )}
                      <span className={'ws-tab-title' + (mq?.id === row.id ? ' mq' : '')}>
                        <i ref={mq?.id === row.id ? mqRef : undefined}>
                          {shownTitle(row.title, sess?.title)}
                        </i>
                      </span>
                      {tabId && <UnseenFileMark tabId={tabId} />}
                      {calling && (
                        <span className="ws-tab-unread" title={ATTENTION_REASON[calling.kind]} />
                      )}
                      {badge && (
                        <button
                          className={'ws-tab-parked' + (badge.running ? ' bg-run' : '')}
                          title={badge.lines.join('\n')}
                          aria-label={badge.heading}
                          onClick={(e) => {
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
                      {callingHidden > 0 && (
                        <span
                          className="ws-tab-parked ws-unread-count"
                          title={sessionsNeedYou(callingHidden)}
                        >
                          {callingHidden}
                        </span>
                      )}
                      {folded && (
                        <span className="ws-tab-parked" title={sessionsInside(hidden.length)}>
                          {hidden.length}
                        </span>
                      )}
                      {node.children.length > 0 && (
                        <button
                          className="icobtn ws-tab-fold"
                          title={folded ? 'Unfold' : 'Fold'}
                          aria-label={folded ? 'Unfold' : 'Fold'}
                          onClick={(e) => {
                            e.stopPropagation()
                            setFoldedRows((f) => ({ ...f, [row.id]: !f[row.id] }))
                          }}
                        >
                          {folded ? <LuChevronRight size={12} /> : <LuChevronDown size={12} />}
                        </button>
                      )}
                    </div>
                    <div className="ws-tab-sub">
                      {mixesBackends(sessionRows) && <SessionBackendIcon backend={row.backendId} />}
                      <span>{row.worktree}</span>
                    </div>
                  </div>
                  {node.children.length > 0 && !folded && (
                    <div className="ws-subtabs">{node.children.map(sessionRow)}</div>
                  )}
                </Fragment>
              )
            }
            return (
              <div
                className={
                  'ws' +
                  (drag?.path === ws.path ? ' dragging' : '') +
                  (drag?.over === wsIndex ? ' dropbefore' : '') +
                  (drag?.over === rows.length && wsIndex === rows.length - 1 ? ' dropafter' : '')
                }
                key={ws.path}
                data-ws-path={ws.path}
              >
                <div
                  className={
                    'ws-head' +
                    (ws.missing ? ' missing' : '') +
                    (selectedWs === ws.path && activeTabId === null ? ' active' : '')
                  }
                  title={ws.missing ? 'folder deleted' : ws.path}
                  draggable
                  onDragStart={(e) => startWorkspaceDrag(e, ws.path)}
                  onDragEnd={() => setDrag(null)}
                  onClick={() => {
                    if (ws.missing) return
                    selectWorkspace(ws.path)
                  }}
                  onContextMenu={(e) => openMenuNow(e, wsTarget)}
                  onMouseEnter={(e) => {
                    armHoverMenu(e, wsTarget)
                    marqueeIfClipped(e.currentTarget, '.ws-name', nameMq)
                  }}
                  onMouseLeave={() => {
                    scheduleClose()
                    stopMarquee(nameMq)
                  }}
                >
                  <span
                    className="fico"
                    title={open ? 'Fold' : 'Unfold'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCollapsed((c) => ({ ...c, [ws.path]: !c[ws.path] }))
                    }}
                  >
                    {open ? <LuFolderOpen size={15} /> : <LuFolder size={15} />}
                  </span>
                  <span className={'ws-name' + (mq?.id === nameMq ? ' mq' : '')}>
                    <i ref={mq?.id === nameMq ? mqRef : undefined}>{workspaceName(ws)}</i>
                  </span>
                  {ws.remote && (
                    <span
                      className="ws-remote"
                      title={remoteCopyText(ws.remote.host, ws.remote.path)}
                    >
                      {ws.remote.host}
                      <span
                        className={'ws-conn' + (ws.remote.connected ? ' on' : '')}
                        title={remoteDotTitle(ws.remote)}
                      />
                    </span>
                  )}
                  {ws.isGit && !ws.missing && (
                    <span
                      className="ws-git"
                      title={gitPanel ? NO_INHERITED_TOOLTIP : 'git repository'}
                      onMouseEnter={
                        gitPanel
                          ? (e) => openCard(e.currentTarget as HTMLElement, ws.path)
                          : undefined
                      }
                      onMouseLeave={
                        gitPanel
                          ? (e) => {
                              leaveCard()
                              const head = (e.currentTarget as HTMLElement).closest('.ws-head')
                              armMenu(e, head as HTMLElement, wsTarget)
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
                            e.stopPropagation()
                            openCard((e.currentTarget as HTMLElement).parentElement!, ws.path)
                          }}
                        >
                          {badge.label}
                        </button>
                      )}
                      {ws.github && (ws.github.issues > 0 || ws.github.prs > 0) && (
                        <span className="ws-gh">
                          {ws.github.issues > 0 && (
                            <span aria-label={openIssuesLabel(ws.github.issues)}>
                              <GoIssueOpened size={12} />
                              {countLabel(ws.github.issues)}
                            </span>
                          )}
                          {ws.github.prs > 0 && (
                            <span aria-label={openPullsLabel(ws.github.prs)}>
                              <GoGitPullRequest size={12} />
                              {countLabel(ws.github.prs)}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  )}
                  {callingInside > 0 && (
                    <span
                      className="ws-tab-parked ws-unread-count"
                      title={sessionsNeedYou(callingInside)}
                    >
                      {callingInside}
                    </span>
                  )}
                  {!ws.missing && (
                    <button
                      className="hact"
                      title={door.title}
                      aria-label={door.title}
                      onClick={(e) => {
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
                    {soon && (
                      <div
                        className="ws-next"
                        title={soon.title}
                        onClick={(e) => {
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
                    {sessionTree(sessionRows).map(sessionRow)}
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

      {/* ADR-0013 */}
      {createPortal(
        <>
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
                        const { path: p, dirty } = confirmRemove
                        setRemoving(true)
                        void saveAll(dirty).then((ok) => {
                          setRemoving(false)
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
                    This session is running but its tab could not be re-adopted. Force close it to
                    make the row resumable — its in-flight work will stop.
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
        </>,
        document.body
      )}
    </>
  )
}

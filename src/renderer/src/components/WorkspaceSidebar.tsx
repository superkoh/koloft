import { BACKEND_LABEL, capabilitiesFor, identityOf } from '@shared/sessionBackend'
import { SessionBackendIcon } from './SessionBackendIcon'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type MouseEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconAssist,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconIssue,
  IconNewWorktree,
  IconPin,
  IconPlus,
  IconPullRequest,
  IconScheduled
} from '../icons'
import type { BackendId, SessionRow } from '@shared/types'
import type { DirtyTab } from '../unsavedGuard'
import { attentionReason } from '@shared/types'
import { popoverX } from '@shared/accountUsage'
import { slugOf } from '@shared/cronNames'
import { describeWhen } from '@shared/schedule'
import { forecastFor } from '../cronForm'
import { useStore } from '../store'
import {
  isOrphanRow,
  liveTabOf,
  marqueeAnim,
  mixesBackends,
  sessionActivityBadge,
  leftoverLabel,
  relTime,
  rowLookups,
  rowStateClass,
  rowsUnder,
  sessionsInside,
  sessionsNeedYou,
  sessionTree,
  shownTitle,
  statusUnavailable,
  workspaceName,
  type RowNode
} from '../sessionRows'
import { releaseSettledResumes } from '../resumeFlow'
import { offerForceCloseUnlessMainHasBoundIt, openSessionRow } from '../sessionClick'
import { requestCloseTab } from '../closeFlow'
import { freshnessShown } from '@shared/freshnessOps'
import { behindBadge, countLabel, openIssuesLabel, openPullsLabel } from '../freshnessView'
import { fitGithubCounts } from '../wsHeadFit'
import { rowSelector } from '../hints'
import { FreshnessPopover } from './FreshnessPopover'
import { basename } from '@shared/preview'
import { parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { remoteDotTitle, workspaceMenuCount } from '../remoteWorkspace'
import { ButlerRow } from './ButlerRow'
import {
  discardAll,
  dirtyInWorkspace,
  labelPaths,
  removeJobsNote,
  removePlan,
  removeUnsavedNote,
  saveAll
} from '../unsavedGuard'
import '../workspaceSidebar.css'

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

const DROP_GAP = 4

export function dropPosFor(
  el: HTMLElement,
  itemCount: number,
  itemH: number,
  width: number
): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  const estH = itemCount * itemH + MENU_PAD_H
  const below = r.bottom + DROP_GAP
  return {
    left: Math.max(4, r.right - width),
    top: below + estH <= window.innerHeight - 4 ? below : Math.max(4, r.top - DROP_GAP - estH)
  }
}

function cardPosFor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  return {
    left: popoverX(r.left + r.width / 2, FRESH_POP_W, window.innerWidth),
    top: r.bottom + 6
  }
}

const doorFor = (isGit: boolean): { title: string; label: string; Icon: typeof IconPlus } =>
  isGit
    ? { title: 'New worktree session · ⇧⌘N', label: 'New worktree…', Icon: IconNewWorktree }
    : { title: 'New session', label: 'New session', Icon: IconPlus }

function UnseenFileMark({ tabId }: { tabId: string }): JSX.Element | null {
  const src = useStore((s) => (s.openFiles[tabId]?.unseen ? s.openFiles[tabId]?.src : undefined))
  if (!src) return null
  return (
    <span
      className="ws-tab-opened"
      title={`${basename(src)} was opened here — select this session to see it`}
    >
      <IconFile size={12} />
    </span>
  )
}

function useMarquee(): {
  on: boolean
  box: RefObject<HTMLSpanElement | null>
  text: RefObject<HTMLElement | null>
  start: () => void
  stop: () => void
} {
  const [overflow, setOverflow] = useState(0)
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = text.current
    if (!overflow || !el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const spec = marqueeAnim(overflow)
    if (!spec) return
    const anim = el.animate(spec.frames, spec.timing)
    return () => anim.cancel()
  }, [overflow])
  const start = (): void => {
    const t = box.current
    const clipped = t ? t.scrollWidth - t.clientWidth : 0
    if (clipped > 0) setOverflow(clipped)
  }
  return { on: overflow > 0, box, text, start, stop: () => setOverflow(0) }
}

interface SidebarActions {
  openRow: (id: string) => void
  rowMenu: (e: MouseEvent, id: string) => void
  rowEnter: (e: MouseEvent, id: string) => void
  leave: () => void
  openParked: (e: MouseEvent, id: string) => void
  toggleFold: (id: string) => void
  selectWs: (path: string) => void
  toggleCollapsed: (path: string) => void
  headMenu: (e: MouseEvent, path: string) => void
  headEnter: (e: MouseEvent, path: string) => void
  dragStart: (e: DragEvent<HTMLElement>, path: string) => void
  dragEnd: () => void
  gitEnter: (e: MouseEvent, path: string) => void
  gitLeave: (e: MouseEvent, path: string) => void
  behindClick: (e: MouseEvent, path: string) => void
  openDoor: (path: string, isGit: boolean) => void
}

const SessionRowView = memo(function SessionRowView({
  id,
  className,
  tabId,
  tooltip,
  cron,
  resident,
  title,
  callingReason,
  badgeText,
  badgeLines,
  badgeHeading,
  badgeRunning,
  callingHidden,
  hiddenCount,
  parent,
  folded,
  backend,
  startedBy,
  worktree,
  actions
}: {
  id: string
  className: string
  tabId: string | undefined
  tooltip: string | undefined
  cron: boolean
  resident: boolean
  title: string
  callingReason: string | undefined
  badgeText: string | undefined
  badgeLines: string | undefined
  badgeHeading: string | undefined
  badgeRunning: boolean
  callingHidden: number
  hiddenCount: number
  parent: boolean
  folded: boolean
  backend: BackendId | undefined
  startedBy: string | undefined
  worktree: string
  actions: SidebarActions
}): JSX.Element {
  const mq = useMarquee()
  return (
    <div
      className={className}
      data-tab-id={tabId}
      title={tooltip}
      onClick={() => actions.openRow(id)}
      onContextMenu={(e) => actions.rowMenu(e, id)}
      onMouseEnter={(e) => {
        actions.rowEnter(e, id)
        mq.start()
      }}
      onMouseLeave={() => {
        actions.leave()
        mq.stop()
      }}
    >
      <div className="ws-tab-main">
        {cron && (
          <span className="ws-tab-cron" title="started by a scheduled job">
            <IconScheduled size={12} />
          </span>
        )}
        {resident && (
          <span
            className="ws-tab-resident"
            title="Keep running — never sleeps, and starts again each time Koloft opens"
          >
            <IconPin size={12} />
          </span>
        )}
        <span ref={mq.box} className={'ws-tab-title' + (mq.on ? ' mq' : '')}>
          <i ref={mq.text}>{title}</i>
        </span>
        {tabId && <UnseenFileMark tabId={tabId} />}
        {callingReason !== undefined && <span className="ws-tab-unread" title={callingReason} />}
        {badgeText !== undefined && (
          <button
            className={'ws-tab-parked' + (badgeRunning ? ' bg-run' : '')}
            title={badgeLines}
            aria-label={badgeHeading}
            onClick={(e) => actions.openParked(e, id)}
          >
            {badgeText}
          </button>
        )}
        {callingHidden > 0 && (
          <span className="ws-tab-parked ws-unread-count" title={sessionsNeedYou(callingHidden)}>
            {callingHidden}
          </span>
        )}
        {folded && (
          <span className="ws-tab-parked" title={sessionsInside(hiddenCount)}>
            {hiddenCount}
          </span>
        )}
        {parent && (
          <button
            className="icobtn ws-tab-fold"
            title={folded ? 'Unfold' : 'Fold'}
            aria-label={folded ? 'Unfold' : 'Fold'}
            onClick={(e) => {
              e.stopPropagation()
              actions.toggleFold(id)
            }}
          >
            {folded ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </button>
        )}
      </div>
      <div className="ws-tab-sub">
        {startedBy && (
          <span className="session-backend-icon" title={`started by ${startedBy}`}>
            <IconAssist size={12} />
          </span>
        )}
        {backend && <SessionBackendIcon backend={backend} />}
        <span>{worktree}</span>
      </div>
    </div>
  )
})

const WorkspaceHead = memo(function WorkspaceHead({
  path,
  name,
  missing,
  isGit,
  remoteHost,
  remoteTitle,
  remoteConnected,
  remoteDot,
  gitPanel,
  issues,
  prs,
  open,
  active,
  callingInside,
  behindCls,
  behindLabel,
  behindName,
  actions
}: {
  path: string
  name: string
  missing: boolean
  isGit: boolean
  remoteHost: string | undefined
  remoteTitle: string | undefined
  remoteConnected: boolean
  remoteDot: string | undefined
  gitPanel: boolean
  issues: number
  prs: number
  open: boolean
  active: boolean
  callingInside: number
  behindCls: string | undefined
  behindLabel: string | undefined
  behindName: string | undefined
  actions: SidebarActions
}): JSX.Element {
  const mq = useMarquee()
  const door = doorFor(isGit)
  return (
    <div
      className={'ws-head' + (missing ? ' missing' : '') + (active ? ' active' : '')}
      title={missing ? 'folder deleted' : path}
      draggable
      onDragStart={(e) => actions.dragStart(e, path)}
      onDragEnd={actions.dragEnd}
      onClick={() => {
        if (missing) return
        actions.selectWs(path)
      }}
      onContextMenu={(e) => actions.headMenu(e, path)}
      onMouseEnter={(e) => {
        actions.headEnter(e, path)
        mq.start()
      }}
      onMouseLeave={() => {
        actions.leave()
        mq.stop()
      }}
    >
      <span
        className="fico"
        title={open ? 'Fold' : 'Unfold'}
        onClick={(e) => {
          e.stopPropagation()
          actions.toggleCollapsed(path)
        }}
      >
        {open ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
      </span>
      <span ref={mq.box} className={'ws-name' + (mq.on ? ' mq' : '')}>
        <i ref={mq.text}>{name}</i>
      </span>
      {remoteHost !== undefined && (
        <span className="ws-remote" title={remoteTitle}>
          {remoteHost}
          <span className={'ws-conn' + (remoteConnected ? ' on' : '')} title={remoteDot} />
        </span>
      )}
      {isGit && !missing && (
        <span
          className="ws-git"
          title={gitPanel ? NO_INHERITED_TOOLTIP : 'git repository'}
          onMouseEnter={gitPanel ? (e) => actions.gitEnter(e, path) : undefined}
          onMouseLeave={gitPanel ? (e) => actions.gitLeave(e, path) : undefined}
        >
          <IconBranch size={12} />
          {behindCls !== undefined && (
            <button
              className={behindCls}
              aria-label={behindName}
              onClick={(e) => actions.behindClick(e, path)}
            >
              {behindLabel}
            </button>
          )}
          {(issues > 0 || prs > 0) && (
            <span className="ws-gh">
              {issues > 0 && (
                <span aria-label={openIssuesLabel(issues)}>
                  <IconIssue size={12} />
                  {countLabel(issues)}
                </span>
              )}
              {prs > 0 && (
                <span aria-label={openPullsLabel(prs)}>
                  <IconPullRequest size={12} />
                  {countLabel(prs)}
                </span>
              )}
            </span>
          )}
        </span>
      )}
      {callingInside > 0 && (
        <span className="ws-tab-parked ws-unread-count" title={sessionsNeedYou(callingInside)}>
          {callingInside}
        </span>
      )}
      {!missing && (
        <button
          className="hact"
          title={door.title}
          aria-label={door.title}
          onClick={(e) => {
            e.stopPropagation()
            actions.openDoor(path, isGit)
          }}
        >
          <door.Icon size={16} />
        </button>
      )}
    </div>
  )
})

interface FloatingCtl {
  armMenu: (e: MouseEvent, el: HTMLElement, target: MenuTarget) => void
  hoverMenu: (e: MouseEvent, target: MenuTarget) => void
  menuNow: (e: MouseEvent, target: MenuTarget) => void
  scheduleClose: () => void
  dismissMenu: () => void
  openCard: (el: HTMLElement, path: string) => void
  leaveCard: () => void
  openParked: (el: HTMLElement, rowId: string) => void
  closeAll: () => void
}

function SidebarFloating({
  ctl,
  namedMethods,
  onNewSession,
  onNewWorktreeSession,
  onRestoreSession,
  onScheduledJobs,
  onRemoveWorkspace
}: {
  ctl: RefObject<FloatingCtl | null>
  namedMethods: BackendId[] | null
  onNewSession: (wsPath: string, backend?: BackendId) => void
  onNewWorktreeSession: (wsPath: string) => void
  onRestoreSession: (wsPath: string) => void
  onScheduledJobs: (wsPath: string, jobId?: string) => void
  onRemoveWorkspace: (wsPath: string) => void
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const sessions = useStore((s) => s.sessions)
  const leftovers = useStore((s) => s.leftovers)
  const storeTabs = useStore((s) => s.tabs)
  const sidebarHidden = useStore((s) => s.settings.sidebarHidden)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [fresh, setFresh] = useState<{ path: string; left: number; top: number } | null>(null)
  const [parkedPop, setParkedPop] = useState<{ rowId: string; left: number; top: number } | null>(
    null
  )
  const freshBusy = useRef(false)
  const setFreshBusy = useCallback((busy: boolean) => {
    freshBusy.current = busy
  }, [])
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    hoverTimer.current = null
    leaveTimer.current = null
  }

  const closeAll = (): void => {
    clearTimers()
    setMenu(null)
    setParkedPop(null)
    if (!freshBusy.current) setFresh(null)
  }
  useEffect(() => {
    if (sidebarHidden) closeAll()
  }, [sidebarHidden])

  useDismissOnOutside(!!menu, setMenu)
  useDismissOnOutside(!!parkedPop, setParkedPop)

  const tabIdFor = (sessionId: string): string | undefined =>
    liveTabOf(sessionId, sessions, storeTabs)

  const parkedFor = (row: SessionRow): ReturnType<typeof sessionActivityBadge> => {
    const tabId = row.running ? tabIdFor(row.id) : undefined
    const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
    return sessionActivityBadge(sess, leftovers[row.id])
  }

  const menuItemCount = (t: MenuTarget): number =>
    t.kind === 'workspace'
      ? workspaceMenuCount({ missing: t.missing, isGit: t.isGit })
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

  useImperativeHandle(ctl, () => ({
    armMenu,
    hoverMenu: (e, target) => {
      clearTimers()
      armMenu(e, e.currentTarget as HTMLElement, target)
    },
    menuNow: (e, target) => {
      e.preventDefault()
      e.stopPropagation()
      clearTimers()
      openMenuAt(e.currentTarget as HTMLElement, target)
    },
    scheduleClose,
    dismissMenu: () => {
      clearTimers()
      setMenu(null)
    },
    openCard,
    leaveCard,
    openParked: (el, rowId) => {
      clearTimers()
      setMenu(null)
      setParkedPop({ rowId, ...cardPosFor(el) })
    },
    closeAll
  }))

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
          <IconCheck size={14} />
        </span>
      )}
    </div>
  )

  const renderMenu = (): JSX.Element | null => {
    if (!menu) return null
    const { target } = menu
    const style = { left: menu.left, top: menu.top }
    if (target.kind === 'workspace') {
      const newSessionItem = (label: string, backend?: BackendId, key?: string): JSX.Element => (
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            onNewSession(target.wsPath, backend)
          }}
        >
          {label}
          {key && <span className="k">{key}</span>}
        </div>
      )
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
              {namedMethods?.slice(1).map((other) => (
                <Fragment key={other}>
                  {newSessionItem(`New ${BACKEND_LABEL[other]} session`, other)}
                </Fragment>
              ))}
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
              <div className="sep" />
            </>
          )}
          <div
            className="mi danger"
            onClick={() => {
              setMenu(null)
              onRemoveWorkspace(target.wsPath)
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
    if (!f && !w.workspace.github && !w.workspace.gitPickable) return null
    return (
      <FreshnessPopover
        key={fresh.path}
        wsPath={fresh.path}
        f={f}
        github={w.workspace.github}
        remote={w.workspace.remote}
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
      {renderMenu()}
      {renderFresh()}
      {renderParked()}
    </>
  )
}

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  onNewSession,
  namedMethods,
  onNewWorktreeSession,
  onRestoreSession,
  onScheduledJobs
}: {
  onNewSession: (wsPath: string, backend?: BackendId) => void
  namedMethods: BackendId[] | null
  onNewWorktreeSession: (wsPath: string) => void
  onRestoreSession: (wsPath: string) => void
  onScheduledJobs: (wsPath: string, jobId?: string) => void
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const welcomeActive = useStore((s) => s.welcomeActive)
  const butlerName = useStore((s) => s.settings.butler.name)
  const butlerWorkspace = useStore((s) => s.butlerWorkspace)
  const butlerKeys = useStore((s) => s.settings.assistSessions[0]?.sessionIds)
  const cron = useStore((s) => s.cron)
  const sessions = useStore((s) => s.sessions)
  const leftovers = useStore((s) => s.leftovers)
  const attention = useStore((s) => s.attention)
  const storeTabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const resumeLaunch = useStore((s) => s.resumeLaunch)
  const selectedWs = useStore((s) => s.selectedWs)
  const showToast = useStore((s) => s.showToast)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [foldedRows, setFoldedRows] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<{ path: string; over: number | null } | null>(null)
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
  const floating = useRef<FloatingCtl | null>(null)
  const [, bumpCronClock] = useState(0)

  const hasCronJobs = cron.jobs.length > 0
  useEffect(() => {
    if (!hasCronJobs) return
    const t = setInterval(() => bumpCronClock((n) => n + 1), CRON_BADGE_MS)
    return () => clearInterval(t)
  }, [hasCronJobs])

  useEffect(() => {
    if (confirmRemove && confirmRemove.dirty.length > 0) removeCancelRef.current?.focus()
  }, [confirmRemove])

  useEffect(() => {
    const cold = new Set<string>()
    for (const w of rows) for (const r of w.rows) if (!r.running) cold.add(r.id)
    releaseSettledResumes(cold)
  }, [rows])

  const listRef = useRef<HTMLDivElement>(null)
  const fitHeads = useCallback((): void => {
    const list = listRef.current
    if (list) fitGithubCounts(list.querySelectorAll<HTMLElement>('.ws-head'))
  }, [])
  useLayoutEffect(fitHeads, [rows, fitHeads])
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(fitHeads)
    ro.observe(list)
    return () => ro.disconnect()
  }, [fitHeads])

  const reveal = useStore((s) => s.revealRow)
  useLayoutEffect(() => {
    if (!reveal) return
    const st = useStore.getState()
    const lookNow = rowLookups(st.sessions, st.tabs, st.attention)
    for (const w of [...st.workspaceRows, ...(st.butlerWorkspace ? [st.butlerWorkspace] : [])]) {
      const row = w.rows.find((r) => lookNow.tabOf(r) === reveal.tabId)
      if (!row) continue
      setCollapsed((c) => (c[w.workspace.path] ? { ...c, [w.workspace.path]: false } : c))
      const byId = new Map(w.rows.map((r) => [r.id, r]))
      setFoldedRows((f) => {
        let next = f
        const seen = new Set<string>()
        for (let at = row.parentId; at && !seen.has(at); at = byId.get(at)?.parentId) {
          seen.add(at)
          if (next[at]) next = { ...next, [at]: false }
        }
        return next
      })
      const frame = requestAnimationFrame(() =>
        listRef.current
          ?.querySelector(rowSelector(reveal.tabId))
          ?.scrollIntoView({ block: 'nearest' })
      )
      return () => cancelAnimationFrame(frame)
    }
  }, [reveal])

  const now = new Date()
  const look = rowLookups(sessions, storeTabs, attention)
  const callingAmong = (list: SessionRow[]): number =>
    list.filter((r) => look.attentionOn(r.id, look.tabOf(r))).length
  const cronLiveTabs = new Set(cron.live.map((l) => l.tabId))
  const cronLiveSessions = new Set(cron.live.map((l) => l.sessionId))
  const cronWorktreePrefixes = new Map<string, string[]>()
  for (const j of cron.jobs) {
    const list = cronWorktreePrefixes.get(j.workspacePath) ?? []
    list.push(slugOf(j.name) + '-')
    cronWorktreePrefixes.set(j.workspacePath, list)
  }
  const live = useRef({ onNewSession, onNewWorktreeSession })
  live.current = { onNewSession, onNewWorktreeSession }

  const actions = useMemo<SidebarActions>(() => {
    const rowTarget = (id: string): Extract<MenuTarget, { kind: 'session' }> => {
      const { workspaceRows, butlerWorkspace } = useStore.getState()
      const w = [...workspaceRows, ...(butlerWorkspace ? [butlerWorkspace] : [])].find((w) =>
        w.rows.some((r) => r.id === id)
      )!
      return { kind: 'session', wsPath: w.workspace.path, row: w.rows.find((r) => r.id === id)! }
    }
    const wsTarget = (path: string): MenuTarget => {
      const ws = useStore.getState().workspaceRows.find((w) => w.workspace.path === path)!.workspace
      return { kind: 'workspace', wsPath: path, missing: ws.missing, isGit: ws.isGit }
    }
    return {
      openRow: (id) => {
        floating.current?.dismissMenu()
        const { row, wsPath } = rowTarget(id)
        openSessionRow(row, wsPath)
      },
      rowMenu: (e, id) => floating.current?.menuNow(e, rowTarget(id)),
      rowEnter: (e, id) => floating.current?.hoverMenu(e, rowTarget(id)),
      leave: () => floating.current?.scheduleClose(),
      openParked: (e, id) => {
        e.stopPropagation()
        floating.current?.openParked(e.currentTarget as HTMLElement, id)
      },
      toggleFold: (id) => setFoldedRows((f) => ({ ...f, [id]: !f[id] })),
      selectWs: (path) => useStore.getState().selectWorkspace(path),
      toggleCollapsed: (path) => setCollapsed((c) => ({ ...c, [path]: !c[path] })),
      headMenu: (e, path) => floating.current?.menuNow(e, wsTarget(path)),
      headEnter: (e, path) => floating.current?.hoverMenu(e, wsTarget(path)),
      dragStart: (e, path) => {
        floating.current?.closeAll()
        e.dataTransfer.effectAllowed = 'move'
        // PLATFORM§10
        e.dataTransfer.setData('text/plain', path)
        setDrag({ path, over: null })
      },
      dragEnd: () => setDrag(null),
      gitEnter: (e, path) => floating.current?.openCard(e.currentTarget as HTMLElement, path),
      gitLeave: (e, path) => {
        floating.current?.leaveCard()
        const head = (e.currentTarget as HTMLElement).closest('.ws-head')
        floating.current?.armMenu(e, head as HTMLElement, wsTarget(path))
      },
      behindClick: (e, path) => {
        e.stopPropagation()
        floating.current?.openCard((e.currentTarget as HTMLElement).parentElement!, path)
      },
      openDoor: (path, isGit) => {
        floating.current?.dismissMenu()
        if (isGit) live.current.onNewWorktreeSession(path)
        else live.current.onNewSession(path)
      }
    }
  }, [])

  const wsPaths = rows.map((r) => r.workspace.path)
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

  const rowRenderer = (
    wsPath: string,
    sessionRows: SessionRow[]
  ): ((node: RowNode<SessionRow>) => JSX.Element) => {
    const showBackend = mixesBackends(sessionRows)
    const cronPrefixes = cronWorktreePrefixes.get(wsPath) ?? []
    const sessionRow = (node: RowNode<SessionRow>): JSX.Element => {
      const { row } = node
      const tabId = look.tabOf(row)
      const calling = look.attentionOn(row.id, tabId)
      const sess = tabId ? look.sessionOn(tabId) : undefined
      const stateCls = statusUnavailable(sess)
        ? ''
        : rowStateClass(row.running, sess?.status, row.pending, sess?.turnOver)
      const badge = sessionActivityBadge(sess, leftovers[row.id])
      const launching = resumeLaunch?.id === row.id
      const active = launching || (!resumeLaunch && !!tabId && tabId === activeTabId)
      const resumingNow = !row.running && !row.pending && (launching || look.hasAliveTab(row.id))
      const shownCls = resumingNow ? rowStateClass(false, undefined, true) : stateCls
      const isCronRow =
        capabilitiesFor(row.backendId, row.host).scheduledTasks === true &&
        ((!!tabId && cronLiveTabs.has(tabId)) ||
          cronLiveSessions.has(row.id) ||
          (row.worktree !== 'main' && cronPrefixes.some((p) => row.worktree.startsWith(p))))
      const folded = node.children.length > 0 && !!foldedRows[row.id]
      const hidden = folded ? rowsUnder(node) : []
      return (
        <Fragment key={row.id}>
          <SessionRowView
            id={row.id}
            className={'ws-tab ' + shownCls + (active ? ' active' : '')}
            tabId={tabId}
            tooltip={
              row.running || row.pending
                ? undefined
                : relTime(row.mtime, now.getTime()) +
                  (row.invalidCwd
                    ? ' — worktree deleted; click to rebuild and resume'
                    : ' — click to resume')
            }
            cron={isCronRow}
            resident={!!row.resident}
            title={shownTitle(row.title, sess?.title)}
            callingReason={calling && attentionReason(calling)}
            badgeText={badge?.text}
            badgeLines={badge?.lines.join('\n')}
            badgeHeading={badge?.heading}
            badgeRunning={!!badge?.running}
            callingHidden={callingAmong(hidden)}
            hiddenCount={hidden.length}
            parent={node.children.length > 0}
            folded={folded}
            backend={showBackend ? row.backendId : undefined}
            startedBy={row.parentId && butlerKeys?.includes(row.parentId) ? butlerName : undefined}
            worktree={row.worktree}
            actions={actions}
          />
          {node.children.length > 0 && !folded && (
            <div className="ws-subtabs">{node.children.map(sessionRow)}</div>
          )}
        </Fragment>
      )
    }
    return sessionRow
  }

  return (
    <>
      <div className="island flat isl-sessions">
        <div
          ref={listRef}
          className="ws-list"
          onScroll={() => floating.current?.closeAll()}
          onDragOver={dragOverWorkspaces}
          onDrop={dropWorkspace}
        >
          <ButlerRow>
            {butlerWorkspace &&
              sessionTree(butlerWorkspace.rows).map(
                rowRenderer(butlerWorkspace.workspace.path, butlerWorkspace.rows)
              )}
          </ButlerRow>
          {rows.length === 0 && !welcomeActive && (
            <div className="hint">
              No workspaces yet.
              <br />
              Press ⇧⌘O to add a folder — its sessions appear here.
            </div>
          )}

          {rows.map(({ workspace: ws, rows: sessionRows }, wsIndex) => {
            const open = !collapsed[ws.path]
            const behind = behindBadge(ws.freshness, now.getTime())
            const door = doorFor(ws.isGit)
            const callingInside = open ? 0 : callingAmong(sessionRows)
            const soon = ws.missing || !open ? null : forecastFor(cron.jobs, ws.path, now)
            const sessionRow = rowRenderer(ws.path, sessionRows)
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
                <WorkspaceHead
                  path={ws.path}
                  name={workspaceName(ws)}
                  missing={ws.missing}
                  isGit={ws.isGit}
                  remoteHost={ws.remote?.host}
                  remoteTitle={ws.remote && remoteCopyText(ws.remote.host, ws.remote.path)}
                  remoteConnected={!!ws.remote?.connected}
                  remoteDot={ws.remote && remoteDotTitle(ws.remote)}
                  gitPanel={freshnessShown(ws.freshness) || !!ws.github || !!ws.gitPickable}
                  issues={ws.github?.issues ?? 0}
                  prs={ws.github?.prs ?? 0}
                  open={open}
                  active={selectedWs === ws.path && activeTabId === null}
                  callingInside={callingInside}
                  behindCls={behind?.cls}
                  behindLabel={behind?.label}
                  behindName={behind?.name}
                  actions={actions}
                />

                {open && (soon || sessionRows.length > 0 || !ws.missing) && (
                  <div className="ws-tabs">
                    {soon && (
                      <div
                        className="ws-next"
                        title={soon.title}
                        onClick={(e) => {
                          e.stopPropagation()
                          floating.current?.dismissMenu()
                          onScheduledJobs(ws.path, soon.id)
                        }}
                      >
                        <IconScheduled size={12} className="ws-next-ico" />
                        <span className="ws-next-name">{soon.name}</span>
                        {soon.more > 0 && <span className="ws-next-more">{`+${soon.more}`}</span>}
                        <span className="ws-next-dot">·</span>
                        <span className={'ws-next-at' + (soon.soon ? ' soon' : '')}>
                          {describeWhen(soon.at, now)}
                        </span>
                      </div>
                    )}
                    {sessionTree(sessionRows).map(sessionRow)}
                    {sessionRows.length === 0 && !ws.missing && (
                      <div
                        className="ws-empty"
                        title={door.title}
                        onClick={() => actions.openDoor(ws.path, ws.isGit)}
                      >
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
          <SidebarFloating
            ctl={floating}
            namedMethods={namedMethods}
            onNewSession={onNewSession}
            onNewWorktreeSession={onNewWorktreeSession}
            onRestoreSession={onRestoreSession}
            onScheduledJobs={onScheduledJobs}
            onRemoveWorkspace={(path) => void removeWorkspace(path)}
          />

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
                    <IconClose size={16} />
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
                    <IconClose size={16} />
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
})

import { useEffect, useState, type JSX, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { LuChevronDown, LuChevronUp, LuConciergeBell, LuPlus, LuX } from 'react-icons/lu'
import { channelLabel, conductorName, GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { ATTENTION_REASON, type AssistTaskRow, type SessionInfo } from '@shared/types'
import { useStore } from '../store'
import { rowStateClass } from '../sessionRows'
import { assistScopes, conductorsNeedYou, conductorTab } from '../conductorRows'
import { preferredAssistBackend } from '@shared/sessionBackend'
import { SessionBackendIcon } from './SessionBackendIcon'
import { menuPosFor, useDismissOnOutside } from './WorkspaceSidebar'

export const NOT_ON_DISCORD = 'not on Discord'

export async function openConductor(scope: string, fresh = false): Promise<void> {
  const r = await (fresh
    ? window.api.conductors.startFresh(scope)
    : window.api.conductors.open(scope))
  const st = useStore.getState()
  if (!r.ok) {
    st.showToast(r.error)
    return
  }
  st.setConductorTab(scope, r.tabId)
  window.api.attention.visit(r.tabId)
  st.activateTab(r.tabId)
}

export async function setUpDiscordWithAssist(): Promise<string | null> {
  const r = await window.api.discord.setUpWithAssist()
  if (!r.ok) return r.error
  const st = useStore.getState()
  st.setSettingsOpen(false)
  window.api.attention.visit(r.tabId)
  st.activateTab(r.tabId)
  st.followAgentBrowser(r.tabId)
  return null
}

type MenuTarget = { kind: 'assist'; scope: string } | { kind: 'task'; task: AssistTaskRow }

export function ConductorsIsland(): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const discord = useStore((s) => s.settings.discord)
  const assistSessions = useStore((s) => s.settings.assistSessions)
  const sessionMethods = useStore((s) => s.settings.sessionMethods)
  const folded = useStore((s) => s.settings.conductorsFolded)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const activeTabId = useStore((s) => s.activeTabId)
  const opened = useStore((s) => s.conductorTabs)
  const tasks = useStore((s) => s.assistTasks)
  const setAssistTasks = useStore((s) => s.setAssistTasks)
  const setAssistAsked = useStore((s) => s.setAssistAsked)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const [menu, setMenu] = useState<{ target: MenuTarget; left: number; top: number } | null>(null)
  useDismissOnOutside(!!menu, setMenu)

  useEffect(() => {
    void window.api.conductors.tasks().then(setAssistTasks)
    return window.api.conductors.onTasks(setAssistTasks)
  }, [setAssistTasks])

  const preferred = preferredAssistBackend({ assist, sessionMethods })
  const bindingOf = (scope: string) => discord.bindings.find((b) => b.scope === scope)
  const callingFor = (tabId: string | undefined, keys: readonly string[]) =>
    attention.find(
      (e) => (!!tabId && e.tabId === tabId) || (!!e.sessionId && keys.includes(e.sessionId))
    )
  const taskKeys = new Set(sessions.filter((s) => s.assistTask).map((s) => s.sessionId))
  const rows = assistScopes({ assist, discord, assistSessions }).map((scope) => {
    const tabId = conductorTab(scope, sessions, opened, tabs)
    const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
    const keys = (assistSessions.find((r) => r.scope === scope)?.sessionIds ?? []).filter(
      (key) => !taskKeys.has(key)
    )
    return { scope, binding: bindingOf(scope), tabId, sess, calling: callingFor(tabId, keys) }
  })
  const taskRows = tasks.map((task) => ({
    task,
    sess: sessions.find((s) => s.tabId === task.tabId),
    calling: callingFor(task.tabId, [])
  }))
  const callingCount = [...rows, ...taskRows].filter((r) => r.calling).length
  const greyGlobal = !assist?.on && !bindingOf(GLOBAL_SCOPE)

  const setFolded = (next: boolean): void => {
    const st = useStore.getState()
    st.setSettings({ ...st.settings, conductorsFolded: next })
    void window.api.settings.set({ conductorsFolded: next })
  }

  const openTask = (task: AssistTaskRow): void => {
    window.api.attention.visit(task.tabId)
    useStore.getState().activateTab(task.tabId)
  }

  const item = (label: string, run: () => void, cls = 'mi', key?: string): JSX.Element => (
    <div
      key={label}
      className={cls}
      onClick={() => {
        setMenu(null)
        run()
      }}
    >
      {label}
      {key && <span className="k">{key}</span>}
    </div>
  )

  const menuItems = (target: MenuTarget): JSX.Element[] => {
    if (target.kind === 'task')
      return [
        item('Open', () => openTask(target.task), 'mi', '↩'),
        <div key="sep" className="sep" />,
        item('Close', () => void window.api.conductors.closeTask(target.task.tabId))
      ]
    const { scope } = target
    const binding = bindingOf(scope)
    const open = item('Open', () => void openConductor(scope), 'mi', '↩')
    const fresh = item('Start a fresh Assist', () => void openConductor(scope, true))
    if (!binding)
      return [open, item('Bind Discord channel…', () => setBindConductor({ scope })), fresh]
    return [
      open,
      item('Change channel…', () => setBindConductor({ editId: binding.id })),
      fresh,
      <div key="sep" className="sep" />,
      item(
        'Unbind Discord channel',
        () => void window.api.conductors.unbind(binding.id),
        'mi danger'
      )
    ]
  }

  const showMenu = (e: MouseEvent<HTMLElement>, target: MenuTarget): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ target, ...menuPosFor(e.currentTarget, menuItems(target).length) })
  }

  const stateClass = (tabId: string | undefined, sess: SessionInfo | undefined): string =>
    rowStateClass(!!tabId, sess?.status, !!tabId && !sess, sess?.turnOver) +
    (tabId && tabId === activeTabId ? ' active' : '')

  return (
    <>
      <div className="gutter-h idle" style={{ height: 10 }} />
      <div className="island isl-notes isl-conductors">
        <div className="wb-bar">
          <span className="wb-title" title="Assist">
            <span className="ic">
              <LuConciergeBell size={14} />
            </span>
            <span className="nm">Assist</span>
          </span>
          {folded && callingCount > 0 && (
            <span className="ws-tab-parked ws-unread-count" title={conductorsNeedYou(callingCount)}>
              {callingCount}
            </span>
          )}
          <button
            className="icobtn"
            title="Bind Discord channel…"
            aria-label="Bind Discord channel…"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setBindConductor({})}
          >
            <LuPlus size={14} />
          </button>
          <button
            className="icobtn"
            title={folded ? 'Unfold' : 'Fold'}
            aria-label={folded ? 'Unfold' : 'Fold'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFolded(!folded)}
          >
            {folded ? <LuChevronUp size={14} /> : <LuChevronDown size={14} />}
          </button>
        </div>
        {!folded && (
          <div className="notes-body">
            <div className="ws-list">
              {rows.map(({ scope, binding, tabId, sess, calling }) =>
                scope === GLOBAL_SCOPE && greyGlobal ? (
                  <div key={scope} className="ws-tab cold" onClick={() => setAssistAsked(true)}>
                    <div className="ws-tab-main">
                      <span className="ws-tab-title">
                        <i>Assist</i>
                      </span>
                    </div>
                    <div className="ws-tab-sub">
                      <span>
                        {assist ? 'Off — click to turn on' : 'Not set up — click to start'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div
                    key={scope}
                    className={'ws-tab ' + stateClass(tabId, sess)}
                    data-tab-id={tabId}
                    onClick={() => void openConductor(scope)}
                    onContextMenu={(e) => showMenu(e, { kind: 'assist', scope })}
                  >
                    <div className="ws-tab-main">
                      <span className="ws-tab-title">
                        <i>{scopeName(scope)}</i>
                      </span>
                      {calling && (
                        <span className="ws-tab-unread" title={ATTENTION_REASON[calling.kind]} />
                      )}
                    </div>
                    <div className="ws-tab-sub">
                      <SessionBackendIcon backend={sess?.backendId ?? preferred} />
                      <span>{binding ? channelLabel(binding) : NOT_ON_DISCORD}</span>
                    </div>
                  </div>
                )
              )}
              {taskRows.map(({ task, sess, calling }) => (
                <div
                  key={task.tabId}
                  className={'ws-tab ' + stateClass(task.tabId, sess)}
                  data-tab-id={task.tabId}
                  onClick={() => openTask(task)}
                  onContextMenu={(e) => showMenu(e, { kind: 'task', task })}
                >
                  <div className="ws-tab-main">
                    <span className="ws-tab-title">
                      <i>{task.name}</i>
                    </span>
                    {calling && (
                      <span className="ws-tab-unread" title={ATTENTION_REASON[calling.kind]} />
                    )}
                    <button
                      className="icobtn ws-tab-fold"
                      title="Close"
                      aria-label="Close"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.api.conductors.closeTask(task.tabId)
                      }}
                    >
                      <LuX size={12} />
                    </button>
                  </div>
                  <div className="ws-tab-sub">
                    <SessionBackendIcon backend={sess?.backendId ?? preferred} />
                    <span>{`${conductorName(task.scope)} task`}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* ADR-0013 */}
      {createPortal(
        menu && (
          <div className="menu" style={{ left: menu.left, top: menu.top }}>
            {menuItems(menu.target)}
          </div>
        ),
        document.body
      )}
    </>
  )
}

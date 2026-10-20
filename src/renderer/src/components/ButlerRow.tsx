import { useEffect, useState, type JSX, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconAssist, IconClose } from '../icons'
import { butlerName, butlerTitle, channelLabel, renamedButler } from '@shared/conductors'
import { ATTENTION_REASON, type AssistTaskRow, type SessionInfo } from '@shared/types'
import { preferredAssistBackend } from '@shared/sessionBackend'
import { useStore } from '../store'
import { rowStateClass } from '../sessionRows'
import { butlerSetUp, butlerTabOf } from '../butlerRows'
import { visitTab } from '../sessionClick'
import { SessionBackendIcon } from './SessionBackendIcon'
import { updateSettings } from './settings/useSettingsUpdate'
import { menuPosFor, useDismissOnOutside } from './WorkspaceSidebar'

const NOT_ON_DISCORD = 'not on Discord'

export async function openButler(fresh = false): Promise<void> {
  const error = await useStore.getState().openButler(fresh)
  if (error) useStore.getState().showToast(error)
}

export async function setUpDiscordWithButler(ownerWords?: string): Promise<string | null> {
  const r = await window.api.discord.setUpWithButler(ownerWords)
  if (!r.ok) return r.error
  const st = useStore.getState()
  st.setButlerTab(r.tabId)
  st.setSettingsOpen(false)
  visitTab(r.tabId)
  return null
}

type MenuTarget = { kind: 'butler' } | { kind: 'task'; task: AssistTaskRow }

export function ButlerRow({ children }: { children: JSX.Element[] | null }): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const name = useStore((s) => s.settings.butler.name)
  const binding = useStore((s) => s.settings.discord.bindings[0])
  const record = useStore((s) => s.settings.assistSessions[0])
  const sessionMethods = useStore((s) => s.settings.sessionMethods)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const activeTabId = useStore((s) => s.activeTabId)
  const opened = useStore((s) => s.butlerTab)
  const tasks = useStore((s) => s.assistTasks)
  const setAssistTasks = useStore((s) => s.setAssistTasks)
  const setAssistAsked = useStore((s) => s.setAssistAsked)
  const setBindButler = useStore((s) => s.setBindButler)
  const setRenameButler = useStore((s) => s.setRenameButler)
  const [menu, setMenu] = useState<{ target: MenuTarget; left: number; top: number } | null>(null)
  useDismissOnOutside(!!menu, setMenu)

  useEffect(() => {
    void window.api.conductors.tasks().then(setAssistTasks)
    return window.api.conductors.onTasks(setAssistTasks)
  }, [setAssistTasks])

  const backend = preferredAssistBackend({ assist, sessionMethods })
  const callingFor = (tabId: string | undefined, keys: readonly string[]) =>
    attention.find(
      (e) => (!!tabId && e.tabId === tabId) || (!!e.sessionId && keys.includes(e.sessionId))
    )
  const taskKeys = new Set(sessions.filter((s) => s.assistTask).map((s) => s.sessionId))
  const tabId = butlerTabOf(sessions, opened, tabs)
  const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
  const calling = callingFor(
    tabId,
    (record?.sessionIds ?? []).filter((key) => !taskKeys.has(key))
  )

  const openTask = (task: AssistTaskRow): void => visitTab(task.tabId)

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
    return [
      item('Open', () => void openButler(), 'mi', '↩'),
      item('Rename…', () => setRenameButler(true)),
      item('Start a fresh conversation', () => void openButler(true)),
      <div key="sep" className="sep" />,
      ...(binding
        ? [
            item('Change Discord channel…', () => setBindButler(true)),
            item('Unbind Discord', () => void window.api.conductors.unbind(), 'mi danger')
          ]
        : [item('Bind Discord channel…', () => setBindButler(true))])
    ]
  }

  const showMenu = (e: MouseEvent<HTMLElement>, target: MenuTarget): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ target, ...menuPosFor(e.currentTarget, menuItems(target).length) })
  }

  const stateClass = (tab: string | undefined, s: SessionInfo | undefined): string =>
    rowStateClass(!!tab, s?.status, !!tab && !s, s?.turnOver) +
    (tab && tab === activeTabId ? ' active' : '')

  const title = (
    <>
      <span className="ws-tab-cron" title="Butler">
        <IconAssist size={14} />
      </span>
      <span className="ws-tab-title">
        <i>{butlerTitle(name)}</i>
      </span>
    </>
  )

  return (
    <div className="ws-tabs isl-butler">
      {!butlerSetUp({ assist, binding }) ? (
        <div className="ws-tab cold" onClick={() => setAssistAsked(true)}>
          <div className="ws-tab-main">{title}</div>
          <div className="ws-tab-sub">
            <span>Not set up — click to start</span>
          </div>
        </div>
      ) : (
        <div
          className={'ws-tab ' + stateClass(tabId, sess)}
          data-tab-id={tabId}
          onClick={() => void openButler()}
          onContextMenu={(e) => showMenu(e, { kind: 'butler' })}
        >
          <div className="ws-tab-main">
            {title}
            {calling && <span className="ws-tab-unread" title={ATTENTION_REASON[calling.kind]} />}
          </div>
          <div className="ws-tab-sub">
            <SessionBackendIcon backend={sess?.backendId ?? backend} />
            <span>{binding ? channelLabel(binding) : NOT_ON_DISCORD}</span>
          </div>
        </div>
      )}
      {(tasks.length > 0 || !!children?.length) && (
        <div className="ws-subtabs">
          {tasks.map((task) => {
            const s = sessions.find((x) => x.tabId === task.tabId)
            const taskCalling = callingFor(task.tabId, [])
            return (
              <div
                key={task.tabId}
                className={'ws-tab ' + stateClass(task.tabId, s)}
                data-tab-id={task.tabId}
                onClick={() => openTask(task)}
                onContextMenu={(e) => showMenu(e, { kind: 'task', task })}
              >
                <div className="ws-tab-main">
                  <span className="ws-tab-title">
                    <i>{task.name}</i>
                  </span>
                  {taskCalling && (
                    <span className="ws-tab-unread" title={ATTENTION_REASON[taskCalling.kind]} />
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
                    <IconClose size={12} />
                  </button>
                </div>
                <div className="ws-tab-sub">
                  <SessionBackendIcon backend={s?.backendId ?? backend} />
                  <span>{`${name} task`}</span>
                </div>
              </div>
            )
          })}
          {children}
        </div>
      )}
      {/* ADR-0013 */}
      {createPortal(
        menu && (
          <div className="menu" style={{ left: menu.left, top: menu.top }}>
            {menuItems(menu.target)}
          </div>
        ),
        document.body
      )}
    </div>
  )
}

export function RenameButlerDialog(): JSX.Element | null {
  const open = useStore((s) => s.renameButler)
  return open ? <RenameForm /> : null
}

function RenameForm(): JSX.Element {
  const butler = useStore((s) => s.settings.butler)
  const setRenameButler = useStore((s) => s.setRenameButler)
  const [typed, setTyped] = useState(butler.name)
  const name = butlerName(typed)
  const close = (): void => setRenameButler(false)
  const submit = (): void => {
    updateSettings({ butler: renamedButler(butler, name) })
    close()
  }
  // ADR-0013
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Rename your butler
          <span className="modal-close" onClick={close} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              autoFocus
              aria-label="Butler name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') close()
              }}
            />
          </label>
          <div className="field-hint">
            Shown as “{butlerTitle(name)}” in the sidebar and in Discord. Other sessions reach it by
            this name.
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={close}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit}>
            Rename
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

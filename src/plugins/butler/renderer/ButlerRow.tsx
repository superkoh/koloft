import { useContext, useMemo, useState, type JSX, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconAssist, IconClose } from '@renderer/icons'
import { butlerName, butlerTitle, renamedButler } from '../shared/names'
import { attentionReason } from '@shared/types'
import { assistBackendsFor, assistRowBackend } from '@shared/assistPicks'
import { butlerStart } from '@shared/butlerStart'
import { settingsPaneName } from '@shared/settingsPanes'
import { useInstalledBackends } from '@renderer/useInstalledBackends'
import { useStore } from '@renderer/store'
import { rowStateClass, shownRows, statusWithSecrets } from '@renderer/sessionRows'
import { assistInputs } from '@renderer/assistInputs'
import { SessionBackendIcon } from '@renderer/components/SessionBackendIcon'
import { updateSettings } from '@renderer/components/settings/useSettingsUpdate'
import { menuPosFor, useDismissOnOutside } from '@renderer/components/menuPlace'
import { SessionRowsOfContext } from '@renderer/components/sidebarRows'
import { fillsOf } from '@renderer/pluginUi'
import { ROW_EXTRAS } from '@renderer/slots'
import { BUTLER_ROW_PART } from '../plugin'
import { butlerSetUp, butlerTabOf, isButlersWorkspace } from './butlerTabs'
import { openButler, renameButler, useButler } from './state'

function useButlerFolderRows(): JSX.Element[] | null {
  const rowsOf = useContext(SessionRowsOfContext)
  const workspaceRows = useStore((s) => s.workspaceRows)
  const claimedWorkspaces = useStore((s) => s.claimedWorkspaces)
  const tabs = useStore((s) => s.tabs)
  const shown = useMemo(
    () =>
      shownRows({ workspaceRows, claimedWorkspaces, tabs }).claimedWorkspaces.find(
        isButlersWorkspace
      ),
    [workspaceRows, claimedWorkspaces, tabs]
  )
  return shown ? rowsOf(shown) : null
}

export function ButlerRow(): JSX.Element {
  const fills = fillsOf(ROW_EXTRAS)
    .filter((f) => f.row === BUTLER_ROW_PART)
    .map((f) => f.useExtras())
  const moreMenu = fills.flatMap((f) => f.menu)
  const where = fills.map((f) => f.where).join('')
  const children = useButlerFolderRows()
  const setUp = useStore(butlerSetUp)
  const backend = useStore((s) => assistRowBackend('butler', assistInputs(s)))
  const name = useStore((s) => s.settings.butler.name)
  const butlerKeys = useStore((s) => s.settings.butlerSession.sessionIds)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const activeTabId = useStore((s) => s.activeTabId)
  const secretAsks = useStore((s) => s.secretAsks)
  const opened = useButler((s) => s.openedTab)
  const askToSetUp = (): void => useButler.setState({ setUpAsked: true })
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null)
  useDismissOnOutside(!!menu, setMenu)

  const tabId = butlerTabOf(sessions, opened, tabs)
  const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
  const calling = attention.find(
    (e) => (!!tabId && e.tabId === tabId) || (!!e.sessionId && butlerKeys.includes(e.sessionId))
  )

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

  const menuItems = [
    item('Open', () => void openButler(), 'mi', '↩'),
    item('Rename…', () => renameButler(true)),
    item('Start a fresh conversation', () => void openButler(true)),
    <div key="sep" className="sep" />,
    ...moreMenu.map((e) => item(e.label, e.run, e.danger ? 'mi danger' : 'mi'))
  ]

  const showMenu = (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(menuPosFor(e.currentTarget, menuItems.length))
  }

  const stateClass =
    rowStateClass(
      !!tabId,
      statusWithSecrets(sess?.status, tabId, secretAsks),
      !!tabId && !sess,
      sess?.turnOver
    ) + (tabId && tabId === activeTabId ? ' active' : '')

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
      {!setUp ? (
        <div className="ws-tab cold" onClick={askToSetUp}>
          <div className="ws-tab-main">{title}</div>
          <div className="ws-tab-sub">
            <span>Not set up — click to start</span>
          </div>
        </div>
      ) : (
        <div
          className={'ws-tab ' + stateClass}
          data-tab-id={tabId}
          onClick={() => void openButler()}
          onContextMenu={showMenu}
        >
          <div className="ws-tab-main">
            {title}
            {calling && <span className="ws-tab-unread" title={attentionReason(calling)} />}
          </div>
          <div className="ws-tab-sub">
            <SessionBackendIcon backend={sess?.backendId ?? backend} />
            <span>{where}</span>
          </div>
          {!tabId && <WhyButlerCannotStart />}
        </div>
      )}
      {!!children?.length && <div className="ws-subtabs">{children}</div>}
      {/* ADR-0013 */}
      {createPortal(
        menu && (
          <div className="menu" style={{ left: menu.left, top: menu.top }}>
            {menuItems}
          </div>
        ),
        document.body
      )}
    </div>
  )
}

function WhyButlerCannotStart(): JSX.Element | null {
  const name = useStore((s) => s.settings.butler.name)
  const assist = useStore((s) => s.settings.assist)
  const sessionMethods = useStore((s) => s.settings.sessionMethods)
  const accounts = useStore((s) => s.accounts)
  const openSettingsPane = useStore((s) => s.openSettingsPane)
  const { installed } = useInstalledBackends()
  if (!accounts || !installed) return null
  const start = butlerStart(
    assistBackendsFor('butler', { assist, sessionMethods, accounts }),
    { enabled: sessionMethods.enabled, installed, accounts },
    name
  )
  if (!('error' in start)) return null
  const { lead, fixedIn } = start.preferred
  return (
    <p className="field-hint bad" title={start.inFull}>
      {lead}
      <button
        className="ob-link"
        onClick={(e) => {
          e.stopPropagation()
          openSettingsPane(fixedIn)
        }}
      >
        {settingsPaneName(fixedIn)}
      </button>
      .
    </p>
  )
}

export function RenameButlerDialog(): JSX.Element | null {
  const open = useButler((s) => s.renaming)
  return open ? <RenameForm /> : null
}

function RenameForm(): JSX.Element {
  const butler = useStore((s) => s.settings.butler)
  const [typed, setTyped] = useState(butler.name)
  const name = butlerName(typed)
  const close = (): void => renameButler(false)
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

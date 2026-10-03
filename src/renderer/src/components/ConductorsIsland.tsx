import { useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { LuChevronDown, LuChevronUp, LuConciergeBell, LuPlus } from 'react-icons/lu'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { channelLabel, scopeName } from '@shared/conductors'
import { ATTENTION_REASON, type ConductorBinding } from '@shared/types'
import { useStore } from '../store'
import { rowStateClass } from '../sessionRows'
import { conductorsNeedYou, conductorTab } from '../conductorRows'
import { SessionBackendIcon } from './SessionBackendIcon'
import { menuPosFor, useDismissOnOutside } from './WorkspaceSidebar'

const MENU_ITEMS = 5

export async function openConductor(id: string, fresh = false): Promise<void> {
  const r = await (fresh ? window.api.conductors.startFresh(id) : window.api.conductors.open(id))
  const st = useStore.getState()
  if (!r.ok) {
    st.showToast(r.error)
    return
  }
  st.setConductorTab(id, r.tabId)
  window.api.attention.visit(r.tabId)
  st.activateTab(r.tabId)
}

export function ConductorsIsland(): JSX.Element | null {
  const discord = useStore((s) => s.settings.discord)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const activeTabId = useStore((s) => s.activeTabId)
  const opened = useStore((s) => s.conductorTabs)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const folded = useStore((s) => s.settings.conductorsFolded)
  const [menu, setMenu] = useState<{ binding: ConductorBinding; left: number; top: number } | null>(
    null
  )
  useDismissOnOutside(!!menu, setMenu)

  if (discord.bindings.length === 0) return null
  const rows = discord.bindings.map((b) => {
    const tabId = conductorTab(b, sessions, opened, tabs)
    const sess = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
    const calling = attention.find(
      (e) => (!!tabId && e.tabId === tabId) || (!!e.sessionId && b.sessionIds.includes(e.sessionId))
    )
    return { b, tabId, sess, calling }
  })
  const callingCount = rows.filter((r) => r.calling).length

  const setFolded = (next: boolean): void => {
    const st = useStore.getState()
    st.setSettings({ ...st.settings, conductorsFolded: next })
    void window.api.settings.set({ conductorsFolded: next })
  }

  const item = (label: string, run: () => void, cls = 'mi'): JSX.Element => (
    <div
      className={cls}
      onClick={() => {
        setMenu(null)
        run()
      }}
    >
      {label}
    </div>
  )

  const renderMenu = (): JSX.Element | null => {
    if (!menu) return null
    const { binding } = menu
    const other = binding.backend === 'claude' ? 'codex' : 'claude'
    return (
      <div className="menu" style={{ left: menu.left, top: menu.top }}>
        <div
          className="mi"
          onClick={() => {
            setMenu(null)
            void openConductor(binding.id)
          }}
        >
          Open<span className="k">↩</span>
        </div>
        {item('Change channel…', () => setBindConductor({ editId: binding.id }))}
        {item(`Switch to ${BACKEND_LABEL[other]} next time`, () => {
          void window.api.conductors.switchBackend(binding.id)
        })}
        {item('Start a fresh conductor', () => void openConductor(binding.id, true))}
        <div className="sep" />
        {item('Unbind', () => void window.api.conductors.unbind(binding.id), 'mi danger')}
      </div>
    )
  }

  return (
    <>
      <div className="gutter-h idle" style={{ height: 10 }} />
      <div className="island isl-notes isl-conductors">
        <div className="wb-bar">
          <span className="wb-title" title="Conductors">
            <span className="ic">
              <LuConciergeBell size={14} />
            </span>
            <span className="nm">Conductors</span>
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
              {rows.map(({ b, tabId, sess, calling }) => (
                <div
                  key={b.id}
                  className={
                    'ws-tab ' +
                    rowStateClass(!!tabId, sess?.status, !!tabId && !sess) +
                    (tabId && tabId === activeTabId ? ' active' : '')
                  }
                  data-tab-id={tabId}
                  onClick={() => void openConductor(b.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setMenu({ binding: b, ...menuPosFor(e.currentTarget, MENU_ITEMS) })
                  }}
                >
                  <div className="ws-tab-main">
                    <span className="ws-tab-title">
                      <i>{scopeName(b.scope)}</i>
                    </span>
                    {calling && (
                      <span className="ws-tab-unread" title={ATTENTION_REASON[calling.kind]} />
                    )}
                  </div>
                  <div className="ws-tab-sub">
                    <SessionBackendIcon backend={b.backend} />
                    <span>{channelLabel(b)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* ADR-0013 */}
      {createPortal(renderMenu(), document.body)}
    </>
  )
}

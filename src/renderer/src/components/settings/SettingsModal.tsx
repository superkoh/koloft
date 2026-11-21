import { useCallback, useEffect, useRef, useState, type ComponentType, type JSX } from 'react'
import {
  IconAccounts,
  IconAiStart,
  IconAppearance,
  IconAssist,
  IconClose,
  IconExtensions,
  IconInfo,
  IconNotifications,
  IconPlugins,
  IconShortcuts,
  IconTerminal,
  IconUsage,
  type Icon
} from '../../icons'
import { clearHistory } from '../../browserHistory'
import { useStore } from '../../store'
import { EscScope } from './escScope'
import { AccountsPane } from './AccountsPane'
import { UsagePane } from './UsagePane'
import { SessionsPane } from './SessionsPane'
import { AppearancePane } from './AppearancePane'
import { ShortcutsPane } from './ShortcutsPane'
import { NotificationsPane } from './NotificationsPane'
import { ExtensionsPane } from './ExtensionsPane'
import { AboutPane } from './AboutPane'
import { WelcomePane } from './WelcomePane'
import { AssistPane } from './AssistPane'
import { PluginPage, PluginsPane } from './PluginsPane'
import { pluginOfPane, pluginPane, SettingsGo } from './settingsNav'
import { PLUGIN_SETTINGS_PAGES } from '@shared/paletteFeatures'
import { APP_PANES, type AppPaneId } from '@shared/settingsPanes'
import '../../settings.css'

function ClearBrowsingData(): JSX.Element {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!asking) {
    return (
      <button className="set-clear" onClick={() => setAsking(true)}>
        Clear browsing data
      </button>
    )
  }
  return (
    <div className="set-clear-ask">
      <div className="set-clear-what">
        Cookies, Service Workers, cache, IndexedDB, HTTP auth, certificate exceptions, pages you
        visited
      </div>
      <div className="set-clear-row">
        <button className="mini" disabled={busy} onClick={() => setAsking(false)}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            clearHistory()
            void window.api.browser.clearData().finally(() => {
              setBusy(false)
              setAsking(false)
            })
          }}
        >
          Clear
        </button>
      </div>
    </div>
  )
}

interface PaneParts {
  Icon: Icon
  Pane: ComponentType
}

const PANE_PARTS: Record<AppPaneId, PaneParts> = {
  welcome: { Icon: IconAiStart, Pane: WelcomePane },
  sessions: { Icon: IconTerminal, Pane: SessionsPane },
  accounts: { Icon: IconAccounts, Pane: AccountsPane },
  usage: { Icon: IconUsage, Pane: UsagePane },
  appearance: { Icon: IconAppearance, Pane: AppearancePane },
  shortcuts: { Icon: IconShortcuts, Pane: ShortcutsPane },
  assist: { Icon: IconAssist, Pane: AssistPane },
  plugins: { Icon: IconPlugins, Pane: PluginsPane },
  notifications: { Icon: IconNotifications, Pane: NotificationsPane },
  extensions: { Icon: IconExtensions, Pane: ExtensionsPane },
  about: { Icon: IconInfo, Pane: AboutPane }
}

const PANES = APP_PANES.map(({ id, label }) => ({ id, label, ...PANE_PARTS[id] }))

function paneToOpen(asked: string | null): string {
  const page = PLUGIN_SETTINGS_PAGES.find((p) => p.id === asked)
  return page ? pluginPane(page.plugin) : (asked ?? 'accounts')
}

export function SettingsModal(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const loginLive = useStore((s) => {
    const phase = s.accountLogin?.progress?.phase
    return phase === 'starting' || phase === 'browser'
  })
  const [pane, setPane] = useState('accounts')
  const modalRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const escConsumers = useRef(new Set<() => boolean>())

  const registerEsc = useCallback((fn: () => boolean) => {
    escConsumers.current.add(fn)
    return () => void escConsumers.current.delete(fn)
  }, [])

  useEffect(() => {
    if (!open) return
    setPane(paneToOpen(useStore.getState().settingsPane))
    void window.api.accounts.probe()
  }, [open])

  useEffect(() => {
    if (!open) return
    navRef.current?.querySelector<HTMLElement>('.set-ni.on')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (useStore.getState().update.open) return
      if (useStore.getState().overlay?.open) return
      for (const consume of escConsumers.current) if (consume()) return
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setSettingsOpen])

  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const root = modalRef.current
    if (!root) return
    const els = [
      ...root.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
    if (els.length === 0) return
    const first = els[0]
    const last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const plugin = pluginOfPane(pane)
  const navOn = plugin ? 'plugins' : pane
  const OpenPane = PANES.find((p) => p.id === pane)?.Pane

  const navKey = (e: React.KeyboardEvent, i: number): void => {
    const move = (next: number): void => {
      const target = PANES[(next + PANES.length) % PANES.length]
      setPane(target.id)
      requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('.set-ni.on')?.focus())
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(i + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(i - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setPane(PANES[i].id)
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <nav className="set-nav" role="tablist" aria-label="Settings categories" ref={navRef}>
          <div className="set-brand">Settings</div>
          {PANES.map((p, i) => (
            <div
              key={p.id}
              role="tab"
              aria-selected={navOn === p.id}
              tabIndex={navOn === p.id ? 0 : -1}
              className={'set-ni' + (navOn === p.id ? ' on' : '')}
              onClick={() => setPane(p.id)}
              onKeyDown={(e) => navKey(e, i)}
            >
              <p.Icon size={16} />
              {p.label}
              {p.id === 'accounts' && loginLive && <i className="set-dot" />}
            </div>
          ))}
          <ClearBrowsingData />
        </nav>
        <div className="set-main">
          <EscScope.Provider value={registerEsc}>
            <SettingsGo.Provider value={setPane}>
              {plugin ? <PluginPage key={plugin} id={plugin} /> : OpenPane && <OpenPane />}
            </SettingsGo.Provider>
          </EscScope.Provider>
        </div>
        <button
          className="set-x"
          title="Close (Esc)"
          aria-label="Close"
          onClick={() => setSettingsOpen(false)}
        >
          <IconClose size={14} />
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LuPuzzle } from 'react-icons/lu'
import { BROWSER_PARTITION } from '@shared/types'
import { actionView, splitActions, type ActionRowState, type ActionView } from './extensionActions'

const ICON_32PX_SCALED_DOWN_TO_FIT = '/32/2'
const PLATFORM_CURRENT_TAB = -1
const CAPTURE_BEFORE_XTERM_SWALLOWS_ESC = true

function iconUrl(id: string, activeTabId: number | undefined): string {
  const params = new URLSearchParams({ partition: BROWSER_PARTITION })
  if (activeTabId !== undefined) params.set('tabId', String(activeTabId))
  return `crx://extension-icon/${id}${ICON_32PX_SCALED_DOWN_TO_FIT}?${params.toString()}`
}

function monogram(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?'
}

function ActionIcon({
  action,
  activeTabId
}: {
  action: ActionView
  activeTabId: number | undefined
}): JSX.Element {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [action.id, activeTabId])

  if (broken) return <span className="bext-mono">{monogram(action.name)}</span>
  return (
    <img
      className="bext-icon"
      src={iconUrl(action.id, activeTabId)}
      alt=""
      onError={() => setBroken(true)}
    />
  )
}

export function BrowserActions(): JSX.Element | null {
  const [state, setState] = useState<ActionRowState>({ actions: [] })
  const [menuOpen, setMenuOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const popupArmed = useRef(false)

  useEffect(() => {
    const bridge = window.browserAction
    if (!bridge) return
    const onUpdate = (next: ActionRowState): void => setState(next)
    bridge.addEventListener('update', onUpdate)
    bridge.addObserver(BROWSER_PARTITION)
    void bridge.getState(BROWSER_PARTITION).then(setState, () => {})
    return () => {
      bridge.removeEventListener('update', onUpdate)
      bridge.removeObserver(BROWSER_PARTITION)
    }
  }, [])

  const dismissPopup = useCallback((): void => {
    popupArmed.current = false
    window.api.extensions.dismissPopup()
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!popupArmed.current && !menuOpen) return
      if (root.current?.contains(e.target as Node)) return
      setMenuOpen(false)
      dismissPopup()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!popupArmed.current && !menuOpen) return
      setMenuOpen(false)
      dismissPopup()
    }
    window.addEventListener('mousedown', onDown, CAPTURE_BEFORE_XTERM_SWALLOWS_ESC)
    window.addEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM_SWALLOWS_ESC)
    return () => {
      window.removeEventListener('mousedown', onDown, CAPTURE_BEFORE_XTERM_SWALLOWS_ESC)
      window.removeEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM_SWALLOWS_ESC)
    }
  }, [dismissPopup, menuOpen])

  const activate = useCallback(async (id: string, from: HTMLElement): Promise<void> => {
    const rect = from.getBoundingClientRect()
    const bar = from.closest('.baddr')?.getBoundingClientRect()
    const anchor = {
      x: rect.x,
      y: bar ? bar.y : rect.y,
      width: rect.width,
      height: bar ? bar.height : rect.height
    }
    popupArmed.current = true
    setMenuOpen(false)
    await window.api.extensions.anchorPopup(anchor).catch(() => {})
    void window.browserAction
      ?.activate(BROWSER_PARTITION, {
        eventType: 'click',
        extensionId: id,
        tabId: PLATFORM_CURRENT_TAB,
        anchorRect: anchor
      })
      .catch(() => {})
  }, [])

  const views = state.actions.map((a) => actionView(a, state.activeTabId))
  const { shown, menu } = splitActions(views)
  if (views.length === 0) return null

  return (
    <div className="bext" ref={root}>
      {shown.map((a) => (
        <button
          key={a.id}
          className="bext-act"
          aria-label={a.name}
          title={a.name}
          onClick={(e) => void activate(a.id, e.currentTarget)}
        >
          <ActionIcon action={a} activeTabId={state.activeTabId} />
          {a.badge && <span className="bext-badge">{a.badge}</span>}
        </button>
      ))}
      {menu && (
        <button
          className="bext-act"
          aria-label="Extensions"
          title="Extensions"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <LuPuzzle size={15} />
        </button>
      )}
      {menu && menuOpen && (
        <div className="bext-menu" role="menu">
          {menu.map((a) => (
            <button
              key={a.id}
              className="bext-mrow"
              role="menuitem"
              aria-label={a.name}
              onClick={(e) => void activate(a.id, e.currentTarget)}
            >
              <ActionIcon action={a} activeTabId={state.activeTabId} />
              <span className="bext-mname">{a.name}</span>
              {a.badge && <span className="bext-badge">{a.badge}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

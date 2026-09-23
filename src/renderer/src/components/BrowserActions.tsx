import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LuPuzzle } from 'react-icons/lu'
import { BROWSER_PARTITION } from '@shared/types'
import { actionView, splitActions, type ActionRowState, type ActionView } from './extensionActions'

/**
 * D3/§03 figure 1 — the extension action row at the right end of the address bar, divided
 * from the nav controls by its own leading line.
 *
 * The row is Koloft's own markup on top of the upstream library's bridge
 * (`window.browserAction`, injected by the host preload): the library also ships a
 * `<browser-action-list>` custom element, but it paints into a shadow root this app can
 * neither label nor style. What is borrowed is the state stream and the activation —
 * clicking one is what raises that extension's popup (D5) or fires its `onClicked`.
 */

/** icon size and Chromium's "scale down to fit" resize type, as the crx protocol takes them */
const ICON_URL_SUFFIX = '/32/2'

function iconUrl(id: string, activeTabId: number | undefined): string {
  const params = new URLSearchParams({ partition: BROWSER_PARTITION })
  if (activeTabId !== undefined) params.set('tabId', String(activeTabId))
  return `crx://extension-icon/${id}${ICON_URL_SUFFIX}?${params.toString()}`
}

/** An extension with no icon of its own still needs something clickable to be (a probe
 *  extension is the honest case; a real one that fails to paint is the other). */
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
  /** an action was clicked, so a popup may be up: what arms the two ways of closing it */
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

  // D5: the floater closes on a click anywhere outside it and on Esc. Upstream closes it
  // on the window's own blur, which a click inside Koloft is not — this is the other half.
  // The overflow menu is dismissed by the same two gestures: it is a menu, and a menu
  // that only closes by clicking its own button is a menu the user cannot put away.
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
    // both in the capture phase: an Esc pressed while the terminal has the focus never
    // reaches a bubbling listener — xterm stops it on the way up
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [dismissPopup, menuOpen])

  const activate = useCallback(async (id: string, from: HTMLElement): Promise<void> => {
    const rect = from.getBoundingClientRect()
    // horizontally the icon, vertically the whole address bar: the popup hangs off the
    // BAR's lower edge (figure 2), not off the middle of a 28px button inside it
    const bar = from.closest('.baddr')?.getBoundingClientRect()
    const anchor = {
      x: rect.x,
      y: bar ? bar.y : rect.y,
      width: rect.width,
      height: bar ? bar.height : rect.height
    }
    popupArmed.current = true
    setMenuOpen(false)
    // awaited, so main is holding the anchor before the popup it belongs to can exist
    await window.api.extensions.anchorPopup(anchor).catch(() => {})
    void window.browserAction
      ?.activate(BROWSER_PARTITION, {
        eventType: 'click',
        extensionId: id,
        // -1: the platform's own current tab, which Koloft keeps in step (D4) — the row
        // must not get a second, staler opinion about which tab that is
        tabId: -1,
        anchorRect: anchor
      })
      .catch(() => {
        /* the popup this click asked for never opened; nothing else to undo */
      })
  }, [])

  const views = state.actions.map((a) => actionView(a, state.activeTabId))
  const { shown, menu } = splitActions(views)
  // D3's empty value: no extensions, no row — not even the divider
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

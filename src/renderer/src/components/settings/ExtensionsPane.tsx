import { useCallback, useEffect, useState, type JSX } from 'react'
import { LuExternalLink, LuX } from 'react-icons/lu'
import type { ExtensionInfo } from '@shared/types'
import { CHROME_WEB_STORE_URL } from '@shared/types'
import { ExtensionModal } from '../ExtensionConfirm'
import { BrowserOverlay } from '../BrowserOverlay'
import { useStore } from '../../store'
import { useEscConsumer } from './escScope'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

/**
 * D1/D2/§04 figure 3 — the installed Chrome extensions (switch to load and unload one, × to
 * take it away for good), and the Chrome Web Store entry, which is the only way a new one
 * gets in: no preinstalls, no recommendations.
 *
 * The list is main's word, re-read whenever the registry changes: an extension can also
 * arrive or leave without this pane being touched (the §07 install seam, a Web Store
 * install in a Browser tab).
 */
export function ExtensionsPane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useSettingsUpdate()
  const [rows, setRows] = useState<ExtensionInfo[]>([])
  /** the extension whose × was pressed, while its confirmation is up */
  const [removing, setRemoving] = useState<ExtensionInfo | null>(null)

  const reload = useCallback((): void => {
    void window.api.extensions.list().then(setRows, () => {})
  }, [])

  useEffect(() => {
    reload()
    return window.api.extensions.onChanged(reload)
  }, [reload])

  // FR-15: Esc collapses this confirmation before it closes Settings
  const cancelRemove = useCallback((): void => setRemoving(null), [])
  useEscConsumer(removing !== null, cancelRemove)

  // §04 revised (user call,): the store has its own overlay and owes
  // nothing to sessions — Settings is a global surface. Closing it re-reads the list,
  // which is how an install made inside the overlay reaches the rows.
  const [storeOpen, setStoreOpen] = useState(false)
  const closeStore = useCallback((): void => {
    setStoreOpen(false)
    reload()
  }, [reload])
  // FR-15: Esc peels the store overlay before it closes Settings
  useEscConsumer(storeOpen, closeStore)

  return (
    <>
      <div className="set-ph">
        <h3>Extensions</h3>
        <p>
          Installed in the Browser&apos;s own session and shared by every session&apos;s Browser.
          Koloft&apos;s own interface is never touched by them.
        </p>
      </div>

      {/* D2. It lives here because this is where the Browser's own settings are
          (the store, the installed list, Clear browsing data) — and it is a LOAD-BEARING
          switch, not a second lock: with it on, the endpoint Koloft injects beats a tool's
          own `--isolated` flag, so this is the one way to send those tools back to a
          browser of their own. */}
      <div className="set-row">
        <div className="set-lab">
          <b>Let agents drive this Browser</b>
          <small>
            A session&apos;s agent can open and drive pages here instead of launching a browser of
            its own. Connected tools drive this Browser right away; nothing is asked. They get the
            pages you can see, signed in as you. Turning this off disconnects anything connected
            right now.
          </small>
        </div>
        <Switch
          checked={settings.browserControl}
          onChange={(on) => update({ browserControl: on })}
        />
      </div>

      {rows.length === 0 && (
        <div className="ext-empty">
          No extensions installed. They come from the Chrome Web Store — open it below and install
          one from its own page, the way you would in Chrome.
        </div>
      )}

      {rows.map((ext) => (
        <div className="ext-row" key={ext.id}>
          <div className="set-lab">
            <b className="ext-name">{ext.name}</b>
            <small className="ext-ver">{ext.version}</small>
          </div>
          <Switch
            checked={ext.enabled}
            ariaLabel={`Toggle ${ext.name}`}
            onChange={(on) => {
              // optimistic: loading an extension back in takes a moment, and the row's
              // switch is the only thing that says the click landed
              setRows((prev) => prev.map((r) => (r.id === ext.id ? { ...r, enabled: on } : r)))
              void window.api.extensions.setEnabled(ext.id, on).then(reload, reload)
            }}
          />
          <button
            className="ext-x"
            aria-label={`Uninstall ${ext.name}`}
            title="Uninstall"
            onClick={() => setRemoving(ext)}
          >
            <LuX size={13} />
          </button>
        </div>
      ))}

      <div className="set-row">
        <div className="set-lab">
          <b>Install a new extension</b>
          <small>Opens right here — install from the store page, without leaving Koloft.</small>
        </div>
        <button className="mini" onClick={() => setStoreOpen(true)}>
          Open Chrome Web Store <LuExternalLink size={13} />
        </button>
      </div>

      {/* R1: the store's own overlay is now the app's ONE overlay component, with
          the store as a caller — §04's ownership is unchanged (it is still Settings') */}
      {storeOpen && (
        <BrowserOverlay url={CHROME_WEB_STORE_URL} title="Chrome Web Store" onClose={closeStore} />
      )}

      {removing && (
        <ExtensionModal
          title={removing.name}
          realm="Uninstall"
          message="Remove it from every session's Browser? The extension's files are deleted."
          confirmLabel="Uninstall"
          cancelLabel="Cancel"
          onAnswer={(yes) => {
            setRemoving(null)
            if (yes) void window.api.extensions.uninstall(removing.id).then(reload, reload)
          }}
        />
      )}
    </>
  )
}

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

export function ExtensionsPane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useSettingsUpdate()
  const [rows, setRows] = useState<ExtensionInfo[]>([])
  const [removing, setRemoving] = useState<ExtensionInfo | null>(null)

  const reload = useCallback((): void => {
    void window.api.extensions.list().then(setRows, () => {})
  }, [])

  useEffect(() => {
    reload()
    return window.api.extensions.onChanged(reload)
  }, [reload])

  const cancelRemove = useCallback((): void => setRemoving(null), [])
  useEscConsumer(removing !== null, cancelRemove)

  const [storeOpen, setStoreOpen] = useState(false)
  const closeStore = useCallback((): void => {
    setStoreOpen(false)
    reload()
  }, [reload])
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

      {/* PLATFORM§17 */}
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

      <div className="set-row">
        <div className="set-lab">
          <b>Let agents use Koloft</b>
          <small>
            A session&apos;s agent gets a koloft command: it can open files and pages in its
            Workbench, read and add to the workspace note, manage scheduled tasks and start sibling
            sessions. A toast tells you when it changes a scheduled task. Turning this on reaches
            sessions started afterwards; turning it off stops the command in every session at once.
          </small>
        </div>
        <Switch checked={settings.agentTools} onChange={(on) => update({ agentTools: on })} />
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

import { useCallback, useEffect, useState, type JSX } from 'react'
import { IconClose, IconOpenOutside } from '../../icons'
import type { ExtensionInfo } from '@shared/types'
import { CHROME_WEB_STORE_URL } from '@shared/types'
import { ExtensionModal } from '../ExtensionConfirm'
import { BrowserOverlay } from '../BrowserOverlay'
import { useEscConsumer } from './escScope'
import { Switch } from './Switch'

export function ExtensionsPane(): JSX.Element {
  const [rows, setRows] = useState<ExtensionInfo[]>([])
  const [removing, setRemoving] = useState<ExtensionInfo | null>(null)

  const reload = useCallback((): void => {
    void window.api.extensions.list().then(setRows, () => {})
  }, [])

  useEffect(() => {
    reload()
    return window.api.extensions.onChanged(reload)
  }, [reload])

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
            <IconClose size={13} />
          </button>
        </div>
      ))}

      <div className="set-row">
        <div className="set-lab">
          <b>Install a new extension</b>
          <small>Opens right here — install from the store page, without leaving Koloft.</small>
        </div>
        <button className="mini" onClick={() => setStoreOpen(true)}>
          Open Chrome Web Store <IconOpenOutside size={13} />
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

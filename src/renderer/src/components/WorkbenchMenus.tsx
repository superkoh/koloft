import { useEffect, useState, type JSX } from 'react'
import type { ListeningPort } from '@shared/types'
import { IconCopyLink, IconFile, IconTerminal, IconWebPage } from '../icons'

function SessionPorts({
  tabId,
  onPort
}: {
  tabId: string
  onPort: (port: number) => void
}): JSX.Element | null {
  const [ports, setPorts] = useState<ListeningPort[] | null>(null)
  useEffect(() => {
    let shown = true
    void window.api.sessions.ports(tabId).then((found) => {
      if (shown) setPorts(found)
    })
    return () => {
      shown = false
    }
  }, [tabId])
  if (!ports) return null
  return (
    <>
      <div className="sep" />
      <div className="mi head">{ports.length ? 'Listening ports' : 'No listening ports'}</div>
      {ports.map((p) => (
        <button
          key={p.port}
          className="mi"
          role="menuitem"
          title={`${p.process} (pid ${p.pid})`}
          onClick={() => onPort(p.port)}
        >
          <IconWebPage size={14} />
          localhost:{p.port}
        </button>
      ))}
    </>
  )
}

export function NewTabMenu({
  canTerminal,
  portsOf,
  onClose,
  onWeb,
  onFile,
  onTerminal,
  onPort
}: {
  canTerminal: boolean
  portsOf: string | null
  onClose: () => void
  onWeb: () => void
  onFile: () => void
  onTerminal: () => void
  onPort: (port: number) => void
}): JSX.Element {
  return (
    <div
      className="menu wb-newmenu"
      role="menu"
      onMouseLeave={onClose}
      ref={(el) => {
        el?.focus()
      }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          onWeb()
        }}
      >
        <IconWebPage size={14} />
        New web tab
      </button>
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          onFile()
        }}
      >
        <IconFile size={14} />
        Open file…
      </button>
      {canTerminal && (
        <button
          className="mi"
          role="menuitem"
          onClick={() => {
            onClose()
            onTerminal()
          }}
        >
          <IconTerminal size={14} />
          New terminal
        </button>
      )}
      {portsOf && (
        <SessionPorts
          tabId={portsOf}
          onPort={(port) => {
            onClose()
            onPort(port)
          }}
        />
      )}
    </div>
  )
}

export function PageMoreMenu({
  url,
  onClose
}: {
  url: string | undefined
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="bmenu"
      role="menu"
      onMouseLeave={onClose}
      ref={(el) => {
        el?.focus()
      }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <button
        className="bmenu-item"
        role="menuitem"
        onClick={() => {
          if (url) window.api.browser.copyText(url)
          onClose()
        }}
      >
        <IconCopyLink size={14} />
        Copy current URL
      </button>
    </div>
  )
}

import { useEffect, useState, type JSX } from 'react'
import type { ListeningPort } from '@shared/types'
import { IconCopyLink, IconFile, IconTerminal, IconWebPage } from '../icons'

function SessionPorts({
  tabId,
  onPort
}: {
  tabId: string
  onPort: (port: number) => void
}): JSX.Element {
  const [ports, setPorts] = useState<ListeningPort[] | null | undefined>(undefined)
  useEffect(() => {
    let shown = true
    const show = (found: ListeningPort[] | null): void => {
      if (shown) setPorts(found)
    }
    window.api.sessions.ports(tabId).then(show, () => show(null))
    return () => {
      shown = false
    }
  }, [tabId])
  const head =
    ports === undefined
      ? 'Looking for listening ports…'
      : ports === null
        ? 'Could not read listening ports'
        : ports.length
          ? 'Listening ports'
          : 'No listening ports'
  return (
    <>
      <div className="sep" />
      <div className="mi head">{head}</div>
      {ports?.map((p) => (
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
  liveSession,
  onClose,
  onWeb,
  onFile,
  onTerminal,
  onPort
}: {
  liveSession: string | null
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
      {liveSession && (
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
      {liveSession && (
        <SessionPorts
          tabId={liveSession}
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

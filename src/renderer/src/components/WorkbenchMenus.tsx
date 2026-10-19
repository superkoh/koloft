import type { JSX } from 'react'
import { IconCopyLink, IconFile, IconTerminal, IconWebPage } from '../icons'

export function NewTabMenu({
  canTerminal,
  onClose,
  onWeb,
  onFile,
  onTerminal
}: {
  canTerminal: boolean
  onClose: () => void
  onWeb: () => void
  onFile: () => void
  onTerminal: () => void
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

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuFolder, LuX } from 'react-icons/lu'
import { isComposing } from '../keys'
import {
  paletteGroups,
  paletteSessions,
  paletteWorkspaces,
  type PaletteAction,
  type PaletteItem
} from '../palette'
import { openSessionRow } from '../sessionClick'
import { mixesBackends } from '../sessionRows'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'

const TITLE = 'Jump to…'

export function CommandPalette({
  actions,
  onClose
}: {
  actions: PaletteAction[]
  onClose: () => void
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const [query, setQuery] = useState('')
  const [hot, setHot] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const sessionItems = useMemo(
    () => paletteSessions(rows, sessions, tabs, attention),
    [rows, sessions, tabs, attention]
  )
  const workspaceItems = useMemo(() => paletteWorkspaces(rows, window.api.home), [rows])
  const showBackend = mixesBackends(sessionItems.map((s) => s.row))
  const groups = paletteGroups(sessionItems, workspaceItems, actions, query)
  const visible = groups.flatMap((g) => g.items)
  const at = Math.min(hot, Math.max(0, visible.length - 1))

  const open = (item: PaletteItem | undefined): void => {
    if (!item || (item.kind === 'action' && item.disabled)) return
    onClose()
    if (item.kind === 'session') openSessionRow(item.row, item.wsPath)
    else if (item.kind === 'workspace') useStore.getState().selectWorkspace(item.wsPath)
    else item.run()
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    listRef.current?.querySelector('.cb-row.hot')?.scrollIntoView({ block: 'nearest' })
  }, [at, query])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHot(Math.min(at + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHot(Math.max(at - 1, 0))
    } else if (e.key === 'Enter' && !isComposing(e)) {
      e.preventDefault()
      e.stopPropagation()
      open(visible[at])
    }
  }

  const rowOf = (item: PaletteItem): JSX.Element => {
    const i = visible.indexOf(item)
    const cold = item.kind === 'session' && !item.row.running && !item.row.pending
    const dim = item.kind === 'action' && item.disabled
    return (
      <div
        key={item.key}
        className={
          'cb-row' + (cold ? ' cold' : '') + (dim ? ' dim' : '') + (i === at ? ' hot' : '')
        }
        role="option"
        aria-selected={i === at}
        aria-disabled={dim || undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => open(item)}
      >
        {item.kind === 'session' && (
          <>
            {showBackend && <SessionBackendIcon backend={item.row.backendId} />}
            <span className="wsp-name">{item.title}</span>
            {item.calling && <span className="ws-tab-unread" />}
            <span className="note">{item.note}</span>
          </>
        )}
        {item.kind === 'workspace' && (
          <>
            <span className="fico">
              <LuFolder size={15} />
            </span>
            <span className="wsp-name">{item.name}</span>
            <span className="note">{item.note}</span>
          </>
        )}
        {item.kind === 'action' && (
          <>
            <span className="wsp-name">{item.label}</span>
            {item.keys && <span className="k">{item.keys}</span>}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal palette"
        role="dialog"
        aria-label={TITLE}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{TITLE}</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="cb-input focus">
            <input
              ref={inputRef}
              className="cb-field"
              spellCheck={false}
              autoComplete="off"
              placeholder="type a session, workspace or action…"
              aria-label="Jump to"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHot(0)
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="wsp-list" role="listbox" aria-label="Results" ref={listRef}>
            {groups.map((g) => (
              <div key={g.title} role="group" aria-label={g.title}>
                <div className="cb-hd">{g.title}</div>
                {g.items.map(rowOf)}
              </div>
            ))}
            {visible.length === 0 && (
              <div className="cb-empty">No session, workspace or action matches “{query}”</div>
            )}
          </div>
          <p className="field-hint">↓↑ move · ⏎ open · Esc cancel</p>
        </div>
      </div>
    </div>
  )
}

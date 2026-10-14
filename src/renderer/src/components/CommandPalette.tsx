import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuFolder, LuSearch, LuSparkles } from 'react-icons/lu'
import type { BackendId, SessionSearchHit } from '@shared/types'
import type { SessionRoute } from '@shared/sessionRoute'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { basename } from '@shared/preview'
import { parseRemoteKey } from '@shared/remoteKey'
import { askRoute } from '../aiStart'
import { isComposing } from '../keys'
import {
  paletteGroups,
  paletteSessions,
  paletteWorkspaces,
  type PaletteAction,
  type PaletteItem
} from '../palette'
import { openSessionRow } from '../sessionClick'
import { mixesBackends, relTime } from '../sessionRows'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'
import { BusyLine } from './SessionLaunchButtons'

const SEARCH_AFTER_TYPING_MS = 400

let lastSearchId = 0

function workspaceLabel(wsPath: string): string {
  const key = parseRemoteKey(wsPath)
  return key ? `${key.host}:${basename(key.path)}` : basename(wsPath)
}

function countLine(n: number): string {
  if (!n) return 'No matches'
  return n === 1 ? '1 conversation' : `${n} conversations`
}

function startLabel(assistOn: boolean, backend: string | undefined): string {
  const verb = assistOn ? 'Ask AI' : 'Start'
  if (backend) return `${verb} · ${backend}`
  return assistOn ? verb : 'Start a session'
}

const SNIPPET_LEAD_CHARS = 24

function snippetLead(before: string): string {
  return before.length > SNIPPET_LEAD_CHARS ? `…${before.slice(-SNIPPET_LEAD_CHARS)}` : before
}

export type PaletteRouted = (prompt: string, backend: BackendId, route: SessionRoute | null) => void

export function CommandPalette({
  actions,
  onClose,
  onRouted,
  onOpenHit,
  methods
}: {
  actions: PaletteAction[]
  onClose: () => void
  onRouted: PaletteRouted
  onOpenHit: (hit: SessionSearchHit) => void
  methods: BackendId[]
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const assistOn = useStore((s) => !!s.settings.assist?.on)
  const [query, setQuery] = useState('')
  const [hot, setHot] = useState<number | null>(null)
  const [hotKey, setHotKey] = useState<string | null>(null)
  const [mode, setMode] = useState<'ask' | 'thinking' | 'search'>('ask')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [searchDone, setSearchDone] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const asking = useRef<ReturnType<typeof askRoute> | null>(null)

  const sessionItems = useMemo(
    () => paletteSessions(rows, sessions, tabs, attention),
    [rows, sessions, tabs, attention]
  )
  const workspaceItems = useMemo(() => paletteWorkspaces(rows, window.api.home), [rows])
  const showBackend = mixesBackends(sessionItems.map((s) => s.row))
  const groups = paletteGroups(sessionItems, workspaceItems, actions, query, hits)
  const visible = groups.flatMap((g) => g.items)
  const count = mode === 'search' ? hits.length : visible.length
  const keyAt = visible.findIndex((i) => i.key === hotKey)
  const picked = mode === 'search' ? (hot ?? 0) : keyAt < 0 ? null : keyAt
  const at = picked === null ? null : Math.min(picked, Math.max(0, count - 1))
  const typed = query.trim()
  const [primary, other] = methods
  const startIsDefault = mode === 'ask' && at === null && !!typed
  const pick = (i: number | null): void => {
    if (mode === 'search') setHot(i)
    else setHotKey(i === null ? null : visible[i].key)
  }

  const open = (item: PaletteItem | undefined): void => {
    if (!item || (item.kind === 'action' && item.disabled)) return
    if (item.kind === 'more') return search()
    if (item.kind === 'hit') return onOpenHit(item.hit)
    onClose()
    if (item.kind === 'session') openSessionRow(item.row, item.wsPath)
    else if (item.kind === 'workspace') useStore.getState().selectWorkspace(item.wsPath)
    else item.run()
  }

  const start = (backend: BackendId = primary): void => {
    if (mode !== 'ask' || !typed) return
    if (!assistOn) {
      onRouted(typed, backend, null)
      return
    }
    setMode('thinking')
    const ask = askRoute(typed)
    asking.current = ask
    void ask.result.then((route) => {
      if (asking.current !== ask) return
      asking.current = null
      onRouted(typed, backend, route)
    })
  }

  const stopAsking = (): void => {
    asking.current?.cancel()
    asking.current = null
  }

  const search = (): void => {
    if (!typed) return
    setMode('search')
    setHot(null)
  }

  useEffect(() => {
    inputRef.current?.focus()
    return () => stopAsking()
  }, [])

  useEffect(() => {
    if (!typed) return
    const id = ++lastSearchId
    setHits([])
    setSearchDone(false)
    const off = window.api.sessions.onSearchHits((found) => {
      if (found.searchId !== id) return
      if (found.hits.length)
        setHits((had) => [...had, ...found.hits].sort((a, b) => b.row.mtime - a.row.mtime))
      if (found.done) setSearchDone(true)
    })
    let sent = false
    const timer = setTimeout(() => {
      sent = true
      window.api.sessions.search(id, typed)
    }, SEARCH_AFTER_TYPING_MS)
    return () => {
      clearTimeout(timer)
      off()
      if (sent) window.api.sessions.search(++lastSearchId, '')
    }
  }, [typed])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (mode === 'thinking') stopAsking()
      if (mode === 'ask') onClose()
      else {
        setMode('ask')
        setHot(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onClose])

  useEffect(() => {
    listRef.current?.querySelector('.hot')?.scrollIntoView({ block: 'nearest' })
  }, [at, query, mode])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing(e)) return
    if (mode === 'thinking') {
      if (e.key === 'Enter') e.preventDefault()
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count > 0) {
      e.preventDefault()
      if (e.key === 'ArrowDown') pick(at === null ? 0 : Math.min(at + 1, count - 1))
      else pick(at ? at - 1 : null)
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    e.stopPropagation()
    if (e.altKey) search()
    else if (mode === 'search') {
      if (at !== null && hits[at]) onOpenHit(hits[at])
    } else if (at !== null && !e.shiftKey) open(visible[at])
    else start(e.shiftKey && other ? other : primary)
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
        {item.kind === 'hit' && (
          <>
            {showBackend && <SessionBackendIcon backend={item.hit.row.backendId} />}
            <span className="wsp-name">{item.hit.row.title}</span>
            {item.hit.snippet && (
              <span className="note">
                {snippetLead(item.hit.snippet.before)}
                <b>{item.hit.snippet.match}</b>
                {item.hit.snippet.after}
              </span>
            )}
          </>
        )}
        {item.kind === 'more' && (
          <>
            <span className="wsp-name">All {countLine(item.count)} that mention it</span>
            <span className="k">⌥⏎</span>
          </>
        )}
      </div>
    )
  }

  const now = Date.now()

  const results = (): JSX.Element | null => {
    if (mode === 'thinking')
      return (
        <div className="pal-status">
          <BusyLine>Working out who should take this…</BusyLine>
        </div>
      )
    if (mode === 'search')
      return (
        <div className="pal-results" ref={listRef}>
          <div className="pal-count">{searchDone ? countLine(hits.length) : 'Searching…'}</div>
          <div className="restore-list" role="listbox" aria-label="Conversations">
            {hits.map((h, i) => (
              <button
                key={h.row.id}
                className={'restore-row' + (i === at ? ' hot' : '')}
                role="option"
                aria-selected={i === at}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onOpenHit(h)}
              >
                <span className="restore-title">{h.row.title}</span>
                {h.snippet && (
                  <span className="restore-snippet">
                    {h.snippet.before}
                    <b>{h.snippet.match}</b>
                    {h.snippet.after}
                  </span>
                )}
                <span className="restore-meta">
                  <SessionBackendIcon backend={h.row.backendId} />
                  <span>
                    {workspaceLabel(h.workspacePath)} · {h.row.worktree} ·{' '}
                    {h.row.running ? 'running' : relTime(h.row.mtime, now)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )
    if (visible.length === 0) return null
    return (
      <div className="pal-results" role="listbox" aria-label="Results" ref={listRef}>
        {groups.map((g) => (
          <div key={g.title} role="group" aria-label={g.title}>
            <div className="cb-hd">{g.title}</div>
            {g.items.map(rowOf)}
          </div>
        ))}
      </div>
    )
  }

  const tips =
    mode === 'thinking'
      ? 'Esc cancel'
      : mode === 'search'
        ? '↓↑ move · ⏎ open · Esc back'
        : at !== null
          ? '↓↑ move · ⏎ open · Esc'
          : visible.length > 0
            ? '↓ pick a match · Esc'
            : 'Esc'

  return (
    <div className="modal-backdrop palette-top" onClick={onClose}>
      <div
        className="modal palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={'pal-ask' + (mode === 'thinking' ? ' waiting' : '')}>
          <span className="pal-glyph">
            {mode === 'search' ? <LuSearch size={18} /> : <LuSparkles size={18} />}
          </span>
          <textarea
            ref={inputRef}
            className="pal-field"
            rows={1}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              assistOn
                ? 'Ask or tell Koloft anything, or find a session to jump to…'
                : 'What should a new session do? Or find one to jump to…'
            }
            aria-label="Ask or jump"
            readOnly={mode === 'thinking'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHot(null)
              setHotKey(null)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {results()}
        <div className="pal-bar">
          <span className="pal-tips">{tips}</span>
          {mode === 'ask' && (
            <>
              <button
                className="pal-pill"
                disabled={!typed}
                onMouseDown={(e) => e.preventDefault()}
                onClick={search}
              >
                Search conversations <span className="k">⌥⏎</span>
              </button>
              <button
                className={'pal-pill' + (startIsDefault ? ' go' : '')}
                disabled={!typed}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => start(primary)}
              >
                <LuSparkles size={12} className="pal-pill-glyph" />{' '}
                {startLabel(assistOn, other && BACKEND_LABEL[primary])}
                {startIsDefault && <span className="k">⏎</span>}
              </button>
              {other && (
                <button
                  className="pal-pill"
                  disabled={!typed}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => start(other)}
                >
                  {BACKEND_LABEL[other]} <span className="k">⇧⏎</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

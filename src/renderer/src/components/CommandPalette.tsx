import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent
} from 'react'
import { IconAiStart, IconFolder, IconSearch } from '../icons'
import type { BackendId, SearchSnippet, SessionSearchHit } from '@shared/types'
import { routeInto, type SessionRoute } from '@shared/sessionRoute'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { basename } from '@shared/preview'
import { parseRemoteKey } from '@shared/remoteKey'
import { askRoute } from '../aiStart'
import { isComposing } from '../keys'
import {
  completeMention,
  mentionCandidates,
  mentionTyping,
  paletteGroups,
  paletteSessions,
  paletteWorkspaces,
  pinnedWorkspace,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
  type PaletteWorkspace
} from '../palette'
import { openSessionRow } from '../sessionClick'
import { mixesBackends, relTime } from '../sessionRows'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'
import { startOrList, type AgentChoice } from '../agentChoice'
import { BusyLine, SessionLaunchButtons } from './SessionLaunchButtons'
import '../commandPalette.css'
import '../workspaceSidebar.css'
import '../workspacePicker.css'
import '../restoreDialog.css'

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
const LONGEST_TEXT_SCANNED_WHILE_TYPING = 80

function worthScanningWhileTyping(typed: string): boolean {
  return (
    typed.length >= 2 && typed.length <= LONGEST_TEXT_SCANNED_WHILE_TYPING && !typed.includes('\n')
  )
}

function SnippetText({ snippet, short }: { snippet: SearchSnippet; short?: boolean }): JSX.Element {
  const lead =
    short && snippet.before.length > SNIPPET_LEAD_CHARS
      ? `…${snippet.before.slice(-SNIPPET_LEAD_CHARS)}`
      : snippet.before
  return (
    <>
      {lead}
      <b>{snippet.match}</b>
      {snippet.after}
    </>
  )
}

export type PaletteRouted = (prompt: string, backend: BackendId, route: SessionRoute | null) => void

export function CommandPalette({
  actions,
  onClose,
  onRouted,
  onOpenHit,
  choice
}: {
  actions: PaletteAction[]
  onClose: () => void
  onRouted: PaletteRouted
  onOpenHit: (hit: SessionSearchHit) => void
  choice: AgentChoice
}): JSX.Element {
  const rows = useStore((s) => s.workspaceRows)
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const attention = useStore((s) => s.attention)
  const assistOn = useStore((s) => !!s.settings.assist?.on)
  const [query, setQuery] = useState('')
  const [caret, setCaret] = useState(0)
  const caretAfterRender = useRef<number | null>(null)
  const [hotKey, setHotKey] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [mode, setMode] = useState<'ask' | 'thinking' | 'search'>('ask')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [searchDone, setSearchDone] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const asking = useRef<ReturnType<typeof askRoute> | null>(null)

  const sessionItems = useMemo(
    () => paletteSessions(rows, sessions, tabs, attention),
    [rows, sessions, tabs, attention]
  )
  const workspaceItems = useMemo(() => paletteWorkspaces(rows, window.api.home), [rows])
  const showBackend = mixesBackends(sessionItems.map((s) => s.row))
  const pin = pinnedWorkspace(query, workspaceItems)
  const typed = (pin ? pin.prompt : query).trim()
  const tagging = mode === 'ask' ? mentionTyping(query, caret) : null
  const suggestions = tagging ? mentionCandidates(workspaceItems, tagging.typed) : []
  const suggesting = suggestions.length > 0
  const scan = mode === 'search' || (!composing && !tagging && worthScanningWhileTyping(typed))
  const groups: PaletteGroup[] = suggesting
    ? [{ title: 'Workspaces', items: suggestions }]
    : paletteGroups(sessionItems, workspaceItems, actions, typed, scan ? hits : [])
  const visible = groups.flatMap((g) => g.items)
  const keys = mode === 'search' ? hits.map((h) => h.row.id) : visible.map((i) => i.key)
  const count = keys.length
  const keyAt = keys.indexOf(hotKey ?? '')
  const at = keyAt >= 0 ? keyAt : (mode === 'search' || suggesting) && count > 0 ? 0 : null
  const startIsDefault = mode === 'ask' && at === null && !!typed
  const pick = (i: number | null): void => setHotKey(i === null ? null : keys[i])

  const complete = (ws: PaletteWorkspace): void => {
    if (!tagging) return
    const done = completeMention(query, tagging, ws.tag)
    caretAfterRender.current = done.caret
    setQuery(done.text)
    setCaret(done.caret)
    setHotKey(null)
  }

  const open = (item: PaletteItem | undefined): void => {
    if (!item || (item.kind === 'action' && item.disabled)) return
    if (suggesting && item.kind === 'workspace') return complete(item)
    if (item.kind === 'more') return search()
    if (item.kind === 'hit') return onOpenHit(item.hit)
    onClose()
    if (item.kind === 'session') openSessionRow(item.row, item.wsPath)
    else if (item.kind === 'workspace') useStore.getState().selectWorkspace(item.wsPath)
    else item.run()
  }

  const start = (backend: BackendId = choice.lead): void => {
    if (mode !== 'ask' || !typed) return
    const place = (route: SessionRoute | null): SessionRoute | null =>
      pin ? routeInto(route, pin.wsPath) : route
    if (!assistOn) {
      onRouted(typed, backend, place(null))
      return
    }
    setMode('thinking')
    const ask = askRoute(typed, pin?.wsPath)
    asking.current = ask
    void ask.result.then((route) => {
      if (asking.current !== ask) return
      asking.current = null
      onRouted(typed, backend, place(route))
    })
  }

  const stopAsking = (): void => {
    asking.current?.cancel()
    asking.current = null
  }

  const search = (): void => {
    if (!typed) return
    setMode('search')
    setHotKey(null)
  }

  useEffect(() => {
    inputRef.current?.focus()
    return () => stopAsking()
  }, [])

  useEffect(() => {
    if (!typed || !scan) return
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
  }, [typed, scan])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (mode === 'thinking') stopAsking()
      if (mode === 'ask') onClose()
      else {
        setMode('ask')
        setHotKey(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onClose])

  useEffect(() => {
    listRef.current?.querySelector('.hot')?.scrollIntoView({ block: 'nearest' })
  }, [at, query, mode])

  useLayoutEffect(() => {
    const to = caretAfterRender.current
    if (to === null) return
    caretAfterRender.current = null
    inputRef.current?.setSelectionRange(to, to)
  }, [query])

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
    if (e.key === 'Tab' && suggesting) {
      e.preventDefault()
      complete(suggestions[at ?? 0])
      return
    }
    if (e.key !== 'Enter' || (e.shiftKey && mode === 'ask')) return
    e.preventDefault()
    e.stopPropagation()
    if (e.altKey) search()
    else if (mode === 'search') {
      if (at !== null && hits[at]) onOpenHit(hits[at])
    } else if (at !== null && !e.metaKey) open(visible[at])
    else startOrList({ shiftKey: e.metaKey }, choice, start, () => typed && setListOpen(true))
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
              <IconFolder size={15} />
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
                <SnippetText snippet={item.hit.snippet} short />
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
                    <SnippetText snippet={h.snippet} />
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
        : suggesting
          ? '↓↑ move · ⏎ pick · Esc'
          : at !== null
            ? '↓↑ move · ⏎ open · Esc'
            : visible.length > 0
              ? '↓ pick a match · Esc'
              : '@ workspace · ⇧⏎ new line · Esc'

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
            {mode === 'search' ? <IconSearch size={18} /> : <IconAiStart size={18} />}
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
              setCaret(e.target.selectionStart)
              setHotKey(null)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
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
              <SessionLaunchButtons
                choice={choice}
                open={listOpen}
                onOpen={setListOpen}
                className={'pal-pill' + (startIsDefault ? ' go' : '')}
                icon={false}
                keyHint={startIsDefault}
                busy={false}
                disabled={!typed}
                label={(backend) => (
                  <>
                    <IconAiStart size={12} className="pal-pill-glyph" />{' '}
                    {startLabel(
                      assistOn,
                      choice.listed.length > 1 ? BACKEND_LABEL[backend] : undefined
                    )}
                  </>
                )}
                onStart={start}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

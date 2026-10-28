import { memo, useLayoutEffect, useRef, useState, type JSX } from 'react'
import {
  IconClose,
  IconFile,
  IconFiles,
  IconPlus,
  IconSoundOff,
  IconSoundOn,
  IconTerminal,
  IconWebPage
} from '../icons'
import type { BrowserAudioState, GithubInfo, GithubTarget } from '@shared/types'
import { CHANGES_MSG, type ChangeTotals } from './changesModel'
import { FilesTabLabel } from './FilesTabLabel'
import type { ChecksDot } from './prChecksView'
import { GithubButton } from './workbenchGithub'
import { tabLabel, type WorkbenchTab, type WorkbenchTabSet } from './workbenchTabs'

export type TabAudio = Record<string, Pick<BrowserAudioState, 'audible' | 'muted'>>

function pressOnTabControl(e: { stopPropagation(): void; preventDefault(): void }): void {
  e.stopPropagation()
  e.preventDefault()
}

export function keepCaretInSessionTerminal(e: { preventDefault(): void }): void {
  if (document.activeElement?.closest('.term-island .xterm')) e.preventDefault()
}

function iconFor(t: WorkbenchTab): JSX.Element {
  return t.kind === 'files' ? (
    <IconFiles size={13} />
  ) : t.kind === 'terminal' ? (
    <IconTerminal size={12} />
  ) : t.kind === 'web' ? (
    <IconWebPage size={12} />
  ) : (
    <IconFile size={12} />
  )
}

export const WorkbenchTabStrip = memo(function WorkbenchTabStrip({
  set,
  live,
  everLive,
  pinnedIds,
  dirtyIds,
  audio,
  totals,
  driving,
  github,
  githubDot,
  githubLabel,
  onGithubOpen,
  onGithubMenu,
  onActivate,
  onClose,
  onToggleMute,
  onMove,
  onNewMenu
}: {
  set: WorkbenchTabSet
  live: string[]
  everLive: ReadonlySet<string>
  pinnedIds: ReadonlySet<string>
  dirtyIds: ReadonlySet<string>
  audio: TabAudio
  totals: ChangeTotals | null
  driving: boolean
  github: GithubInfo | null
  githubDot: ChecksDot | null
  githubLabel: string
  onGithubOpen: (what: GithubTarget) => void
  onGithubMenu: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onToggleMute: (id: string) => void
  onMove: (id: string, to: number) => void
  onNewMenu: () => void
}): JSX.Element {
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const [heldWidths, setHeldWidths] = useState<Record<string, number> | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!heldWidths || !stripRef.current) return
    let next = heldWidths
    for (const el of stripRef.current.querySelectorAll<HTMLElement>('.wb-tab:not(.pinned)')) {
      const id = el.dataset.wbTabId
      if (id && !(id in next)) next = { ...next, [id]: el.getBoundingClientRect().width }
    }
    if (next !== heldWidths) setHeldWidths(next)
  })

  const dropTab = (to: number): void => {
    const id = drag?.id
    setDrag(null)
    if (id) onMove(id, to)
  }

  const renderTab = (t: WorkbenchTab, i: number): JSX.Element => (
    <span
      key={t.id}
      className={
        'wb-tab' +
        (t.kind === 'files' ? ' pinned' : '') +
        (t.id === set.activeId ? ' on' : '') +
        (t.unread ? ' agent' : '') +
        (t.kind === 'web' && pinnedIds.has(t.id) ? ' driven' : '') +
        (t.kind === 'web' && !live.includes(t.id) && everLive.has(t.id) ? ' frozen' : '') +
        (drag?.id === t.id ? ' dragging' : '') +
        (drag && drag.over === i && drag.id !== t.id ? ' dropbefore' : '')
      }
      title={
        t.kind === 'files' && totals?.files
          ? CHANGES_MSG.totals(totals)
          : t.url || t.path || undefined
      }
      data-wb-tab-id={t.id}
      style={
        heldWidths && t.id in heldWidths ? { width: heldWidths[t.id], flexShrink: 0 } : undefined
      }
      onMouseDown={(e) => {
        if (t.kind === 'files') keepCaretInSessionTerminal(e)
        onActivate(t.id)
      }}
      draggable={t.kind !== 'files'}
      onDragStart={(e) => {
        if (t.kind === 'files') return
        e.dataTransfer.effectAllowed = 'move'
        // PLATFORM§10
        e.dataTransfer.setData('text/plain', t.id)
        setDrag({ id: t.id, over: i })
      }}
      onDragOver={(e) => {
        if (!drag) return
        e.preventDefault()
        if (drag.over !== i) setDrag({ ...drag, over: i })
      }}
      onDrop={(e) => {
        e.preventDefault()
        dropTab(i)
      }}
      data-drop-index={i}
      onDragEnd={() => setDrag(null)}
    >
      <span className="ic">{iconFor(t)}</span>
      {t.kind === 'files' ? (
        <FilesTabLabel totals={totals} />
      ) : (
        <span className="lb">{tabLabel(set, t)}</span>
      )}
      {(audio[t.id]?.audible || audio[t.id]?.muted) && (
        <span
          className={'btab-spk' + (audio[t.id]?.muted ? ' muted' : '')}
          title={audio[t.id]?.muted ? 'Unmute tab' : 'Mute tab'}
          aria-label={audio[t.id]?.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={pressOnTabControl}
          onClick={() => onToggleMute(t.id)}
        >
          {audio[t.id]?.muted ? <IconSoundOff size={13} /> : <IconSoundOn size={13} />}
        </span>
      )}
      {t.kind !== 'files' && (
        <span
          className="x"
          title="Close tab"
          aria-label="Close tab"
          onMouseDown={pressOnTabControl}
          onClick={() => onClose(t.id)}
        >
          {dirtyIds.has(t.id) ? (
            <>
              <span className="dirty" title="Unsaved changes" />
              <span className="xhov">
                <IconClose size={12} />
              </span>
            </>
          ) : (
            <IconClose size={12} />
          )}
        </span>
      )}
    </span>
  )

  return (
    <div
      ref={stripRef}
      className="wb-tabs"
      onMouseEnter={() => setHeldWidths({})}
      onMouseLeave={() => setHeldWidths(null)}
      onWheel={(e) => {
        const strip = e.currentTarget
        if (strip.scrollWidth <= strip.clientWidth) return
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
        e.preventDefault()
        strip.scrollLeft += e.deltaY
      }}
    >
      <div className="wb-pin">
        {set.tabs[0] && renderTab(set.tabs[0], 0)}
        {github && (
          <GithubButton
            info={github}
            dot={githubDot}
            label={githubLabel}
            onOpen={onGithubOpen}
            onMenu={onGithubMenu}
          />
        )}
        {set.tabs.length > 1 && <span className="wb-sep" />}
      </div>
      {set.tabs.slice(1).map((t, i) => renderTab(t, i + 1))}
      <div className="wb-drag" />
      <div className="wb-spill">
        <button className="wb-new" aria-label="New tab" title="New tab ⌘T" onClick={onNewMenu}>
          <IconPlus size={14} />
        </button>
        {driving && (
          <span className="bdriven" title="A CDP client is driving tabs in this session">
            agent driving
          </span>
        )}
      </div>
    </div>
  )
})

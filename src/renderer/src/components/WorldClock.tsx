import { memo, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { LuPlus, LuX } from 'react-icons/lu'
import { popoverX } from '@shared/accountUsage'
import { WORLD_CLOCK_MAX } from '@shared/types'
import { useStore } from '../store'
import { cityOf, cityZones, dayDelta, formatTime, matchZones, zoneTitle } from '../worldClock'
import { useSettingsUpdate } from './settings/useSettingsUpdate'

const POP_W = 300

function Chip({
  tz,
  now,
  local,
  title,
  onRemove
}: {
  tz: string
  now: Date
  local: string
  title: string
  onRemove?: () => void
}): JSX.Element {
  const delta = dayDelta(tz, now, local)
  return (
    <span className="wc-chip" title={title}>
      <span className="wc-city">{cityOf(tz)}</span>
      <span className="wc-time">{formatTime(tz, now)}</span>
      {delta !== 0 && <span className="wc-day">{delta > 0 ? '+1' : '−1'}</span>}
      {onRemove && (
        <button className="wc-x" aria-label={`Remove ${cityOf(tz)}`} onClick={onRemove}>
          <LuX size={10} />
        </button>
      )}
    </span>
  )
}

export const WorldClock = memo(function WorldClock(): JSX.Element {
  const zones = useStore((s) => s.settings.worldClocks)
  const update = useSettingsUpdate()
  const [now, setNow] = useState(() => new Date())
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const addRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let every: ReturnType<typeof setInterval> | null = null
    const first = setTimeout(
      () => {
        setNow(new Date())
        every = setInterval(() => setNow(new Date()), 60_000)
      },
      60_000 - (Date.now() % 60_000)
    )
    return () => {
      clearTimeout(first)
      if (every) clearInterval(every)
    }
  }, [])

  useEffect(() => {
    if (!pop) return
    const close = (): void => setPop(null)
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [pop])

  const all = useMemo(() => cityZones(Intl.supportedValuesOf('timeZone')), [])
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  const hits = matchZones(query, all, [local, ...zones])
  const room = zones.length < WORLD_CLOCK_MAX

  const add = (tz: string): void => {
    if (room) update({ worldClocks: [...zones, tz] })
    setPop(null)
  }
  const open = (): void => {
    const r = addRef.current?.getBoundingClientRect()
    if (!r) return
    setQuery('')
    setCursor(0)
    setPop({ x: popoverX(r.left + POP_W / 2, POP_W, window.innerWidth), y: r.bottom + 4 })
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && hits[cursor]) {
      add(hits[cursor])
    }
  }

  return (
    <div className="wc">
      <Chip tz={local} now={now} local={local} title={`${local} · Local time`} />
      {zones.length > 0 && <span className="wc-sep" />}
      {zones.map((tz) => (
        <Chip
          key={tz}
          tz={tz}
          now={now}
          local={local}
          title={zoneTitle(tz, now, local)}
          onRemove={() => update({ worldClocks: zones.filter((z) => z !== tz) })}
        />
      ))}
      {room && (
        <button
          ref={addRef}
          className="ibtn wc-add"
          title="Add time zone"
          aria-label="Add time zone"
          aria-expanded={pop !== null}
          onClick={(e) => {
            e.stopPropagation()
            if (pop) setPop(null)
            else open()
          }}
        >
          <LuPlus size={14} />
        </button>
      )}
      {pop &&
        createPortal(
          <div
            className="menu wc-pop"
            style={{ left: pop.x, top: pop.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tbu-pop-head">
              Add time zone · {zones.length + 1} / {WORLD_CLOCK_MAX + 1}
            </div>
            <input
              ref={inputRef}
              className="set-input wc-input"
              placeholder="Search city or time zone…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              onKeyDown={onKey}
              spellCheck={false}
            />
            {hits.length > 0 && (
              <ul className="wc-list" role="listbox">
                {hits.map((tz, i) => (
                  <li
                    key={tz}
                    role="option"
                    aria-selected={i === cursor}
                    className={'wc-item' + (i === cursor ? ' on' : '')}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => add(tz)}
                  >
                    <span className="wc-item-city">
                      {cityOf(tz)}
                      <small>{tz}</small>
                    </span>
                    <span className="wc-item-now">{formatTime(tz, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body
        )}
    </div>
  )
})

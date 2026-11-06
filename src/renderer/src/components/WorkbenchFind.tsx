import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject
} from 'react'
import { useDomFind, type FindCount } from '../useDomFind'
import type { GuestElement } from './BrowserGuest'
import { FindBar } from './FindBar'

export function WorkbenchFind({
  els,
  bodies,
  activeId,
  web,
  live,
  focusTick,
  onClose
}: {
  els: RefObject<Map<string, GuestElement>>
  bodies: RefObject<Map<string, HTMLElement>>
  activeId: string | undefined
  web: boolean
  live: string[]
  focusTick: number
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [guestCount, setGuestCount] = useState<FindCount>({ current: 0, total: 0 })
  const getRoot = useCallback(
    (): HTMLElement | null => (activeId ? (bodies.current.get(activeId) ?? null) : null),
    [activeId, bodies]
  )
  const dom = useDomFind(getRoot)

  const searchGuest = useCallback(
    (q: string, options?: { forward?: boolean; findNext?: boolean }): void => {
      const el = activeId ? els.current.get(activeId) : undefined
      if (!el) return
      try {
        if (!q) {
          el.stopFindInPage('clearSelection')
          setGuestCount({ current: 0, total: 0 })
          return
        }
        el.findInPage(q, options ?? { findNext: true })
      } catch {}
    },
    [activeId, els]
  )

  useLayoutEffect(() => {
    if (!focusTick) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  useEffect(() => {
    const el = activeId ? els.current.get(activeId) : undefined
    if (!el) return
    const onFound = (e: Event): void => {
      const r = (e as Event & { result?: { activeMatchOrdinal: number; matches: number } }).result
      if (r) setGuestCount({ current: r.activeMatchOrdinal, total: r.matches })
    }
    el.addEventListener('found-in-page', onFound)
    return () => el.removeEventListener('found-in-page', onFound)
  }, [activeId, live, els])

  return (
    <FindBar
      inputRef={inputRef}
      query={query}
      onQueryChange={(q) => {
        setQuery(q)
        if (web) searchGuest(q)
        else dom.search(q)
      }}
      count={web ? guestCount : dom.count}
      onNext={() => (web ? searchGuest(query, { findNext: false, forward: true }) : dom.next())}
      onPrev={() => (web ? searchGuest(query, { findNext: false, forward: false }) : dom.prev())}
      onClose={onClose}
    />
  )
}

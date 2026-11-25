import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { IconReload, IconSettings } from '../icons'
import type { AccountView } from '@shared/types'
import { autoProbeDue, popoverX } from '@shared/accountUsage'
import { useStore } from '../store'
import { ShapePill, ShapeSections, groupsSpoken, oldestShown, shownGroups } from './usageFromShape'
import '../topbarUsage.css'
import '../accounts.css'

const POP_W = 430
const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 220

function headAge(oldest: number | null, now: number): string {
  if (oldest === null) return 'not probed yet'
  const mins = Math.floor((now - oldest) / 60_000)
  if (mins < 2) return 'updated just now'
  return mins < 60 ? `updated ${mins}m ago` : `updated ${Math.floor(mins / 60)}h ago`
}

export function TopbarUsage(): JSX.Element | null {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [all, setAccounts] = useState<AccountView[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [pop, setPop] = useState<{ x: number; bottom: number } | null>(null)
  const [probing, setProbing] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickedShut = useRef(false)
  const lastAutoProbe = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const apply = (next: AccountView[]): void => {
      if (alive) setAccounts(next)
    }
    const off = window.api.accounts.onUpdate(apply)
    void window.api.accounts.list().then(apply)
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const probe = useCallback(async (): Promise<void> => {
    lastAutoProbe.current = Date.now()
    setProbing(true)
    try {
      setAccounts(await window.api.accounts.probe())
    } catch {
    } finally {
      setProbing(false)
    }
  }, [])

  const accountsRef = useRef(all)
  accountsRef.current = all
  useEffect(() => {
    if (!pop) return
    if (autoProbeDue(accountsRef.current, lastAutoProbe.current, Date.now())) void probe()
  }, [pop, probe])

  // PLATFORM§25
  useLayoutEffect(() => {
    if (!pop) return
    const close = (): void => setPop(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [pop])

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    },
    []
  )

  const groups = shownGroups(all, now)
  if (groups.length === 0) return null

  const schedule = (ms: number, fn: () => void): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(fn, ms)
  }
  const cancel = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const enter = (): void => {
    if (!clickedShut.current) schedule(HOVER_OPEN_MS, open)
  }
  const leave = (): void => {
    clickedShut.current = false
    closeSoon()
  }
  const open = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    setPop({
      x: popoverX(r.left + r.width / 2, POP_W, window.innerWidth),
      bottom: window.innerHeight - r.top + 6
    })
  }
  const closeSoon = (): void => schedule(HOVER_CLOSE_MS, () => setPop(null))

  return (
    <div className="tbu-slot">
      <button
        ref={btnRef}
        className="tbu"
        aria-label={groupsSpoken(groups)}
        aria-expanded={pop !== null}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={(e: ReactMouseEvent) => {
          e.stopPropagation()
          cancel()
          if (!pop) {
            open()
            return
          }
          clickedShut.current = e.detail > 0
          setPop(null)
        }}
      >
        <ShapePill groups={groups} now={now} />
      </button>
      {/* ADR-0013 */}
      {pop &&
        createPortal(
          <div
            className="tbu-pop"
            style={{ left: pop.x, bottom: pop.bottom }}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={cancel}
            onMouseLeave={closeSoon}
          >
            <div className="tbu-pop-head">
              <span>Account usage</span>
              <span className="age">{headAge(oldestShown(all, now), now)}</span>
            </div>
            <div className="tbu-rows">
              <ShapeSections
                groups={groups}
                now={now}
                probing={probing}
                onAct={(a, action) => window.api.accounts.act(a.kind, a.name, action)}
              />
            </div>
            <div className="tbu-sep" />
            <button className="tbu-act" disabled={probing} onClick={() => void probe()}>
              <IconReload size={14} />
              {probing ? 'Probing…' : 'Probe now'}
              <span className="k">1–2 requests per account</span>
            </button>
            <button
              className="tbu-act"
              onClick={() => {
                setPop(null)
                setSettingsOpen(true)
              }}
            >
              <IconSettings size={14} />
              Account settings…
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

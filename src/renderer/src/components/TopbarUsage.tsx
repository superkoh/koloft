import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { LuRotateCw, LuSettings } from 'react-icons/lu'
import type { AccountView } from '@shared/types'
import {
  accountWalled,
  autoProbeDue,
  capsuleAria,
  capsuleGlyph,
  meteredArmed,
  oldestAt,
  poolGlyph,
  poolSnapshot,
  popoverX,
  sublineFor,
  type CapsuleGlyph
} from '@shared/accountUsage'
import { useStore } from '../store'
import { Meter, ageLabel, probeErrorLabel, resetIn, resetLabel } from './accountMeter'

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
  const multiAccount = useStore((s) => s.settings.multiAccount)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [accounts, setAccounts] = useState<AccountView[]>([])
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

  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  useEffect(() => {
    if (!pop) return
    if (autoProbeDue(accountsRef.current, lastAutoProbe.current, Date.now())) void probe()
  }, [pop, probe])

  useEffect(() => {
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

  const members = accounts.filter((a) => a.kind === 'oauth' && a.enabled)
  if (!multiAccount || members.length === 0) return null

  const enabled = accounts.filter((a) => a.enabled)
  const armed = meteredArmed(accounts, Math.floor(now / 1000))
  const total = poolGlyph(members, now)
  const cols = enabled.some((a) => a.kind === 'oauth' && a.status === 'ok' && a.usage?.hasOi)
    ? 3
    : 2

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
        aria-label={capsuleAria(members, now)}
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
        {total && <CapsuleBar glyph={total} total />}
        {members.map((a) => (
          <CapsuleBar key={`${a.kind}:${a.name}`} glyph={capsuleGlyph(a, now)} />
        ))}
        {armed && (
          <span className="tbu-bar" title="Every subscription is walled — metered fallback active">
            <i className="tbu-fill acc" style={{ height: '100%' }} />
          </span>
        )}
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
              <span>Claude account usage</span>
              <span className="age">{headAge(oldestAt(enabled), now)}</span>
            </div>
            <div className={'tbu-grid tbu-colhead' + (cols === 2 ? ' two' : '')} aria-hidden>
              <span>5h</span>
              <span>7d</span>
              {cols === 3 && <span>fable</span>}
            </div>
            {members.length >= 2 && (
              <>
                <PoolRow members={members} now={now} cols={cols} probing={probing} armed={armed} />
                <div className="tbu-sep" />
              </>
            )}
            <div className="tbu-rows">
              {enabled.map((a) => (
                <PopRow key={`${a.kind}:${a.name}`} a={a} now={now} cols={cols} />
              ))}
            </div>
            <div className="tbu-sep" />
            <button className="tbu-act" disabled={probing} onClick={() => void probe()}>
              <LuRotateCw size={14} />
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
              <LuSettings size={14} />
              Account settings…
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

function CapsuleBar({ glyph: g, total }: { glyph: CapsuleGlyph; total?: boolean }): JSX.Element {
  const stale = (g.kind === 'walled' || g.kind === 'bar') && g.stale
  const fillPct = g.kind === 'bar' ? Math.round(g.frac * 100) : 0
  const fable = g.kind === 'bar' && g.fable && g.fable.frac > g.frac ? g.fable : null
  return (
    <span className={'tbu-bar' + (total ? ' total' : '') + (stale ? ' stale' : '')}>
      {g.kind === 'grey' && <i className="tbu-fill cold" style={{ height: '100%' }} />}
      {g.kind === 'walled' && <i className="tbu-fill bad" style={{ height: '100%' }} />}
      {fable && (
        <i
          className="tbu-fable"
          style={{ height: fable.spent ? '100%' : `${Math.round(fable.frac * 100)}%` }}
        />
      )}
      {g.kind === 'bar' && (
        <i
          className={'tbu-fill' + (g.level ? ` ${g.level}` : '')}
          style={{ height: `${fillPct}%` }}
        />
      )}
      {fable && <i className="tbu-gap" style={{ bottom: `${fillPct}%` }} />}
    </span>
  )
}

type Subline = ReturnType<typeof sublineFor>

function stamp(win: string, epoch: number, now: number): string {
  return win === '5h' ? resetIn(epoch, now) : resetLabel(epoch, now)
}

function subText(win: string, s: Subline, now: number): string {
  switch (s.kind) {
    case 'time':
      return stamp(win, s.epoch, now)
    case 'back':
      return `back ${stamp(win, s.epoch, now)}`
    case 'due':
      return 'due'
    case 'walled':
      return 'walled'
    case 'spent':
      return s.epoch > 0 ? `spent · ${resetLabel(s.epoch, now)}` : 'spent'
    default:
      return ''
  }
}

function spoken(win: string, epoch: number, now: number): string {
  return win === '5h' ? resetIn(epoch, now) : `at ${resetLabel(epoch, now)}`
}

function subAria(label: string, win: string, s: Subline, now: number): string {
  switch (s.kind) {
    case 'time':
      return `${label} resets ${spoken(win, s.epoch, now)}`
    case 'back':
      return s.tone === 'red'
        ? `${label} walled, back ${spoken(win, s.epoch, now)}`
        : `${label} rate limited, back ${spoken(win, s.epoch, now)}`
    case 'due':
      return `${label} rate limited, reset due`
    case 'walled':
      return `${label} walled, no reset time`
    case 'spent':
      return s.epoch > 0
        ? `${label} allowance spent, resets at ${resetLabel(s.epoch, now)}`
        : `${label} allowance spent`
    default:
      return `${label} has no reset time`
  }
}

function GridCell({
  label,
  win,
  v,
  soi,
  sub,
  now
}: {
  label: string
  win: string
  v: number
  soi?: string
  sub: Subline
  now: number
}): JSX.Element {
  const tone = sub.tone === 'red' ? ' alarm' : sub.tone === 'amber' ? ' soon' : ''
  return (
    <div className="tbu-cell" role="group" aria-label={subAria(label, win, sub, now)}>
      <Meter v={v} win={win} soi={soi} />
      <span className={'tbu-cell-sub' + tone} aria-hidden>
        {subText(win, sub, now)}
      </span>
    </div>
  )
}

function PoolRow({
  members,
  now,
  cols,
  probing,
  armed
}: {
  members: AccountView[]
  now: number
  cols: number
  probing: boolean
  armed: boolean
}): JSX.Element {
  const p = poolSnapshot(members, now)
  const age = p.oldestAt === null ? null : ageLabel(p.oldestAt, now)
  const fallback = armed && p.usable === 0
  return (
    <div
      className="tbu-row pool"
      role="group"
      aria-label={
        `Pool: ${p.measured} measured, ${p.usable} usable` +
        (p.walled > 0 ? `, ${p.walled} walled` : '')
      }
    >
      <div className="tbu-row-head">
        <span className="acct-name">Pool</span>
        <span className={'tbu-pool-meta' + (fallback ? ' armed' : '')}>
          {p.measured} measured · {fallback ? 'metered fallback active' : `${p.usable} usable`}
        </span>
        {probing ? (
          <span className="tbu-age">Probing…</span>
        ) : (
          age && <span className="tbu-age">{age}</span>
        )}
      </div>
      <div className={'tbu-grid' + (cols === 2 ? ' two' : '')}>
        {p.measured >= 2 ? (
          <>
            <div className="tbu-cell">
              <Meter v={p.t5} win="5h" />
            </div>
            <div className="tbu-cell">
              <Meter v={p.t7} win="7d" />
            </div>
            {cols === 3 &&
              (p.tfable !== null ? (
                <div className="tbu-cell">
                  <Meter v={p.tfable} win="oi" />
                </div>
              ) : (
                <div className="tbu-cell" />
              ))}
            {p.walled > 0 && (
              <div className="tbu-cell span">
                <span className="tbu-cell-sub alarm">
                  {p.walled} walled
                  {p.walled >= 2 && p.earliestBack !== null
                    ? ` · earliest back ${resetLabel(p.earliestBack, now)}`
                    : ''}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="tbu-cell span">
            <span className="tbu-cell-sub">
              {p.measured === 1 ? 'only 1 account measured' : 'Not probed yet'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function PopRow({ a, now, cols }: { a: AccountView; now: number; cols: number }): JSX.Element {
  const u = a.usage
  const nowSec = Math.floor(now / 1000)
  const stale = u ? ageLabel(u.at, now) : null
  const dead = a.status !== 'ok'
  const walled = !dead && u != null && accountWalled(u, nowSec)
  return (
    <div className={'tbu-row' + (dead ? ' dim' : '')}>
      <div className="tbu-row-head">
        <span className="acct-name" title={a.name}>
          {a.name}
        </span>
        {a.kind === 'apikey' && <span className="acct-badge api">API KEY</span>}
        {a.kind === 'custom' && <span className="acct-badge api">ENDPOINT</span>}
        {a.kind === 'oauth' && a.fable === 'yes' && <span className="acct-badge fable">FABLE</span>}
        {a.status === 'expired' && <span className="acct-status expired">EXPIRED</span>}
        {a.status === 'unverified' && <span className="acct-status unverified">UNVERIFIED</span>}
        {walled && <span className="acct-status walled">WALLED</span>}
        {stale && <span className="tbu-age">{stale}</span>}
      </div>
      {a.kind === 'apikey' ? (
        <div className="tbu-row-note">
          <span className="acct-note">
            Metered — used only when every subscription is rate-limited
          </span>
        </div>
      ) : a.kind === 'custom' ? (
        <div className="tbu-row-note">
          <span className="acct-note">
            {a.baseUrl}
            {a.model ? ` · ${a.model}` : ''} · used only when every subscription is rate-limited
          </span>
        </div>
      ) : dead ? (
        <div className="tbu-row-note">
          <span className="acct-note">
            {a.status === 'expired'
              ? 'Token expired — sign in again from Settings'
              : 'Not verified yet — sign in from Settings'}
          </span>
        </div>
      ) : u ? (
        <div className={'tbu-grid' + (cols === 2 ? ' two' : '')}>
          <GridCell label="5h" win="5h" v={u.u5} sub={sublineFor('5h', u, nowSec)} now={now} />
          <GridCell label="7d" win="7d" v={u.u7} sub={sublineFor('7d', u, nowSec)} now={now} />
          {cols === 3 &&
            (u.hasOi ? (
              <GridCell
                label="fable"
                win="oi"
                v={u.uoi}
                soi={u.soi}
                sub={sublineFor('oi', u, nowSec)}
                now={now}
              />
            ) : (
              <div className="tbu-cell" />
            ))}
          {a.probeError && (
            <div className="tbu-cell span">
              <span className="tbu-cell-sub">{probeErrorLabel(a.probeError)}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="tbu-row-note">
          <span className="acct-note">
            {a.probeError ? probeErrorLabel(a.probeError) : 'Not probed yet'}
          </span>
        </div>
      )}
    </div>
  )
}

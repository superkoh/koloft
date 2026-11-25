import type { JSX } from 'react'
import type { AccountView, CodexLimits } from '@shared/types'
import { FABLE_STOP, meterLevel, type MeterLevel } from '@shared/accountUsage'
import { probeErrorLabel, resetLabel } from '@shared/usageWords'
import '../accounts.css'

export { probeErrorLabel, resetIn, resetLabel } from '@shared/usageWords'

const FABLE_WARN_AT = 0.85

export function ageLabel(at: number, nowMs: number): string | null {
  const mins = Math.floor((nowMs - at) / 60_000)
  return mins >= 2 ? `cached ${mins}m` : null
}

export function ApiKeyBadge(): JSX.Element {
  return <span className="acct-badge api">API KEY</span>
}

export function noLimitsLabel(a: AccountView): string {
  if (a.probeError) return probeErrorLabel(a.probeError)
  return a.kind === 'agy-home' ? 'Signed in' : 'Not probed yet'
}

// CODEX§15
export function codexBalanceLabel(l: CodexLimits, nowMs: number): string {
  const parts: string[] = []
  if (l.credits?.unlimited) parts.push('unlimited credits')
  else if (l.credits?.balance !== undefined)
    parts.push(`${Math.floor(l.credits.balance).toLocaleString('en-US')} credits`)
  if (l.resets) {
    const n = l.resets.available
    parts.push(
      n === 0
        ? 'no resets saved'
        : `${n} reset${n === 1 ? '' : 's'} saved` +
            (l.resets.firstExpiresAt
              ? `, ${n === 1 ? 'expires' : 'first expires'} ${resetLabel(l.resets.firstExpiresAt, nowMs)}`
              : '')
    )
  }
  return parts.join(' · ')
}

// CC§7
export function fableLevel(v: number, soi: string): MeterLevel {
  if (soi === 'rejected') return 'bad'
  return v >= FABLE_STOP ? 'bad' : v >= FABLE_WARN_AT ? 'warn' : ''
}

export function Meter({
  label,
  v,
  win,
  soi
}: {
  label?: string
  v: number | null
  win: string
  soi?: string
}): JSX.Element {
  if (v === null) return <MeterBar label={label} v={v} win={win} level="" />
  const level = win === 'oi' ? fableLevel(v, soi ?? '?') : meterLevel(v)
  return <MeterBar label={label} v={v} win={win} level={level} />
}

export function MeterBar({
  label,
  v,
  win,
  level
}: {
  label?: string
  v: number | null
  win: string
  level: MeterLevel
}): JSX.Element {
  if (v === null)
    return (
      <span className="acct-meter none" data-win={win}>
        {label && <span className="m-label">{label}</span>}
        <span className="m-track" />
        <span className="m-pct">—</span>
      </span>
    )
  const pct = Math.min(100, Math.round(v * 100))
  return (
    <span className={'acct-meter' + (level ? ` ${level}` : '')} data-win={win}>
      {label && <span className="m-label">{label}</span>}
      <span className="m-track">
        <span className="m-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="m-pct">{pct}%</span>
    </span>
  )
}

export function QuotaMeters({
  quota,
  now
}: {
  quota: NonNullable<AccountView['quota']>
  now: number
}): JSX.Element {
  return (
    <div className="acct-meters">
      {quota.map((q) => (
        <Meter key={q.label} label={q.label} v={q.used} win="" />
      ))}
      {quota[0]?.resetsAt ? (
        <span className="acct-note">
          {quota[0].label} resets {resetLabel(quota[0].resetsAt, now)}
        </span>
      ) : null}
    </div>
  )
}

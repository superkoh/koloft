import type { JSX } from 'react'
import type { AccountView } from '@shared/types'
import { FABLE_STOP, meterLevel, type MeterLevel } from '@shared/accountUsage'

const FABLE_WARN_AT = 0.85

export function ageLabel(at: number, nowMs: number): string | null {
  const mins = Math.floor((nowMs - at) / 60_000)
  return mins >= 2 ? `cached ${mins}m` : null
}

// CC§7
export function resetLabel(epochSec: number, nowMs: number): string {
  const d = new Date(epochSec * 1000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(nowMs)
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

export function resetIn(epochSec: number, nowMs: number): string {
  const mins = Math.ceil((epochSec * 1000 - nowMs) / 60_000)
  if (mins <= 0) return 'due'
  if (mins < 60) return `in ${mins}m`
  return `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

export function probeErrorLabel(e: NonNullable<AccountView['probeError']>): string {
  switch (e) {
    case 'expired':
      return 'Probe failed: credential rejected'
    case 'network':
      return 'Probe failed: network'
    case 'model-unavailable':
      return 'Probe failed: model unavailable'
    default:
      return 'Probe failed'
  }
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
  v: number
  win: string
  soi?: string
}): JSX.Element {
  const pct = Math.min(100, Math.round(v * 100))
  const level = win === 'oi' ? fableLevel(v, soi ?? '?') : meterLevel(v)
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

import type { JSX } from 'react'
import type { AccountView } from '@shared/types'
import { FABLE_STOP, meterLevel, type MeterLevel } from '@shared/accountUsage'

/** Shared account-display atoms — used by both the Settings panel and the titlebar
 *  usage popover so thresholds and wording can never drift apart. */

export function ageLabel(at: number, nowMs: number): string | null {
  const mins = Math.floor((nowMs - at) / 60_000)
  return mins >= 2 ? `cached ${mins}m` : null
}

/** A reset instant in the VIEWER's local time, as short as it can be without lying: a
 *  bare clock time reads as "today", wrong for the weekly buckets which are usually
 *  days out, so anything past today carries its date. (The header is epoch seconds;
 *  Date renders it local, which is what the user compares against their own clock.) */
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

/** The same instant as a wait, for the rolling 5h window: its question is "hold on or
 *  switch account", which a clock time makes the reader answer with mental subtraction
 *  (D13). Rounded up, so a reset still ahead never renders as `in 0m`; once it is
 *  behind us the snapshot is simply stale — say `due` rather than a time that passed. */
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

/** The fable bucket's own thresholds: it does not wall the account at 90% — the host
 *  keeps serving fable right up to FABLE_STOP, so 70/90 would paint a working host red
 *  (routing §4.2.5). Warn early enough that the exhaustion is not a surprise.
 *  A rejected bucket is spent whatever the number says: without the status the popover
 *  would pair a green meter with a `spent` subline (usage §06). */
export function fableLevel(v: number, soi: string): MeterLevel {
  if (soi === 'rejected') return 'bad'
  return v >= FABLE_STOP ? 'bad' : v >= 0.85 ? 'warn' : ''
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

import type { ProbeErrorKind } from './types'
import type { Subline } from './accountUsage'

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

export function probeErrorLabel(e: ProbeErrorKind): string {
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

function stamp(countdown: boolean, epoch: number, now: number): string {
  return countdown ? resetIn(epoch, now) : resetLabel(epoch, now)
}

export function sublineText(countdown: boolean, s: Subline, now: number): string {
  switch (s.kind) {
    case 'time':
      return stamp(countdown, s.epoch, now)
    case 'back':
      return `back ${stamp(countdown, s.epoch, now)}`
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

function spokenStamp(countdown: boolean, epoch: number, now: number): string {
  return countdown ? resetIn(epoch, now) : `at ${resetLabel(epoch, now)}`
}

export function sublineSpoken(label: string, countdown: boolean, s: Subline, now: number): string {
  switch (s.kind) {
    case 'time':
      return `${label} resets ${spokenStamp(countdown, s.epoch, now)}`
    case 'back':
      return s.tone === 'red'
        ? `${label} walled, back ${spokenStamp(countdown, s.epoch, now)}`
        : `${label} rate limited, back ${spokenStamp(countdown, s.epoch, now)}`
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

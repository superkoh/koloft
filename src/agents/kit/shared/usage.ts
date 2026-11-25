import type { Subline } from '@shared/accountUsage'
import { sublineSpoken, sublineText } from '@shared/usageWords'
import type { UsageLine } from '@core/agent/usageShape'

export const API_KEY_BADGE = { means: 'apiKey', text: 'API KEY', title: null } as const

export const NO_LINE: UsageLine = { text: '', spoken: '', tone: 'faint' }

export function lineUnder(label: string, countdown: boolean, s: Subline, nowMs: number): UsageLine {
  return {
    text: sublineText(countdown, s, nowMs),
    spoken: sublineSpoken(label, countdown, s, nowMs),
    tone: s.tone
  }
}

export function pillSpoken(count: number, name: string, walled: number): string {
  return (
    `${count} ${name} account${count === 1 ? '' : 's'}` + (walled > 0 ? `, ${walled} walled` : '')
  )
}

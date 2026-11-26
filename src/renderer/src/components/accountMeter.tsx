import type { JSX } from 'react'
import type { MeterLevel } from '@shared/accountUsage'
import '../accounts.css'

export { resetIn, resetLabel } from '@shared/usageWords'

export function ageLabel(at: number, nowMs: number): string | null {
  const mins = Math.floor((nowMs - at) / 60_000)
  return mins >= 2 ? `cached ${mins}m` : null
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

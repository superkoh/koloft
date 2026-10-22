import { useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { BackendId, UsageRead } from '@shared/types'
import { BACKEND_PRODUCT } from '@shared/sessionBackend'
import { isRemoteKey } from '@shared/remoteKey'
import { formatCost, formatTokens, localDayKey } from '@shared/usageFormat'
import {
  chartDays,
  dayBefore,
  grouped,
  inRange,
  type UsageDay,
  type UsageGroup,
  type UsageLine,
  type UsageRange
} from '../../usageModel'
import '../../accounts.css'
import '../../costs.css'

const RANGES: { id: UsageRange; label: string; phrase: string }[] = [
  { id: '7d', label: '7 days', phrase: 'last 7 days' },
  { id: '30d', label: '30 days', phrase: 'last 30 days' },
  { id: '90d', label: '90 days', phrase: 'last 90 days' },
  { id: 'all', label: 'All', phrase: 'in all' }
]

const GROUPS: { id: UsageGroup; label: string; title: string }[] = [
  { id: 'day', label: 'Day', title: 'By day · newest first' },
  { id: 'session', label: 'Session', title: 'By session · most costly first' },
  { id: 'workspace', label: 'Workspace', title: 'By workspace' },
  { id: 'model', label: 'Model', title: 'By model' }
]

const BADGE: Record<Exclude<BackendId, 'claude'>, string> = {
  codex: 'CODEX',
  muse: 'MUSE',
  agy: 'ANTIGRAVITY'
}

const GRID_STEPS = [0, 0.25, 0.5, 0.75]
const TIP_FLIPS_PAST = 0.6
const NO_PRICE_TITLE = 'No price for this model yet'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function workspaceName(workspace: string): string {
  if (!workspace) return 'Other'
  if (isRemoteKey(workspace)) return workspace
  return workspace.split('/').filter(Boolean).pop() ?? workspace
}

function niceMax(max: number): number {
  if (max <= 0) return 1
  const step = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 4, 5, 10].map((m) => m * step).find((n) => n >= max) ?? max
}

function Badges({ line }: { line: UsageLine }): JSX.Element {
  return (
    <>
      {line.backends.map(
        (b) =>
          b !== 'claude' && (
            <span key={b} className={`acct-badge ${b}`}>
              {BADGE[b]}
            </span>
          )
      )}
      {isRemoteKey(line.workspace) && <span className="acct-badge ssh">SSH</span>}
    </>
  )
}

function Cost({ line }: { line: UsageLine }): JSX.Element {
  return line.priced ? (
    <span className="c">{formatCost(line.costUsd)}</span>
  ) : (
    <span className="c none" title={NO_PRICE_TITLE}>
      no price
    </span>
  )
}

function Meter({ part }: { part: number }): JSX.Element {
  return (
    <span className="acct-meter">
      <span className="m-track">
        <span className="m-fill" style={{ width: `${Math.round(part * 100)}%` }} />
      </span>
    </span>
  )
}

function Row({
  line,
  by,
  titles,
  today,
  most
}: {
  line: UsageLine
  by: UsageGroup
  titles: Record<string, string>
  today: Date
  most: number
}): JSX.Element {
  const part = most > 0 ? line.costUsd / most : 0
  if (by === 'day') {
    const name =
      line.key === localDayKey(today.getTime())
        ? 'Today'
        : line.key === dayBefore(today, 1)
          ? 'Yesterday'
          : line.key
    return (
      <div className="acct-row costs-row">
        <div className="t">
          {name}
          <small>{plural(line.sessions, 'session')}</small>
        </div>
        <Meter part={part} />
        <Cost line={line} />
      </div>
    )
  }
  if (by === 'session') {
    const context = [
      workspaceName(line.workspace),
      line.models.join(', '),
      plural(line.days, 'day')
    ]
    return (
      <div className="acct-row costs-row">
        <div className="t">
          {titles[line.key] || `${BACKEND_PRODUCT[line.backends[0]]} session`}
          <small>{context.join(' · ')}</small>
        </div>
        <Badges line={line} />
        <span className="tk">{formatTokens(line.tokens)}</span>
        <Cost line={line} />
      </div>
    )
  }
  return (
    <div className="acct-row costs-row">
      <div className="t">
        {by === 'workspace' ? workspaceName(line.key) : line.key || 'unknown model'}
        <small>{plural(line.sessions, 'session')}</small>
      </div>
      {by === 'workspace' ? (
        <>
          {isRemoteKey(line.key) && <span className="acct-badge ssh">SSH</span>}
          <Meter part={part} />
        </>
      ) : (
        <>
          <Badges line={{ ...line, workspace: '' }} />
          <span className="tk">{formatTokens(line.tokens)}</span>
        </>
      )}
      <Cost line={line} />
    </div>
  )
}

function DayTip({ day, at }: { day: UsageDay; at: DOMRect }): JSX.Element {
  const parts = (Object.entries(day.byBackend) as [BackendId, number][]).filter(
    ([, usd]) => usd > 0
  )
  const center = at.left + at.width / 2
  const side =
    center > window.innerWidth * TIP_FLIPS_PAST
      ? { className: 'costs-tip to-left', left: at.right }
      : { className: 'costs-tip', left: center }
  return createPortal(
    <div className={side.className} style={{ left: side.left, top: at.top }} role="tooltip">
      <b>
        {day.day} · {formatCost(day.costUsd)}
      </b>
      {parts.length > 0 && <br />}
      {parts.map(([b, usd], i) => (
        <span key={b}>
          {i > 0 && ' · '}
          <span className="k">{BACKEND_PRODUCT[b]}</span> {formatCost(usd)}
        </span>
      ))}
    </div>,
    document.body
  )
}

function Chart({ days, phrase }: { days: UsageDay[]; phrase: string }): JSX.Element {
  const [tip, setTip] = useState<{ day: UsageDay; at: DOMRect } | null>(null)
  const top = niceMax(Math.max(0, ...days.map((d) => d.costUsd)))
  const today = days.length - 1
  const middle = Math.floor(days.length / 2)
  const short = (day: string): string => `${+day.slice(5, 7)}/${+day.slice(8)}`
  return (
    <>
      <div className="costs-chart" aria-label={`Cost per day, ${phrase}`}>
        <div className="costs-y">
          {GRID_STEPS.map((s) => (
            <span key={s} style={{ top: `${s * 100}%` }}>
              {formatCost(top * (1 - s))}
            </span>
          ))}
          <span style={{ top: '100%' }}>0</span>
        </div>
        <div className="costs-plot">
          {GRID_STEPS.map((s) => (
            <div key={s} className="costs-grid" style={{ top: `${s * 100}%` }} />
          ))}
          <div className="costs-bars">
            {days.map((d, i) => {
              const show = (e: { currentTarget: HTMLElement }): void =>
                setTip({ day: d, at: e.currentTarget.getBoundingClientRect() })
              return (
                <div
                  key={d.day}
                  className={'costs-col' + (i === today ? ' today' : '')}
                  tabIndex={0}
                  aria-label={`${d.day}: ${formatCost(d.costUsd)}`}
                  onMouseEnter={show}
                  onFocus={show}
                  onMouseLeave={() => setTip(null)}
                  onBlur={() => setTip(null)}
                >
                  <div className="costs-bar" style={{ height: `${(d.costUsd / top) * 100}%` }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="costs-x">
        <span />
        <div>
          <span>{days.length > 1 ? short(days[0].day) : ''}</span>
          <span>{days.length > 2 ? short(days[middle].day) : ''}</span>
          <span>today</span>
        </div>
      </div>
      {/* ADR-0013 */}
      {tip && <DayTip day={tip.day} at={tip.at} />}
    </>
  )
}

export function UsagePane(): JSX.Element {
  const [read, setRead] = useState<UsageRead | null>(null)
  const [range, setRange] = useState<UsageRange>('30d')
  const [by, setBy] = useState<UsageGroup>('day')

  useEffect(() => {
    let live = true
    const off = window.api.usage.onChanged(setRead)
    void window.api.usage.read().then((r) => live && setRead(r))
    return () => {
      live = false
      off()
    }
  }, [])

  const today = useMemo(() => new Date(), [read])
  const rows = useMemo(() => (read ? inRange(read.rows, range, today) : []), [read, range, today])
  const days = useMemo(() => chartDays(rows, range, today), [rows, range, today])
  const lines = useMemo(() => grouped(rows, by), [rows, by])
  const total = days.reduce((sum, d) => sum + d.costUsd, 0)
  const sessions = new Set(rows.map((r) => r.sessionId)).size
  const most = Math.max(0, ...lines.map((l) => l.costUsd))
  const phrase = RANGES.find((r) => r.id === range)!.phrase
  const group = GROUPS.find((g) => g.id === by)!

  return (
    <>
      <div className="set-ph">
        <h3>Usage</h3>
        <p>
          What your sessions would cost on the API, counted from their tokens at list price. A
          subscription is not billed per token, so this is a yardstick, not a bill.
        </p>
      </div>

      <div className="costs-head">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              className={r.id === range ? 'on' : undefined}
              aria-pressed={r.id === range}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Group by">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              className={g.id === by ? 'on' : undefined}
              aria-pressed={g.id === by}
              onClick={() => setBy(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {!read || (read.reading && read.rows.length === 0) ? (
        <div className="acct-empty">Reading usage…</div>
      ) : (
        <>
          <div className="costs-sum">
            <span>
              <span className="n">{formatCost(total)}</span>
              <span className="l">{phrase}</span>
            </span>
            <span>
              <span className="n">{sessions}</span>
              <span className="l">{sessions === 1 ? 'session' : 'sessions'}</span>
            </span>
          </div>
          <Chart days={days} phrase={phrase} />
          <div className="set-grp">{group.title}</div>
          {lines.length === 0 ? (
            <div className="acct-empty">No sessions in this range.</div>
          ) : (
            <div className="acct-list costs-list">
              {lines.map((line) => (
                <Row
                  key={line.key}
                  line={line}
                  by={by}
                  titles={read.titles}
                  today={today}
                  most={most}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="costs-foot">
        <span className="acct-note">
          Claude Code, Codex, Muse and Antigravity sessions are read from the files each tool keeps,
          on this Mac and on your SSH machines, so days before this version count too.
        </span>
        <span className="acct-note">
          Cost uses the list price Koloft keeps for each model. A model with no price shows its
          tokens and &quot;no price&quot;.
        </span>
      </div>
    </>
  )
}

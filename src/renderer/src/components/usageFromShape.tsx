import { Fragment, useState, type JSX } from 'react'
import type { AccountView } from '@shared/types'
import { ACCOUNT_KINDS_OF, CAP, STALE_MS, meterLevel, type MeterLevel } from '@shared/accountUsage'
import { agentManifest } from '@core/agent/registry'
import type { AgentId } from '@core/agent/registry'
import type {
  PillLayers,
  UsageAccount,
  UsageBadge,
  UsageBar,
  UsageColumn,
  UsageGroup,
  UsageTotal
} from '@core/agent/usageShape'
import { AGENT_UIS } from '@agents/uis'
import { MeterBar, ageLabel, resetLabel } from './accountMeter'

export type ActOnAccount = (a: AccountView, action: string) => Promise<string>

export interface ShownRow {
  a: AccountView
  u: UsageAccount
}

export interface ShownGroup {
  id: AgentId
  title: string
  group: UsageGroup
  rows: ShownRow[]
  pill: ShownRow[]
}

function uiOf(a: AccountView): (typeof AGENT_UIS)[number] {
  return AGENT_UIS.find((ui) => ACCOUNT_KINDS_OF[ui.id].includes(a.kind))!
}

export function usageOf(a: AccountView, nowMs: number): UsageAccount {
  return uiOf(a).usage.account(a, nowMs)
}

export function shownGroups(accounts: readonly AccountView[], nowMs: number): ShownGroup[] {
  return AGENT_UIS.map((ui) => {
    const group = ui.usage.group(
      accounts.filter((a) => ACCOUNT_KINDS_OF[ui.id].includes(a.kind)),
      nowMs
    )
    const rows = group.rows.map((a) => ({ a, u: ui.usage.account(a, nowMs) }))
    return {
      id: ui.id,
      title: agentManifest(ui.id).name,
      group,
      rows,
      pill: rows.filter((r) => !r.u.metered)
    }
  }).filter((g) => g.pill.length > 0)
}

export function oldestShown(accounts: readonly AccountView[], nowMs: number): number | null {
  let oldest: number | null = null
  for (const a of accounts) {
    if (!a.enabled) continue
    const at = usageOf(a, nowMs).ageShownFrom
    if (at !== null && (oldest === null || at < oldest)) oldest = at
  }
  return oldest
}

export function groupsSpoken(groups: ShownGroup[]): string {
  return groups.map((g) => g.group.spoken).join('; ')
}

type PillLook =
  | { kind: 'grey' }
  | { kind: 'empty' }
  | { kind: 'walled'; stale: boolean }
  | {
      kind: 'bar'
      frac: number
      level: MeterLevel
      stale: boolean
      second: null | { frac: number; spent: boolean }
    }

function layered(p: PillLayers, stale: boolean): PillLook {
  return {
    kind: 'bar',
    frac: Math.min(p.used, CAP),
    level: meterLevel(p.used),
    stale,
    second: p.second && {
      frac: p.second.spent ? CAP : Math.min(p.second.used, CAP),
      spent: p.second.spent
    }
  }
}

function rowLook({ a, u }: ShownRow, nowMs: number): PillLook {
  if (a.status !== 'ok') return { kind: 'grey' }
  if (!u.pill) return { kind: 'empty' }
  const stale = u.ageShownFrom !== null && nowMs - u.ageShownFrom > STALE_MS
  if (u.walled) return { kind: 'walled', stale }
  return layered(u.pill, stale)
}

function totalLook(t: UsageTotal, nowMs: number): PillLook | null {
  if (t.measured < 2) return null
  const stale = t.oldestAt !== null && nowMs - t.oldestAt > STALE_MS
  if (t.walled === t.measured) return { kind: 'walled', stale }
  return layered(t, stale)
}

export function PillBar({ look: g, total }: { look: PillLook; total?: boolean }): JSX.Element {
  const stale = (g.kind === 'walled' || g.kind === 'bar') && g.stale
  const fillPct = g.kind === 'bar' ? Math.round(g.frac * 100) : 0
  const second = g.kind === 'bar' && g.second && g.second.frac > g.frac ? g.second : null
  return (
    <span className={'tbu-bar' + (total ? ' total' : '') + (stale ? ' stale' : '')}>
      {g.kind === 'grey' && <i className="tbu-fill cold" style={{ height: '100%' }} />}
      {g.kind === 'walled' && <i className="tbu-fill bad" style={{ height: '100%' }} />}
      {second && (
        <i
          className="tbu-fable"
          style={{ height: second.spent ? '100%' : `${Math.round(second.frac * 100)}%` }}
        />
      )}
      {g.kind === 'bar' && (
        <i
          className={'tbu-fill' + (g.level ? ` ${g.level}` : '')}
          style={{ height: `${fillPct}%` }}
        />
      )}
      {second && <i className="tbu-gap" style={{ bottom: `${fillPct}%` }} />}
    </span>
  )
}

export function ShapePill({ groups, now }: { groups: ShownGroup[]; now: number }): JSX.Element {
  return (
    <>
      {groups.map((g) => {
        const total = g.group.total && totalLook(g.group.total, now)
        const bars = (
          <>
            {total && <PillBar look={total} total />}
            {g.pill.map((r) => (
              <PillBar key={`${r.a.kind}:${r.a.name}`} look={rowLook(r, now)} />
            ))}
            {g.group.fallbackBarLit && (
              <span
                className="tbu-bar"
                title="Every subscription is walled — metered fallback active"
              >
                <i className="tbu-fill acc" style={{ height: '100%' }} />
              </span>
            )}
          </>
        )
        return g.group.pillBarsGrouped ? (
          <span key={g.id} className="tbu-group">
            {bars}
          </span>
        ) : (
          <Fragment key={g.id}>{bars}</Fragment>
        )
      })}
    </>
  )
}

function twoAcross(columns: UsageColumn[]): string {
  return columns.length < 3 ? ' two' : ''
}

function Section({
  title,
  columns,
  pool,
  children
}: {
  title: string
  columns: UsageColumn[]
  pool: JSX.Element | false
  children: JSX.Element[]
}): JSX.Element {
  return (
    <>
      <div className="tbu-pop-head">
        <span>{title}</span>
      </div>
      <div className={'tbu-grid tbu-colhead' + twoAcross(columns)} aria-hidden>
        {columns.map((c) => (
          <span key={c.id}>{c.label}</span>
        ))}
      </div>
      {pool && (
        <>
          {pool}
          <div className="tbu-sep" />
        </>
      )}
      {children}
    </>
  )
}

function TotalRow({
  t,
  columns,
  now,
  probing,
  fallback
}: {
  t: UsageTotal
  columns: UsageColumn[]
  now: number
  probing: boolean
  fallback: boolean
}): JSX.Element {
  const age = t.oldestAt === null ? null : ageLabel(t.oldestAt, now)
  return (
    <div
      className="tbu-row pool"
      role="group"
      aria-label={
        `Pool: ${t.measured} measured, ${t.usable} usable` +
        (t.walled > 0 ? `, ${t.walled} walled` : '')
      }
    >
      <div className="tbu-row-head">
        <span className="acct-name">Pool</span>
        <span className={'tbu-pool-meta' + (fallback ? ' armed' : '')}>
          {t.measured} measured · {fallback ? 'metered fallback active' : `${t.usable} usable`}
        </span>
        {probing ? (
          <span className="tbu-age">Probing…</span>
        ) : (
          age && <span className="tbu-age">{age}</span>
        )}
      </div>
      <div className={'tbu-grid' + twoAcross(columns)}>
        {t.measured >= 2 ? (
          <>
            {t.cells.map((c, i) => (
              <div key={i} className="tbu-cell">
                {c && <MeterBar v={c.used} win={columns[i].id} level={c.closeness} />}
              </div>
            ))}
            {t.walled > 0 && (
              <div className="tbu-cell span">
                <span className="tbu-cell-sub alarm">
                  {t.walled} walled
                  {t.walled >= 2 && t.earliestBack !== null
                    ? ` · earliest back ${resetLabel(t.earliestBack, now)}`
                    : ''}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="tbu-cell span">
            <span className="tbu-cell-sub">
              {t.measured === 1 ? 'only 1 account measured' : 'Not probed yet'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

const TONE_CLASS = { faint: '', amber: ' soon', red: ' alarm' } as const

function Cell({ bar }: { bar: UsageBar }): JSX.Element {
  return (
    <div className="tbu-cell" role="group" aria-label={bar.under.spoken}>
      <MeterBar v={bar.used} win={bar.column} level={bar.closeness} />
      <span className={'tbu-cell-sub' + TONE_CLASS[bar.under.tone]} aria-hidden>
        {bar.under.text}
      </span>
    </div>
  )
}

function Bars({
  bars,
  instead = null,
  after
}: {
  bars: UsageBar[]
  instead?: string | null
  after: string[]
}): JSX.Element {
  return (
    <div className="acct-meters">
      {instead !== null ? (
        <span className="acct-note">{instead}</span>
      ) : (
        bars.map((b) => (
          <MeterBar key={b.label} label={b.label} v={b.used} win={b.column} level={b.closeness} />
        ))
      )}
      {after.map((n) => (
        <span key={n} className="acct-note">
          {n}
        </span>
      ))}
    </div>
  )
}

function RowNote({ text }: { text: string }): JSX.Element {
  return (
    <div className="tbu-row-note">
      <span className="acct-note">{text}</span>
    </div>
  )
}

const TOP_BAR_BADGE: Record<UsageBadge['means'], string | null> = {
  apiKey: 'api',
  endpoint: 'api',
  planIncludes: 'good',
  planLacks: null
}

function TopBarRow({
  row: { a, u },
  columns,
  now,
  onAct
}: {
  row: ShownRow
  columns: UsageColumn[]
  now: number
  onAct: ActOnAccount
}): JSX.Element {
  const [confirm, setConfirm] = useState<'ask' | 'using' | { said: string } | null>(null)
  const dead = a.status !== 'ok'
  const age = u.ageShownFrom === null ? null : ageLabel(u.ageShownFrom, now)
  const action = u.action
  const act = async (): Promise<void> => {
    if (!action) return
    setConfirm('using')
    const said = action.outcomes[await onAct(a, action.id)] ?? null
    setConfirm(said === null ? null : { said })
  }
  const lined = u.topBar.instead !== null || columns.length > 0
  return (
    <div className={'tbu-row' + (dead ? ' dim' : '')}>
      <div className="tbu-row-head">
        <span className="acct-name" title={a.name}>
          {a.name}
        </span>
        {u.badges.map(
          (b) =>
            TOP_BAR_BADGE[b.means] && (
              <span key={b.means} className={`acct-badge ${TOP_BAR_BADGE[b.means]}`}>
                {b.text}
              </span>
            )
        )}
        {a.status === 'expired' && <span className="acct-status expired">EXPIRED</span>}
        {a.status === 'unverified' && <span className="acct-status unverified">UNVERIFIED</span>}
        {!dead && u.walled && <span className="acct-status walled">WALLED</span>}
        {action && !confirm && (
          <button className="acct-relogin" onClick={() => setConfirm('ask')}>
            {action.label}
          </button>
        )}
        {age && <span className="tbu-age">{age}</span>}
      </div>
      {u.topBar.instead !== null ? (
        <RowNote text={u.topBar.instead} />
      ) : columns.length > 0 ? (
        <div className={'tbu-grid' + twoAcross(columns)}>
          {columns.map((c) => {
            const bar = u.bars.find((b) => b.column === c.id)
            return bar ? <Cell key={c.id} bar={bar} /> : <div key={c.id} className="tbu-cell" />
          })}
          {u.failureBesideBars && (
            <div className="tbu-cell span">
              <span className="tbu-cell-sub">{u.failureBesideBars}</span>
            </div>
          )}
        </div>
      ) : (
        <Bars bars={u.bars} after={u.topBar.after} />
      )}
      {lined && u.topBar.after.map((n) => <RowNote key={n} text={n} />)}
      {confirm && (typeof confirm === 'object' || action) && (
        <div className="acct-confirm">
          {typeof confirm === 'object' ? (
            <>
              <span>{confirm.said}</span>
              <button className="mini" onClick={() => setConfirm(null)}>
                Close
              </button>
            </>
          ) : (
            action && (
              <>
                <span>
                  {action.ask.before}
                  <b>{action.ask.name}</b>
                  {action.ask.after}
                </span>
                <button
                  className="mini danger"
                  disabled={confirm === 'using'}
                  onClick={() => void act()}
                >
                  {confirm === 'using' ? action.going : action.go}
                </button>
                <button
                  className="mini"
                  disabled={confirm === 'using'}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
              </>
            )
          )}
        </div>
      )}
    </div>
  )
}

export function ShapeSections({
  groups,
  now,
  probing,
  onAct
}: {
  groups: ShownGroup[]
  now: number
  probing: boolean
  onAct: ActOnAccount
}): JSX.Element {
  return (
    <>
      {groups.map(({ id, title, group, rows, pill }, i) => (
        <Fragment key={id}>
          {i > 0 && <div className="tbu-sep" />}
          <Section
            title={title}
            columns={group.columns}
            pool={
              !!group.total &&
              pill.length >= 2 && (
                <TotalRow
                  t={group.total}
                  columns={group.columns}
                  now={now}
                  probing={probing}
                  fallback={group.fallbackBarLit && group.total.usable === 0}
                />
              )
            }
          >
            {rows.map((r) => (
              <TopBarRow
                key={`${r.a.kind}:${r.a.name}`}
                row={r}
                columns={group.columns}
                now={now}
                onAct={onAct}
              />
            ))}
          </Section>
        </Fragment>
      ))}
    </>
  )
}

const PANE_BADGE: Record<UsageBadge['means'], string> = {
  apiKey: 'api',
  endpoint: 'custom',
  planIncludes: 'good',
  planLacks: 'nofable'
}

export function PaneBadges({ u }: { u: UsageAccount }): JSX.Element {
  return (
    <>
      {u.badges.map((b) => (
        <span
          key={b.means}
          className={`acct-badge ${PANE_BADGE[b.means]}`}
          title={b.title ?? undefined}
        >
          {b.text}
        </span>
      ))}
    </>
  )
}

export function PaneUsage({ u }: { u: UsageAccount }): JSX.Element {
  return (
    <Bars
      bars={u.bars.filter((b) => b.used !== null)}
      instead={u.pane.instead}
      after={u.pane.after}
    />
  )
}

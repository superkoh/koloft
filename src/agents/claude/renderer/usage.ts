import type { AccountView, UsageSnapshot } from '@shared/types'
import {
  FABLE_STOP,
  METERED_NOTE,
  accountWalled,
  capsuleAria,
  fableExhausted,
  meteredArmed,
  meterLevel,
  poolSnapshot,
  sublineFor,
  type MeterLevel
} from '@shared/accountUsage'
import { probeErrorLabel, resetLabel } from '@shared/usageWords'
import type {
  AgentUsageUi,
  UsageAccount,
  UsageBadge,
  UsageBar,
  UsageBody,
  UsageColumn,
  UsageGroup
} from '@core/agent/usageShape'
import { API_KEY_BADGE, lineUnder } from '@agents/kit/shared/usage'

const FABLE_WARN_AT = 0.85
const NO_FIVE_HOUR_LIMIT = 'no 5-hour limit'
const FABLE_TITLE = 'Plan includes a fable allowance — fable launches are routed here first'
const ONLY_WHEN_WALLED = 'used only when every subscription is rate-limited'

// CC§7
function fableLevel(v: number, soi: string): MeterLevel {
  if (soi === 'rejected') return 'bad'
  return v >= FABLE_STOP ? 'bad' : v >= FABLE_WARN_AT ? 'warn' : ''
}

function badgesOf(a: AccountView): UsageBadge[] {
  return [
    ...(a.kind === 'apikey' || a.apiKey ? [API_KEY_BADGE] : []),
    ...(a.kind === 'custom' ? [{ means: 'endpoint', text: 'ENDPOINT', title: null } as const] : []),
    ...(a.kind === 'oauth' && a.fable === 'yes'
      ? [{ means: 'planIncludes', text: 'FABLE', title: FABLE_TITLE } as const]
      : []),
    ...(a.kind === 'oauth' && a.fable === 'no'
      ? [{ means: 'planLacks', text: 'FABLE', title: null } as const]
      : [])
  ]
}

function barsOf(u: UsageSnapshot, nowMs: number): UsageBar[] {
  const nowSec = Math.floor(nowMs / 1000)
  return [
    u.has5h
      ? {
          column: '5h',
          label: '5h',
          used: u.u5,
          closeness: meterLevel(u.u5),
          under: lineUnder('5h', true, sublineFor('5h', u, nowSec), nowMs)
        }
      : {
          column: '5h',
          label: '5h',
          used: null,
          closeness: '',
          under: { text: NO_FIVE_HOUR_LIMIT, spoken: NO_FIVE_HOUR_LIMIT, tone: 'faint' }
        },
    {
      column: '7d',
      label: '7d',
      used: u.u7,
      closeness: meterLevel(u.u7),
      under: lineUnder('7d', false, sublineFor('7d', u, nowSec), nowMs)
    },
    ...(u.hasOi
      ? [
          {
            column: 'oi',
            label: 'fable',
            used: u.uoi,
            closeness: fableLevel(u.uoi, u.soi),
            under: lineUnder('fable', false, sublineFor('oi', u, nowSec), nowMs)
          }
        ]
      : [])
  ]
}

function endpointLine(a: AccountView): string[] {
  return [a.baseUrl ?? '', a.model ? ` · ${a.model}` : '']
}

function notProbed(a: AccountView): string {
  return a.probeError ? probeErrorLabel(a.probeError) : 'Not probed yet'
}

function say(instead: string): UsageBody {
  return { instead: [instead], after: [] }
}

function paneOf(a: AccountView, nowMs: number): UsageBody {
  const u = a.usage
  if (a.kind === 'custom')
    return {
      instead: [...endpointLine(a), ` · ${ONLY_WHEN_WALLED} (switches model)`],
      after: []
    }
  if (a.kind === 'apikey') return say(METERED_NOTE)
  if (!u) return say(notProbed(a))
  // CC§7
  return { instead: null, after: u.r5 > 0 ? [['5h resets ', resetLabel(u.r5, nowMs)]] : [] }
}

function topBarOf(a: AccountView): UsageBody {
  if (a.kind === 'apikey') return say(METERED_NOTE)
  if (a.kind === 'custom')
    return { instead: [...endpointLine(a), ` · ${ONLY_WHEN_WALLED}`], after: [] }
  if (a.status !== 'ok')
    return say(
      a.status === 'expired'
        ? 'Token expired — sign in again from Settings'
        : 'Not verified yet — sign in from Settings'
    )
  return a.usage ? { instead: null, after: [] } : say(notProbed(a))
}

function account(a: AccountView, nowMs: number): UsageAccount {
  const u = a.usage
  return {
    metered: a.kind !== 'oauth',
    badges: badgesOf(a),
    walled: !!u && accountWalled(u, Math.floor(nowMs / 1000)),
    ageShownFrom: u?.at ?? null,
    pill: u
      ? {
          used: Math.max(u.u5, u.u7),
          second: u.hasOi ? { used: u.uoi, spent: fableExhausted(u) } : null
        }
      : null,
    bars: u ? barsOf(u, nowMs) : [],
    pane: paneOf(a, nowMs),
    topBar: topBarOf(a),
    failureBesideBars: u && a.probeError ? probeErrorLabel(a.probeError) : null,
    action: null
  }
}

function group(accounts: readonly AccountView[], nowMs: number): UsageGroup {
  const rows = accounts.filter((a) => a.enabled)
  const subscriptions = rows.filter((a) => a.kind === 'oauth')
  const p = poolSnapshot(subscriptions, nowMs)
  const fiveHour = p.measured === 0 || p.t5 !== null
  const columns: UsageColumn[] = [
    ...(fiveHour ? [{ id: '5h', label: '5h' }] : []),
    { id: '7d', label: '7d' },
    ...(p.tfable !== null ? [{ id: 'oi', label: 'fable' }] : [])
  ]
  return {
    columns,
    rows,
    total: {
      measured: p.measured,
      usable: p.usable,
      walled: p.walled,
      used: p.tension,
      second: p.tfable === null ? null : { used: p.tfable, spent: p.fableSpentAll },
      cells: [
        ...(fiveHour ? [p.t5 === null ? null : { used: p.t5, closeness: meterLevel(p.t5) }] : []),
        { used: p.t7, closeness: meterLevel(p.t7) },
        ...(p.tfable === null ? [] : [{ used: p.tfable, closeness: fableLevel(p.tfable, '?') }])
      ],
      earliestBack: p.earliestBack,
      oldestAt: p.oldestAt
    },
    spoken: capsuleAria(subscriptions, nowMs),
    fallbackBarLit: meteredArmed([...accounts], Math.floor(nowMs / 1000)),
    pillBarsGrouped: false
  }
}

export const usage: AgentUsageUi = { account, group }

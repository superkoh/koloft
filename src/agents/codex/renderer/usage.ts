import type { AccountView, CodexLimitWindow, CodexLimits } from '@shared/types'
import {
  FIVE_HOUR_MINUTES,
  METERED_NOTE,
  codexHeaviest,
  codexPoolSnapshot,
  codexResetOffered,
  codexWalled,
  meterLevel,
  windowLabel,
  type Subline
} from '@shared/accountUsage'
import { probeErrorLabel, resetLabel } from '@shared/usageWords'
import type {
  AgentUsageUi,
  UsageAction,
  UsageAccount,
  UsageBody,
  UsageGroup
} from '@core/agent/usageShape'
import { API_KEY_BADGE, lineUnder, pillSpoken } from '@agents/kit/shared/usage'
import { agent } from '../agent'

// CODEX§15
function balanceLabel(l: CodexLimits, nowMs: number): string {
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

function sublineOf(w: CodexLimitWindow): Subline {
  if (w.resetsAt <= 0) return { kind: 'none', epoch: 0, tone: 'faint' }
  return w.used >= 1
    ? { kind: 'back', epoch: w.resetsAt, tone: 'red' }
    : { kind: 'time', epoch: w.resetsAt, tone: 'faint' }
}

const RESET_OUTCOMES: UsageAction['outcomes'] = {
  reset: null,
  nothingToReset: 'Codex says there is nothing to reset right now.',
  noCredit: 'No saved reset is left on this account.',
  alreadyRedeemed: 'That reset was already used.',
  failed: 'Could not reach Codex. Try again.'
}

function resetAction(a: AccountView): UsageAction | null {
  if (!codexResetOffered(a)) return null
  return {
    id: 'useReset',
    label: 'Use a reset',
    ask: {
      before: `Use 1 of ${a.limits?.resets?.available} saved resets on `,
      name: a.name,
      after: ' now? Its limits start again from 0.'
    },
    go: 'Use',
    going: 'Using…',
    outcomes: RESET_OUTCOMES
  }
}

function insteadOfBars(a: AccountView, signedOut: string): string | null {
  if (a.status !== 'ok') return signedOut
  if (a.apiKey && !a.probeError) return METERED_NOTE
  if (a.limits && a.limits.windows.length > 0) return null
  return a.probeError ? probeErrorLabel(a.probeError) : 'Not probed yet'
}

function paneOf(a: AccountView, nowMs: number): UsageBody {
  const l = a.limits
  const first = l?.windows[0]
  const ok = a.status === 'ok'
  const balance = ok && l ? balanceLabel(l, nowMs) : ''
  return {
    instead: insteadOfBars(a, 'Not signed in — use Sign in again'),
    after: [
      ...(ok && first?.resetsAt
        ? [`${windowLabel(first.minutes)} resets ${resetLabel(first.resetsAt, nowMs)}`]
        : []),
      ...(balance ? [balance] : [])
    ]
  }
}

function topBarOf(a: AccountView, nowMs: number): UsageBody {
  const balance = a.status === 'ok' && a.limits ? balanceLabel(a.limits, nowMs) : ''
  return {
    instead: insteadOfBars(a, 'Not signed in — sign in again from Settings'),
    after: balance ? [balance] : []
  }
}

function account(a: AccountView, nowMs: number): UsageAccount {
  const l = a.limits
  return {
    metered: !!a.apiKey,
    badges: a.apiKey ? [API_KEY_BADGE] : [],
    walled: !!l && codexWalled(l),
    ageShownFrom: l?.at ?? null,
    pill: l ? { used: codexHeaviest(l), second: null } : null,
    bars: (l?.windows ?? []).map((w) => {
      const label = windowLabel(w.minutes)
      return {
        column: label,
        label,
        used: w.used,
        closeness: meterLevel(w.used),
        under: lineUnder(label, w.minutes === FIVE_HOUR_MINUTES, sublineOf(w), nowMs)
      }
    }),
    pane: paneOf(a, nowMs),
    topBar: topBarOf(a, nowMs),
    failureBesideBars: null,
    action: resetAction(a)
  }
}

function group(accounts: readonly AccountView[], nowMs: number): UsageGroup {
  const rows = accounts.filter((a) => a.enabled)
  const subscriptions = rows.filter((a) => !a.apiKey)
  const p = codexPoolSnapshot(subscriptions, nowMs)
  return {
    columns: p.windows.map((w) => ({ id: windowLabel(w.minutes), label: windowLabel(w.minutes) })),
    rows,
    total: {
      measured: p.measured,
      usable: p.usable,
      walled: p.walled,
      used: p.tension,
      second: null,
      cells: p.windows.map((w) => ({ used: w.mean, closeness: meterLevel(w.mean) })),
      earliestBack: p.earliestBack,
      oldestAt: p.oldestAt
    },
    spoken: pillSpoken(
      subscriptions.length,
      agent.name,
      subscriptions.filter((a) => a.status === 'ok' && a.limits && codexWalled(a.limits)).length
    ),
    fallbackBarLit: false,
    pillBarsGrouped: true
  }
}

export const usage: AgentUsageUi = { account, group }

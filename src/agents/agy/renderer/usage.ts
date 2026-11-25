import type { AccountView, QuotaBucket } from '@shared/types'
import { METERED_NOTE, meterLevel } from '@shared/accountUsage'
import { probeErrorLabel, resetLabel } from '@shared/usageWords'
import type { AgentUsageUi, UsageAccount, UsageBody, UsageGroup } from '@core/agent/usageShape'
import { API_KEY_BADGE, NO_LINE, pillSpoken } from '@agents/kit/shared/usage'
import { agent } from '../agent'

function heaviest(quota: readonly QuotaBucket[]): number {
  return Math.max(0, ...quota.map((q) => q.used))
}

function firstResets(quota: readonly QuotaBucket[], nowMs: number): string[] {
  const first = quota[0]
  return first?.resetsAt ? [`${first.label} resets ${resetLabel(first.resetsAt, nowMs)}`] : []
}

function paneOf(a: AccountView, nowMs: number): UsageBody {
  if (a.status === 'ok' && a.quota && a.quota.length > 0)
    return { instead: null, after: firstResets(a.quota, nowMs) }
  const instead =
    a.status !== 'ok'
      ? 'Not signed in — use Sign in again'
      : a.apiKey && !a.probeError
        ? METERED_NOTE
        : a.probeError
          ? probeErrorLabel(a.probeError)
          : 'Signed in'
  return { instead, after: [] }
}

function topBarOf(a: AccountView, nowMs: number): UsageBody {
  if (a.status !== 'ok') return { instead: 'Not signed in — sign in again from Settings', after: [] }
  if (a.apiKey) return { instead: METERED_NOTE, after: [] }
  return { instead: null, after: firstResets(a.quota ?? [], nowMs) }
}

// AGY§23
function account(a: AccountView, nowMs: number): UsageAccount {
  const quota = a.quota ?? []
  return {
    metered: !!a.apiKey,
    badges: a.apiKey ? [API_KEY_BADGE] : [],
    walled: heaviest(quota) >= 1,
    ageShownFrom: null,
    pill: quota.length > 0 ? { used: heaviest(quota), second: null } : null,
    bars: quota.map((q) => ({
      column: '',
      label: q.label,
      used: q.used,
      closeness: meterLevel(q.used),
      under: NO_LINE
    })),
    pane: paneOf(a, nowMs),
    topBar: topBarOf(a, nowMs),
    failureBesideBars: null,
    action: null
  }
}

function group(accounts: readonly AccountView[]): UsageGroup {
  const rows = accounts.filter((a) => a.enabled && (a.quota || a.apiKey))
  const measured = rows.filter((a) => !a.apiKey)
  return {
    columns: [],
    rows,
    total: null,
    spoken: pillSpoken(
      measured.length,
      agent.name,
      measured.filter((a) => a.status === 'ok' && a.quota?.length && heaviest(a.quota) >= 1).length
    ),
    fallbackBarLit: false,
    pillBarsGrouped: true
  }
}

export const usage: AgentUsageUi = { account, group }

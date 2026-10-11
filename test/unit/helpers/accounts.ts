import type { AccountMeta, UsageSnapshot } from '../../../src/shared/types'

export const NOW_S = 1_700_000_000
export const NOW_MS = NOW_S * 1000

export function meta(p: Partial<AccountMeta>): AccountMeta {
  return {
    name: 'a',
    kind: 'oauth',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 1,
    ...p
  }
}

export function usage(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    u5: 0,
    u7: 0,
    uoi: 0,
    s5: 'allowed',
    s7: 'allowed',
    soi: '?',
    r5: 0,
    r7: 0,
    roi: 0,
    overage: '?',
    hasOi: false,
    at: NOW_MS,
    ...p
  }
}

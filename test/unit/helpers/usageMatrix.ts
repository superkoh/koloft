import type {
  AccountKind,
  AccountView,
  CodexLimits,
  QuotaBucket,
  UsageSnapshot
} from '../../../src/shared/types'

export const NOW = new Date(2026, 2, 5, 9, 30).getTime()
const S = Math.floor(NOW / 1000)
const MIN = 60
const HOUR = 3600
const DAY = 86400

function view(name: string, kind: AccountKind, extra: Partial<AccountView> = {}): AccountView {
  return { name, kind, enabled: true, fable: 'unknown', status: 'ok', addedAt: 0, ...extra }
}

function usage(u: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    u5: 0.4,
    u7: 0.6,
    uoi: 0,
    s5: 'allowed',
    s7: 'allowed',
    soi: 'allowed',
    r5: S + 2 * HOUR,
    r7: S + 2 * DAY,
    roi: 0,
    overage: 'rejected',
    has5h: true,
    hasOi: false,
    at: NOW,
    ...u
  }
}

const withOi = { hasOi: true, uoi: 0.3, roi: S + 2 * DAY }

export const CLAUDE_SETS: Record<string, AccountView[]> = {
  claudeFresh: [view('fresh', 'oauth', { fable: 'yes', usage: usage(withOi) })],
  claudeTwo: [
    view('studio', 'oauth', { fable: 'yes', usage: usage({ ...withOi, u5: 0.42, u7: 0.63 }) }),
    view('garden', 'oauth', { fable: 'no', usage: usage({ u5: 0.07, u7: 0.31 }) })
  ],
  claudeEveryState: [
    view('studio', 'oauth', { fable: 'yes', usage: usage({ ...withOi, uoi: 0.9 }) }),
    view('garden', 'oauth', { fable: 'no', usage: usage({ u5: 0.75, u7: 0.95 }) }),
    view('walled', 'oauth', {
      fable: 'yes',
      usage: usage({
        u5: 1,
        s5: 'rejected',
        r5: S + 40 * MIN,
        ...withOi,
        uoi: 0.97,
        soi: 'rejected'
      })
    }),
    view('soon', 'oauth', { usage: usage({ u5: 1, s5: 'rejected', r5: S + 10 * MIN }) }),
    view('due', 'oauth', { usage: usage({ u7: 1, s7: 'rejected', r7: S - MIN }) }),
    view('stuck', 'oauth', { usage: usage({ u7: 1, s7: 'rejected', r7: 0 }) }),
    view('ultra', 'oauth', {
      fable: 'yes',
      usage: usage({ has5h: false, u5: 0, r5: 0, ...withOi, roi: 0 })
    }),
    view('stale', 'oauth', { usage: usage({ at: NOW - 20 * MIN * 1000 }) }),
    view('aging', 'oauth', { usage: usage({ at: NOW - 5 * MIN * 1000 }) }),
    view('offline', 'oauth', { probeError: 'network' }),
    view('new', 'oauth'),
    view('lapsed', 'oauth', { status: 'expired', usage: usage({ at: NOW - HOUR * 1000 }) }),
    view('gone', 'oauth', { status: 'expired', probeError: 'expired' }),
    view('pending', 'oauth', { status: 'unverified' }),
    view('flaky', 'oauth', { usage: usage({}), probeError: 'model-unavailable' }),
    view('resting', 'oauth', { enabled: false, usage: usage({}) }),
    view('metered', 'apikey'),
    view('unchecked', 'apikey', { status: 'unverified' }),
    view('gateway', 'custom', { baseUrl: 'https://llm.example.invalid/a', model: 'house' }),
    view('plain', 'custom', { baseUrl: 'https://llm.example.invalid/b' })
  ],
  claudeFallback: [
    view('walled', 'oauth', {
      usage: usage({ u5: 1, s5: 'rejected', r5: S + 3 * HOUR, u7: 0.97, r7: S + 2 * DAY })
    }),
    view('metered', 'apikey')
  ],
  claudeTopModelSpentEverywhere: [
    view('a', 'oauth', { usage: usage({ ...withOi, uoi: 1, soi: 'rejected', u5: 0.1, u7: 0.2 }) }),
    view('b', 'oauth', { usage: usage({ ...withOi, uoi: 0.98, roi: 0, u5: 0.2, u7: 0.1 }) })
  ],
  claudeNoneMeasured: [view('a', 'oauth'), view('b', 'oauth', { status: 'expired' })],
  claudeOneMeasured: [view('a', 'oauth', { usage: usage({}) }), view('b', 'oauth')],
  claudeAllWalled: [
    view('a', 'oauth', { usage: usage({ u5: 1, s5: 'rejected', r5: S + 2 * HOUR }) }),
    view('b', 'oauth', { usage: usage({ u7: 1, s7: 'rejected', r7: S + DAY }) })
  ]
}

function limits(l: Partial<CodexLimits>): CodexLimits {
  return {
    windows: [
      { minutes: 300, used: 0.25, resetsAt: S + 4 * HOUR + 30 * MIN },
      { minutes: 10080, used: 0.61, resetsAt: S + 3 * DAY + HOUR }
    ],
    at: NOW,
    ...l
  }
}

const cappedWindows = [
  { minutes: 300, used: 1, resetsAt: S + 40 * MIN },
  { minutes: 10080, used: 0.92, resetsAt: S + 2 * DAY }
]

export const CODEX_SETS: Record<string, AccountView[]> = {
  codexOne: [
    view('plus', 'codex-home', { limits: limits({ credits: { unlimited: false, balance: 1250 } }) })
  ],
  codexEveryState: [
    view('plus', 'codex-home', { limits: limits({ credits: { unlimited: true } }) }),
    view('capped', 'codex-home', {
      limits: limits({
        windows: cappedWindows,
        resets: { available: 2, firstExpiresAt: S + DAY }
      })
    }),
    view('single', 'codex-home', {
      limits: limits({
        windows: cappedWindows,
        reached: true,
        resets: { available: 1, firstExpiresAt: S + 3 * HOUR }
      })
    }),
    view('spent', 'codex-home', {
      limits: limits({ windows: cappedWindows, resets: { available: 0 } })
    }),
    view('weekly', 'codex-home', {
      limits: limits({ windows: [{ minutes: 10080, used: 0.4, resetsAt: 0 }] })
    }),
    view('blank', 'codex-home', { limits: limits({ windows: [] }) }),
    view('stale', 'codex-home', { limits: limits({ at: NOW - 30 * MIN * 1000 }) }),
    view('flaky', 'codex-home', { limits: limits({}), probeError: 'network' }),
    view('offline', 'codex-home', { probeError: 'network' }),
    view('new', 'codex-home'),
    view('signed-out', 'codex-home', { status: 'expired' }),
    view('pending', 'codex-home', { status: 'unverified', limits: limits({}) }),
    view('paused', 'codex-home', { enabled: false }),
    view('byok', 'codex-home', { apiKey: true }),
    view('badkey', 'codex-home', { apiKey: true, probeError: 'expired' })
  ],
  codexKeyWithOldWindowsBesideAnUnreadSignIn: [
    view('new', 'codex-home'),
    view('oldkey', 'codex-home', {
      apiKey: true,
      probeError: 'network',
      limits: limits({ credits: { unlimited: false, balance: 40 } })
    })
  ],
  codexAllWalled: [
    view('a', 'codex-home', { limits: limits({ windows: cappedWindows }) }),
    view('b', 'codex-home', {
      limits: limits({ windows: [{ minutes: 300, used: 1, resetsAt: S + HOUR }] })
    })
  ]
}

const buckets: QuotaBucket[] = [
  { label: 'Gemini Models · 7d', used: 0.42, resetsAt: S + 4 * DAY, minutes: 10080 },
  { label: 'Gemini Models · 5h', used: 0.1, resetsAt: S + 3 * HOUR, minutes: 300 }
]

export const AGY_SETS: Record<string, AccountView[]> = {
  agyOne: [view('google', 'agy-home', { quota: buckets, quotaAt: NOW })],
  agyEveryState: [
    view('google', 'agy-home', { quota: buckets, quotaAt: NOW - HOUR * 1000 }),
    view('drained', 'agy-home', {
      quota: [{ ...buckets[0], used: 1 }, buckets[1]],
      quotaAt: NOW
    }),
    view('undated', 'agy-home', { quota: [{ label: 'Gemini Models · 7d', used: 0.2 }] }),
    view('empty', 'agy-home', { quota: [], quotaAt: NOW }),
    view('flaky', 'agy-home', { quota: buckets, quotaAt: NOW, probeError: 'network' }),
    view('offline', 'agy-home', { probeError: 'network' }),
    view('new', 'agy-home'),
    view('logged-off', 'agy-home', { status: 'expired' }),
    view('stale-off', 'agy-home', { status: 'expired', quota: buckets, quotaAt: NOW }),
    view('paused', 'agy-home', { enabled: false, quota: buckets }),
    view('gemini-key', 'agy-home', { apiKey: true }),
    view('badkey', 'agy-home', { apiKey: true, probeError: 'expired' })
  ],
  agyKeyOnly: [view('gemini-key', 'agy-home', { apiKey: true })]
}

export const ACCOUNT_SETS: Record<string, AccountView[]> = {
  ...CLAUDE_SETS,
  ...CODEX_SETS,
  ...AGY_SETS,
  everyAgent: [
    ...CLAUDE_SETS.claudeEveryState,
    ...CODEX_SETS.codexEveryState,
    ...AGY_SETS.agyEveryState
  ],
  codexAndAgyOnly: [...CODEX_SETS.codexEveryState, ...AGY_SETS.agyOne],
  agyAndKeyOnly: [...AGY_SETS.agyKeyOnly, ...CODEX_SETS.codexOne]
}

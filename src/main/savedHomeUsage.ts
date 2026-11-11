import type { AccountMeta, AccountView, CodexLimits, QuotaBucket } from '@shared/types'

export interface HomeUsage {
  limits?: CodexLimits
  quota?: QuotaBucket[]
  at: number
}

export interface HomeUsageStore {
  get(key: string): HomeUsage | undefined
  set(key: string, usage: HomeUsage): void
  delete(key: string): void
}

type ProbedView = Omit<AccountView, keyof AccountMeta>

function keyOf(a: Pick<AccountMeta, 'name' | 'kind'>): string {
  return `${a.kind}:${a.name.toLowerCase()}`
}

export function saveHomeUsage(
  store: HomeUsageStore,
  account: Pick<AccountMeta, 'name' | 'kind'>,
  probed: ProbedView | undefined,
  nowMs: number
): void {
  const key = keyOf(account)
  if (probed?.apiKey) store.delete(key)
  else if (!probed || probed.probeError) return
  else if (probed.limits) {
    if (store.get(key)?.at !== probed.limits.at)
      store.set(key, { limits: probed.limits, at: probed.limits.at })
  } else if (probed.quota?.length) store.set(key, { quota: probed.quota, at: nowMs })
}

export function withSavedHomeUsage(views: AccountView[], store: HomeUsageStore): AccountView[] {
  return views.map((a) => {
    if (a.limits || a.quota || a.apiKey) return a
    const saved = store.get(keyOf(a))
    if (!saved) return a
    return {
      ...a,
      ...(saved.limits && { limits: saved.limits }),
      ...(saved.quota && { quota: saved.quota })
    }
  })
}

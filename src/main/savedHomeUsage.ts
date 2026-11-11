import type { AccountMeta, AccountView } from '@shared/types'
import type { SavedUsage } from './savedUsage'

export type HomeUsage = Pick<AccountView, 'limits' | 'quota'> & { at: number }

export type SavedHomeUsageOf = (a: AccountView) => HomeUsage | undefined

export function saveHomeUsage(
  store: SavedUsage<HomeUsage>,
  key: string,
  probed: Omit<AccountView, keyof AccountMeta> | undefined,
  nowMs: number
): void {
  if (probed?.apiKey) return store.delete(key)
  if (!probed || probed.probeError) return
  if (probed.limits) store.set(key, { limits: probed.limits, at: probed.limits.at })
  else if (probed.quota?.length) store.set(key, { quota: probed.quota, at: nowMs })
}

export function withSavedHomeUsage(
  accounts: AccountView[],
  savedOf: SavedHomeUsageOf
): AccountView[] {
  return accounts.map((a) => {
    if (a.limits || a.quota?.length || a.apiKey) return a
    const saved = savedOf(a)
    return saved ? { ...a, limits: saved.limits, quota: saved.quota } : a
  })
}

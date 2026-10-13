import type { AccountStatus, GitAccount } from '@shared/types'

export const GIT_ACCOUNT_CHECK_EVERY_MS = 6 * 3_600_000
const FIRST_CHECK_AFTER_MS = 3_000
const SAME_ACCOUNT_CHECK_GAP_MS = 60_000

export type AccountHealth = 'ok' | 'expired' | 'offline' | 'unknown'

export interface GitAccountChecksDeps {
  accounts(): GitAccount[]
  health(a: GitAccount): Promise<AccountHealth>
  setStatus(id: string, s: AccountStatus): void
  setOffline(id: string, offline: boolean): void
}

export class GitAccountChecks {
  private lastStarted = new Map<string, number>()
  private running = new Map<string, Promise<void>>()

  constructor(private d: GitAccountChecksDeps) {}

  start(): void {
    setTimeout(() => void this.checkAll(), FIRST_CHECK_AFTER_MS).unref?.()
    setInterval(() => void this.checkAll(), GIT_ACCOUNT_CHECK_EVERY_MS).unref?.()
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.d.accounts().map((a) => this.checkOne(a.id)))
  }

  checkOne(id: string): Promise<void> {
    const pending = this.running.get(id)
    if (pending) return pending
    const last = this.lastStarted.get(id)
    if (last !== undefined && Date.now() - last < SAME_ACCOUNT_CHECK_GAP_MS)
      return Promise.resolve()
    this.lastStarted.set(id, Date.now())
    const run = this.check(id).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async check(id: string): Promise<void> {
    const a = this.d.accounts().find((x) => x.id === id)
    if (!a) return
    const h = await this.d.health(a)
    if (h === 'unknown') return
    this.d.setOffline(id, h === 'offline')
    if (h !== 'offline') this.setStatus(id, h)
  }

  private setStatus(id: string, s: AccountStatus): void {
    const now = this.d.accounts().find((a) => a.id === id)
    if (now && now.status !== s) this.d.setStatus(id, s)
  }
}

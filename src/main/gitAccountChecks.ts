import type { AccountStatus, GitAccount } from '@shared/types'
import type { whoami } from './githubApi'

export const GIT_ACCOUNT_CHECK_EVERY_MS = 6 * 3_600_000
const FIRST_CHECK_AFTER_MS = 3_000
const SAME_ACCOUNT_CHECK_GAP_MS = 60_000

export interface GitAccountChecksDeps {
  accounts(): GitAccount[]
  token(login: string): Promise<string | null>
  whoami: typeof whoami
  setStatus(login: string, s: AccountStatus): void
  setOffline(login: string, offline: boolean): void
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
    await Promise.all(this.d.accounts().map((a) => this.checkOne(a.login)))
  }

  checkOne(login: string): Promise<void> {
    const pending = this.running.get(login)
    if (pending) return pending
    const last = this.lastStarted.get(login)
    if (last !== undefined && Date.now() - last < SAME_ACCOUNT_CHECK_GAP_MS)
      return Promise.resolve()
    this.lastStarted.set(login, Date.now())
    const run = this.check(login).finally(() => this.running.delete(login))
    this.running.set(login, run)
    return run
  }

  private async check(login: string): Promise<void> {
    const token = await this.d.token(login)
    if (!token) return
    const r = await this.d.whoami(token)
    if (r.ok) {
      this.d.setOffline(login, false)
      this.setStatus(login, 'ok')
    } else if (r.error === 'expired') {
      this.d.setOffline(login, false)
      this.setStatus(login, 'expired')
    } else if (r.error === 'offline') this.d.setOffline(login, true)
  }

  private setStatus(login: string, s: AccountStatus): void {
    const now = this.d.accounts().find((a) => a.login === login)
    if (now && now.status !== s) this.d.setStatus(login, s)
  }
}

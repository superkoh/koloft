import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AccountStatus, GitAccount } from '@shared/types'
import type { WhoAmI } from '../../src/main/githubApi'
import { GIT_ACCOUNT_CHECK_EVERY_MS, GitAccountChecks } from '../../src/main/gitAccountChecks'

const FIRST_CHECK_AFTER_MS = 3_000
const SAME_ACCOUNT_CHECK_GAP_MS = 60_000

const account = (login: string, status: AccountStatus = 'ok'): GitAccount => ({
  host: 'github.com',
  login,
  id: 1,
  name: login,
  default: false,
  status,
  addedAt: 0
})

describe('GitAccountChecks', () => {
  let accounts: GitAccount[]
  let answers: Record<string, WhoAmI>
  let asked: string[]
  let statuses: [string, AccountStatus][]
  let offline: [string, boolean][]
  let checks: GitAccountChecks

  beforeEach(() => {
    vi.useFakeTimers()
    accounts = [account('bob'), account('alice')]
    answers = {
      'tok-bob': { ok: true, login: 'bob', id: 1, name: 'bob', scopes: [] },
      'tok-alice': { ok: true, login: 'alice', id: 2, name: 'alice', scopes: [] }
    }
    asked = []
    statuses = []
    offline = []
    checks = new GitAccountChecks({
      accounts: () => accounts,
      token: async (login) => `tok-${login}`,
      whoami: async (token) => {
        asked.push(token)
        return answers[token]
      },
      setStatus: (login, s) => {
        statuses.push([login, s])
        accounts = accounts.map((a) => (a.login === login ? { ...a, status: s } : a))
      },
      setOffline: (login, o) => offline.push([login, o])
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('one 401 marks the account expired; offline leaves the status alone and only flags it offline', async () => {
    answers['tok-bob'] = { ok: false, error: 'expired' }
    answers['tok-alice'] = { ok: false, error: 'offline' }
    await checks.checkAll()
    expect(statuses).toEqual([['bob', 'expired']])
    expect(offline).toContainEqual(['alice', true])
  })

  it('an expired account that answers again goes back to ok', async () => {
    accounts = [account('bob', 'expired')]
    await checks.checkOne('bob')
    expect(statuses).toEqual([['bob', 'ok']])
  })

  it('checks 3 s after start and again every 6 h', async () => {
    checks.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_AFTER_MS - 1)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked.sort()).toEqual(['tok-alice', 'tok-bob'])
    await vi.advanceTimersByTimeAsync(GIT_ACCOUNT_CHECK_EVERY_MS)
    expect(asked.length).toBe(4)
  })

  it('asks GitHub about one account at most once a minute', async () => {
    await checks.checkOne('bob')
    await checks.checkOne('bob')
    expect(asked).toEqual(['tok-bob'])
    await vi.advanceTimersByTimeAsync(SAME_ACCOUNT_CHECK_GAP_MS)
    await checks.checkOne('bob')
    expect(asked).toEqual(['tok-bob', 'tok-bob'])
  })
})

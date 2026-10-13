import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AccountStatus, GitAccount } from '@shared/types'
import {
  GIT_ACCOUNT_CHECK_EVERY_MS,
  GitAccountChecks,
  type AccountHealth
} from '../../src/main/gitAccountChecks'

const FIRST_CHECK_AFTER_MS = 3_000
const SAME_ACCOUNT_CHECK_GAP_MS = 60_000

const account = (login: string, status: AccountStatus = 'ok'): GitAccount => ({
  id: `github.com/${login}`,
  platform: 'github',
  url: 'https://github.com',
  host: 'github.com',
  login,
  default: false,
  status,
  addedAt: 0
})

describe('GitAccountChecks', () => {
  let accounts: GitAccount[]
  let answers: Record<string, AccountHealth>
  let asked: string[]
  let statuses: [string, AccountStatus][]
  let offline: [string, boolean][]
  let checks: GitAccountChecks

  beforeEach(() => {
    vi.useFakeTimers()
    accounts = [account('bob'), account('alice')]
    answers = { 'github.com/bob': 'ok', 'github.com/alice': 'ok' }
    asked = []
    statuses = []
    offline = []
    checks = new GitAccountChecks({
      accounts: () => accounts,
      health: async (a) => {
        asked.push(a.id)
        return answers[a.id]
      },
      setStatus: (id, s) => {
        statuses.push([id, s])
        accounts = accounts.map((a) => (a.id === id ? { ...a, status: s } : a))
      },
      setOffline: (id, o) => offline.push([id, o])
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('one 401 marks the account expired; offline leaves the status alone and only flags it offline', async () => {
    answers['github.com/bob'] = 'expired'
    answers['github.com/alice'] = 'offline'
    await checks.checkAll()
    expect(statuses).toEqual([['github.com/bob', 'expired']])
    expect(offline).toContainEqual(['github.com/alice', true])
  })

  it('an expired account that answers again goes back to ok', async () => {
    accounts = [account('bob', 'expired')]
    await checks.checkOne('github.com/bob')
    expect(statuses).toEqual([['github.com/bob', 'ok']])
  })

  it('an account whose health cannot be told changes nothing', async () => {
    answers['github.com/bob'] = 'unknown'
    await checks.checkOne('github.com/bob')
    expect(statuses).toEqual([])
    expect(offline).toEqual([])
  })

  it('checks 3 s after start and again every 6 h', async () => {
    checks.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_AFTER_MS - 1)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked.sort()).toEqual(['github.com/alice', 'github.com/bob'])
    await vi.advanceTimersByTimeAsync(GIT_ACCOUNT_CHECK_EVERY_MS)
    expect(asked.length).toBe(4)
  })

  it('asks about one account at most once a minute', async () => {
    await checks.checkOne('github.com/bob')
    await checks.checkOne('github.com/bob')
    expect(asked).toEqual(['github.com/bob'])
    await vi.advanceTimersByTimeAsync(SAME_ACCOUNT_CHECK_GAP_MS)
    await checks.checkOne('github.com/bob')
    expect(asked).toEqual(['github.com/bob', 'github.com/bob'])
  })
})

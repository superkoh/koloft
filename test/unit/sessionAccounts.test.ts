import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { SESSIONS_REMEMBERED, SessionAccounts } from '../../src/main/sessionAccounts'

const fileIn = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'session-accounts-')), 'session-accounts.json')

describe('SessionAccounts', () => {
  it('remembers which account each Claude and Codex session ran on across a restart, the picked one first', () => {
    const file = fileIn()
    const before = new SessionAccounts(file)
    before.note([
      { backendId: 'claude', sessionId: 's1', account: 'reported', pickedAccount: 'picked' },
      { backendId: 'claude', sessionId: 's2', account: 'reported' },
      { backendId: 'codex', sessionId: 's1', pickedAccount: 'home' },
      { backendId: 'claude', sessionId: '', pickedAccount: 'nobody' },
      { backendId: 'claude', sessionId: 's3' }
    ])
    before.flushSync()
    const after = new SessionAccounts(file)
    expect(after.of('claude', 's1')).toBe('picked')
    expect(after.of('claude', 's2')).toBe('reported')
    expect(after.of('codex', 's1')).toBe('home')
    expect(after.of('claude', 's3')).toBeUndefined()
    expect(after.of('claude', undefined)).toBeUndefined()
  })

  it('keeps only the most recently noted sessions', () => {
    const file = fileIn()
    const accounts = new SessionAccounts(file)
    accounts.note([{ backendId: 'claude', sessionId: 'oldest', pickedAccount: 'a' }])
    accounts.note([{ backendId: 'claude', sessionId: 'kept', pickedAccount: 'a' }])
    accounts.note(
      Array.from({ length: SESSIONS_REMEMBERED - 1 }, (_, i) => ({
        backendId: 'claude' as const,
        sessionId: `s${i}`,
        pickedAccount: 'a'
      }))
    )
    accounts.note([{ backendId: 'claude', sessionId: 'kept', pickedAccount: 'b' }])
    expect(accounts.of('claude', 'oldest')).toBeUndefined()
    expect(accounts.of('claude', 'kept')).toBe('b')
    expect(accounts.of('claude', 's0')).toBe('a')
  })
})
